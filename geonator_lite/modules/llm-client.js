/**
 * LLM Client (geonator_lite) — the only module allowed to call Claude API.
 * Handles L1 (query parsing), the unified L2 (category+name relevance), and the
 * optional coordinate-cluster dedup pass. Max 3 LLM calls per search (spec §3).
 *
 * Forked from geonator/modules/llm-client.js. `_callClaude` is kept essentially
 * as-is (prompt caching / timeout / model-support logic). Everything else tied to
 * removed features (L0 conversation layer, L1-3 world-knowledge suggestions, L3
 * landmark suggestions, refine-loop delta parsing) has been deleted — see
 * IMPLEMENTATION_SPEC.md §9 for the deletion list.
 *
 * Single `config.MODEL` field is used for every call (spec §7.2) — no per-role
 * model selection.
 */

class LLMClient {
  constructor(config) {
    this.config = config;
    this.resetStats();
  }

  /** Reset per-run stats (tokens, calls) keyed by role. */
  resetStats() {
    this.stats = {
      L1: { model: this.config.MODEL, inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, calls: 0 },
      L2: { model: this.config.MODEL, inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, calls: 0 },
    };
  }

  // ─────────────────────────────────────────────
  // L1: Natural language → QuerySchema (short-key JSON, spec §4)
  // ─────────────────────────────────────────────

  /**
   * Parse user text into a raw (short-key) QuerySchema JSON. Caller is responsible
   * for expandShortKeys() + fillSchemaDefaults() (query-schema.js) afterwards.
   * @param {string} userText
   * @returns {Promise<object>} raw L1 JSON (short keys; `tgt` omitted when nothing to search on)
   */
  async parseQuery(userText) {
    const MAX_TOK = this.config.L1_MAX_TOKENS || 3000;
    let lastDetail = '';
    for (let attempt = 0; attempt <= (this.config.L1_MAX_RETRY ?? 1); attempt++) {
      try {
        const { text, stop_reason } = await this._callClaude(
          this._buildL1Prompt(userText),
          MAX_TOK,
          this.config.MODEL,
          'L1',
          { returnMeta: true, cacheSystem: true, timeoutMs: Math.max(this.config.API_TIMEOUT_MS, this.config.L1_TIMEOUT_MS || 20000) }
        );
        const json = this._extractJSON(text);
        if (json) return json;
        const truncated = stop_reason === 'max_tokens';
        const tail = (text || '').slice(-160).replace(/\s+/g, ' ');
        lastDetail = truncated
          ? `L1 response truncated (stop_reason=max_tokens, max_tokens=${MAX_TOK}). tail="…${tail}"`
          : `L1 returned unparseable JSON (stop_reason=${stop_reason}). tail="…${tail}"`;
        if (truncated) break; // deterministic (temp=0) → retry would truncate identically
      } catch (e) {
        lastDetail = e?.message || String(e);
      }
    }
    throw new Error(lastDetail || 'L1: failed to produce valid JSON after retries');
  }

  // ─────────────────────────────────────────────
  // L2 (unified): category validity + name relevance in one call (spec §6.1)
  // ─────────────────────────────────────────────

  /**
   * Rate candidates against the intent — category-domain mismatch AND name-based
   * relevance judged in a single pass. Returns { definitely:Set, probably:Set, no:Set }
   * of ids. Unlisted ids = 'unknown' (kept, low score). null on parse failure (caller
   * keeps all candidates as 'unknown').
   * @param {string} intentLabel - human-readable description of what is being searched
   * @param {Array<{id:number|string, name:string, poi_category?:string[], class?:string}>} candidates
   * @param {boolean} nameOnly - true for building targets (mansion/apartment/building):
   *   category is uninformative there, so use the name-relevance-only prompt.
   */
  async rateCandidates(intentLabel, candidates, nameOnly = false) {
    if (!candidates || candidates.length === 0) return { definitely: new Set(), probably: new Set(), no: new Set() };

    const result = await this._callClaude(
      this._buildL2Prompt(intentLabel, candidates, nameOnly),
      1024,
      this.config.MODEL,
      'L2',
      { cacheSystem: true }
    );
    try {
      const json = this._extractJSON(result);
      if (!json) return null;
      return {
        definitely: new Set((json.definitely || []).map(String)),
        probably:   new Set((json.probably   || []).map(String)),
        no:         new Set((json.no         || []).map(String)),
      };
    } catch {
      return null; // parse failure → caller keeps all as 'unknown'
    }
  }

  // ─────────────────────────────────────────────
  // Internal
  // ─────────────────────────────────────────────

  /**
   * temperature を受け付けるモデルか（allowlist）。4.6世代以前（sonnet-4-6 / opus-4-6 /
   * haiku-4-5系 / claude-3系）のみ true。Sonnet 5 等はtemperatureを廃止しており送ると400。
   */
  _supportsTemperature(model) {
    return /sonnet-4-6|opus-4-6|haiku-4-5|claude-3/.test(String(model || ''));
  }

  /** モデル別のタイムアウト下限(ms)。4.6/Haiku 系は速いので下限なし(0)。 */
  _minTimeoutMs(model) {
    const m = String(model || '');
    if (this._supportsTemperature(m)) return 0;
    return this.config.SLOW_MODEL_TIMEOUT_MS || 20000;
  }

  async _callClaude(prompt, maxTokens = 400, model = null, role = null, opts = {}) {
    const controller = new AbortController();
    const useModel = model || this.config.MODEL;
    const timeoutMs = Math.max(opts.timeoutMs || this.config.API_TIMEOUT_MS, this._minTimeoutMs(useModel));
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

    const systemField = (opts.cacheSystem && typeof prompt.system === 'string')
      ? [{ type: 'text', text: prompt.system, cache_control: { type: 'ephemeral' } }]
      : prompt.system;

    try {
      const reqBody = {
        model:      useModel,
        max_tokens: maxTokens,
        system: systemField,
        messages: Array.isArray(prompt.messages) ? prompt.messages : [{ role: 'user', content: prompt.user }],
      };
      if (this._supportsTemperature(useModel)) reqBody.temperature = 0;
      const directKey = this.config.ANTHROPIC_DIRECT_API_KEY;
      const url = directKey ? 'https://api.anthropic.com/v1/messages' : this.config.CLAUDE_API_PROXY;
      const headers = directKey
        ? {
            'Content-Type': 'application/json',
            'x-api-key': directKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          }
        : { 'Content-Type': 'application/json' };
      const resp = await fetch(url, {
        method:  'POST',
        headers,
        signal:  controller.signal,
        body: JSON.stringify(reqBody),
      });
      if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
      const data = await resp.json();
      const s = role && this.stats?.[role];
      if (s) {
        s.model = useModel;
        s.inTok      += data?.usage?.input_tokens         || 0;
        s.outTok     += data?.usage?.output_tokens        || 0;
        s.cacheRead  += data?.usage?.cache_read_input_tokens     || 0;
        s.cacheWrite += data?.usage?.cache_creation_input_tokens || 0;
        s.calls      += 1;
      }
      const text = Array.isArray(data?.content)
        ? data.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('')
        : (data?.content?.[0]?.text ?? '');
      if (opts.returnMeta) return { text, stop_reason: data?.stop_reason ?? null, usage: data?.usage ?? null };
      return text;
    } catch (e) {
      if (timedOut || e?.name === 'AbortError') {
        throw new Error(`LLM timeout after ${timeoutMs}ms (model=${useModel}, max_tokens=${maxTokens})`);
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }

  _extractJSON(text) {
    const match = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
    if (!match) return null;
    return JSON.parse(match[1].trim());
  }

  _buildL1Prompt(userText) {
    if (typeof PROMPT_L1 === 'undefined') throw new Error('PROMPT_L1 not loaded');
    // category_tag判定用のtaxonomyは呼び出し時にここで結合する（結合後の全文が1つの
    // cache_control対象になる＝taxonomyも含めてキャッシュされる）。
    const taxonomyBlock = (this.config.useCategorySearch && typeof CATEGORY_TAXONOMY !== 'undefined')
      ? `\n\n## POI Category Taxonomy（category_tag出力用・canonical_id一覧）\n${JSON.stringify(CATEGORY_TAXONOMY)}`
      : '';
    return {
      system: PROMPT_L1 + taxonomyBlock,
      user:   `ユーザー入力：「${userText}」\n\n短縮キースキーマ(JSON)のみを返してください。`,
    };
  }

  _buildL2Prompt(intentLabel, candidates, nameOnly = false) {
    if (typeof PROMPT_L2 === 'undefined') throw new Error('PROMPT_L2 not loaded');
    if (nameOnly) {
      if (typeof PROMPT_L2_BUILDING === 'undefined') throw new Error('PROMPT_L2_BUILDING not loaded');
      const list = candidates.map(c => JSON.stringify({ id: c.id, name: c.name ?? '' })).join('\n');
      return {
        system: PROMPT_L2_BUILDING,
        user:   `探しているもの（意図）：${intentLabel}\n\n候補:\n${list}\n\n各候補が「意図そのもの（意図のインスタンス）か」を名前だけから判定し、{"definitely":[...],"probably":[...],"no":[...]} 形式でIDを返してください。unknown（判断つかない）は記載不要＝未記載はunknown扱い。JSONのみ。`,
      };
    }
    const list = candidates.map(c => JSON.stringify({
      id: c.id, name: c.name ?? '', poi_category: c.poi_category ?? null, class: c.class ?? c.cls ?? null,
    })).join('\n');
    return {
      system: PROMPT_L2,
      user:   `探しているもの（意図）：${intentLabel}\n\n候補:\n${list}\n\n各候補が「意図そのもの（意図のインスタンス）か」を、カテゴリと名前の両方から判定し、{"definitely":[...],"probably":[...],"no":[...]} 形式でIDを返してください。unknown（判断つかない）は記載不要＝未記載はunknown扱い。JSONのみ。`,
    };
  }
}
