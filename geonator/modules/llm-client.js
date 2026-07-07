/**
 * LLM Client — the only module allowed to call Claude API.
 * Handles L1 (query parsing) and L2 (candidate negative filter).
 * Reference: systemdesign_20260704.md §2-1, implementation_instructions §5, §6
 */

class LLMClient {
  constructor(config) {
    this.config = config;
    this.resetStats();
  }

  /** Reset per-run stats (tokens, time, calls) keyed by role. */
  resetStats() {
    this.stats = {
      L1:   { model: this.config.L1_MODEL,   inTok: 0, outTok: 0, ms: 0, calls: 0 },
      L2_1: { model: this.config.L2_1_MODEL, inTok: 0, outTok: 0, ms: 0, calls: 0 },
      L2_2: { model: this.config.L2_2_MODEL, inTok: 0, outTok: 0, ms: 0, calls: 0 },
      L3:   { model: this.config.L3_MODEL,   inTok: 0, outTok: 0, ms: 0, calls: 0 },
    };
  }

  /**
   * L3: suggest differentiating landmarks for narrowing. Given the remaining candidates
   * and each one's nearby poi_label names, pick 2-4 recognizable landmarks that are near
   * only SOME candidates, phrased as short conditions. Returns string[] (empty on none).
   * @param {Array<{name:string, nearby:string[]}>} candList
   * @param {string} lang
   */
  async suggestLandmarks(candList, lang = 'ja') {
    if (typeof PROMPT_L3 === 'undefined') throw new Error('PROMPT_L3 not loaded');
    if (!candList || candList.length < 2) return [];
    const langNote = lang === 'en' ? ' Write the suggestions in English (keep Japanese place names as-is).' : '';
    try {
      const result = await this._callClaude(
        {
          system: PROMPT_L3,
          user:   `候補と近傍ランドマーク:\n${JSON.stringify(candList)}\n\n候補を区別できる目印を2〜4個。${langNote}JSONのみ返してください。`,
        },
        512,
        this.config.L3_MODEL,
        'L3'
      );
      const json = this._extractJSON(result);
      const arr = json && Array.isArray(json.suggestions) ? json.suggestions : [];
      return arr.filter(s => typeof s === 'string' && s.trim()).slice(0, 4);
    } catch {
      return [];
    }
  }

  // ─────────────────────────────────────────────
  // L1: Natural language → QuerySchema
  // ─────────────────────────────────────────────

  /**
   * Parse user text into QuerySchema JSON.
   * If previousText provided, re-parse (previousText + newText) from scratch (K).
   * @param {string} userText
   * @param {string|null} previousText - full previous query text for re-parse
   * @returns {Promise<object>} raw QuerySchema (before validation/filling)
   */
  async parseQuery(userText, previousText = null, lang = 'ja') {
    const fullText = previousText ? `${previousText}\n追加情報：${userText}` : userText;

    for (let attempt = 0; attempt <= this.config.L1_MAX_RETRY; attempt++) {
      try {
        const result = await this._callClaude(
          this._buildL1Prompt(fullText, lang),
          1500,  // QuerySchema with QE queries[] + multiple conditions can be long
          this.config.L1_MODEL,
          'L1'
        );
        const json = this._extractJSON(result);
        if (json) return json;
      } catch (e) {
        if (attempt === this.config.L1_MAX_RETRY) throw e;
      }
    }
    throw new Error('L1: failed to produce valid JSON after retries');
  }

  /**
   * Parse a refinement hint as a DELTA against the current understanding (never a
   * full rebuild-from-text, so existing conditions are never lost). Returns the
   * conditions to add/remove and any target/proximity change, plus a confirmation.
   * @param {object} schema - current QuerySchema
   * @param {string} hintText - user's refinement text
   * @returns {Promise<{add_conditions:Array, remove_condition_texts:string[], new_target:object|null, new_proximity:object|null, confirmation:string}|null>}
   */
  async parseRefinement(schema, hintText, lang = 'ja') {
    if (typeof PROMPT_L1_REFINE === 'undefined') throw new Error('PROMPT_L1_REFINE not loaded');
    const summary = {
      target:     schema?.target?.text ?? null,
      proximity:  (schema?.proximity?.anchors || []).map(a => a.text),
      conditions: (schema?.conditions || []).map(c => c.text ?? c.type),
    };
    const langNote = lang === 'en' ? ' confirmation は英語で（条件のtext等は日本語のまま）。' : '';
    try {
      const result = await this._callClaude(
        {
          system: PROMPT_L1_REFINE,
          user:   `現在の理解:\n${JSON.stringify(summary)}\n\n追加情報:「${hintText}」\n\n${langNote}差分JSONのみを返してください。`,
        },
        900,
        this.config.L1_MODEL,
        'L1'
      );
      const json = this._extractJSON(result);
      if (!json) return null;
      return {
        add_conditions:        Array.isArray(json.add_conditions) ? json.add_conditions : [],
        remove_condition_texts: Array.isArray(json.remove_condition_texts) ? json.remove_condition_texts.map(String) : [],
        new_target:            (json.new_target && typeof json.new_target === 'object') ? json.new_target : null,
        new_proximity:         (json.new_proximity && Array.isArray(json.new_proximity.anchors) && json.new_proximity.anchors.length) ? json.new_proximity : null,
        confirmation:          typeof json.confirmation === 'string' ? json.confirmation : '',
      };
    } catch {
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // L2-1: category validity check (通常クエリ) — see poi_category/class, not names
  // ─────────────────────────────────────────────

  /**
   * For each group, decide which poi_category / class values are CLEARLY NOT the
   * intent (to remove). Conservative: only clearly-wrong categories are removed;
   * ambiguous/parent/missing categories are kept. Names are NOT sent — only the
   * intent text + deduped category vocabularies.
   * @param {Array<{key:string, intent:string, poi_category:string[], class:string[]}>} groups
   * @returns {Promise<Object|null>} { [key]: { remove_poi_category:Set, remove_class:Set } } or null on failure
   */
  async filterCategories(groups) {
    if (!groups || groups.length === 0) return {};

    const result = await this._callClaude(
      this._buildL2_1Prompt(groups),
      512,
      this.config.L2_1_MODEL,
      'L2_1'
    );
    try {
      const json = this._extractJSON(result);
      if (!json) return null;
      const out = {};
      for (const g of groups) {
        const r = json[g.key] || {};
        out[g.key] = {
          remove_poi_category: new Set((r.remove_poi_category || []).map(String)),
          remove_class:        new Set((r.remove_class        || []).map(String)),
        };
      }
      return out;
    } catch {
      return null; // parse failure → caller keeps all (no filtering)
    }
  }

  // ─────────────────────────────────────────────
  // L2-2: target relevance check on candidates (name-based, 4-level)
  // ─────────────────────────────────────────────

  /**
   * Rate candidates against the intent (4-level). Returns
   * { definitely:Set, probably:Set, no:Set } of ids. Unlisted ids = 'unknown'
   * (kept, low). null on parse failure (caller keeps all as 'unknown').
   * @param {string} intentLabel - human-readable description of what is being searched
   * @param {Array<{id: number|string, name: string}>} candidates
   */
  async rateCandidates(intentLabel, candidates) {
    if (!candidates || candidates.length === 0) return { definitely: new Set(), probably: new Set(), no: new Set() };

    const result = await this._callClaude(
      this._buildL2_2Prompt(intentLabel, candidates),
      1024,
      this.config.L2_2_MODEL,
      'L2_2'
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

  async _callClaude(prompt, maxTokens = 400, model = null, role = null) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.API_TIMEOUT_MS);
    const useModel = model || this.config.CLAUDE_MODEL;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    try {
      const resp = await fetch(this.config.CLAUDE_API_PROXY, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        signal:  controller.signal,
        body: JSON.stringify({
          model:      useModel,
          max_tokens: maxTokens,
          temperature: 0,
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.user }],
        }),
      });
      if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
      const data = await resp.json();
      // Accumulate stats by role
      const s = role && this.stats?.[role];
      if (s) {
        s.model = useModel;
        s.inTok  += data?.usage?.input_tokens  || 0;
        s.outTok += data?.usage?.output_tokens || 0;
        s.ms     += (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
        s.calls  += 1;
      }
      return data?.content?.[0]?.text ?? '';
    } finally {
      clearTimeout(timeout);
    }
  }

  _extractJSON(text) {
    // Accept raw JSON or JSON inside ```json ... ```
    const match = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
    if (!match) return null;
    return JSON.parse(match[1].trim());
  }

  _buildL1Prompt(userText, lang = 'ja') {
    // Full prompt text lives in prompts/prompt-l1.js (loaded separately).
    // Here we just compose the call structure. The condition cap is injected at call
    // time (configurable) so L1 emits ≤N conditions and the confirmation stays consistent.
    if (typeof PROMPT_L1 === 'undefined') throw new Error('PROMPT_L1 not loaded');
    const maxC = Number.isFinite(this.config.MAX_CONDITIONS) ? this.config.MAX_CONDITIONS : 3;
    // confirmation is user-facing → write it in the UI language. All OTHER fields
    // (text/queries/place names) stay Japanese for the JP map data.
    const langNote = lang === 'en'
      ? ' confirmation フィールドだけは英語で書いてください（他のフィールドは日本語のまま。地名・施設名は日本語表記のままでよい）。'
      : '';
    return {
      system: PROMPT_L1,
      user:   `ユーザー入力：「${userText}」\n\nconditionは重要な順に最大${maxC}件まで採用してください（入り切らない条件は confirmation で言及）。${langNote}QuerySchema JSONのみを返してください。`,
    };
  }

  _buildL2_1Prompt(groups) {
    if (typeof PROMPT_L2_1 === 'undefined') throw new Error('PROMPT_L2_1 not loaded');
    const payload = groups.map(g => ({
      key:          g.key,
      intent:       g.intent,
      poi_category: g.poi_category,
      class:        g.class,
    }));
    return {
      system: PROMPT_L2_1,
      user:   `グループ:\n${JSON.stringify(payload, null, 0)}\n\n各グループについて、意図と明確に異なるカテゴリだけを remove した結果を {"<key>":{"remove_poi_category":[...],"remove_class":[...]}, ...} 形式で返してください。迷ったら remove しない。JSONのみ。`,
    };
  }

  _buildL2_2Prompt(intentLabel, candidates) {
    if (typeof PROMPT_L2_2 === 'undefined') throw new Error('PROMPT_L2_2 not loaded');
    const list = candidates.map(c => `{"id":${JSON.stringify(c.id)},"name":${JSON.stringify(c.name ?? '')}}`).join('\n');
    return {
      system: PROMPT_L2_2,
      user:   `探しているもの（意図）：${intentLabel}\n\n候補:\n${list}\n\n各候補が「意図そのもの（意図のインスタンス）か」を判定し、{"definitely":[...],"probably":[...],"no":[...]} 形式でIDを返してください。unknown（判断つかない）は記載不要＝未記載はunknown扱い。JSONのみ。`,
    };
  }
}
