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
    // cacheRead/cacheWrite: プロンプトキャッシュのヒット可視化用（read=約0.1倍/write=約1.25倍）。
    this.stats = {
      L1c:  { model: this.config.L1_CONFIRM_MODEL, inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, ms: 0, calls: 0 },
      L1:   { model: this.config.L1_MODEL,   inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, ms: 0, calls: 0 },
      L1_3: { model: this.config.L1_3_MODEL, inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, ms: 0, calls: 0 },
      L2_1: { model: this.config.L2_1_MODEL, inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, ms: 0, calls: 0 },
      L2_2: { model: this.config.L2_2_MODEL, inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, ms: 0, calls: 0 },
      L3:   { model: this.config.L3_MODEL,   inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, ms: 0, calls: 0 },
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

  /**
   * L3 (overflow clarify): from a list of nearby landmark names, pick the most
   * RECOGNIZABLE / well-known ones (3-4) to prompt the user. Returns names (string[]).
   * @param {string[]} names
   * @param {string} lang
   */
  async suggestProminentLandmarks(names, lang = 'ja') {
    if (!names || !names.length) return [];
    const sys = 'あなたは位置特定を助けるアシスタントです。与えられたランドマーク名の一覧から、一般に知名度が高く人が思い出しやすいもの（公園・公共施設・有名チェーン・駅・大型商業施設・ランドマーク建物など）を3〜4個選んで返してください。無名・番地のみ・一般的すぎるものは避ける。一覧に実在する名前をそのまま返す。出力はJSONのみ: {"suggestions": ["名前", ...]}。';
    try {
      const result = await this._callClaude(
        { system: sys, user: `ランドマーク名一覧:\n${JSON.stringify(names)}\n\n知名度の高いものを3〜4個。JSONのみ返してください。` },
        400,
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

  /**
   * L1-3 (broad-proximity narrowing): given a too-broad proximity area name
   * (e.g. 「鎌倉市」), propose real, well-known, geographically SPREAD sub-anchors
   * (major stations / districts / landmarks) a user would recognize, so JS can offer
   * them as narrowing buttons. World-knowledge enumeration only — JS grounds each via
   * Search Box (drops any that don't resolve / fall outside the area), so a stray name
   * is harmless. Returns names (string[]). This is the FRONT half (before 1次検索);
   * distinct from L3 which narrows AFTER candidates are found.
   * @param {string} areaText - the broad area (e.g. 「鎌倉市」)
   * @param {string} lang
   */
  async suggestProximityAnchors(areaText, lang = 'ja') {
    if (!areaText) return [];
    const en = lang === 'en';
    const sys = en
      ? 'You help pinpoint locations. Given a broad area that is too large to be a useful "nearby" reference, list 6-8 REAL, well-known, and geographically SPREAD sub-places within it (major train stations, well-known districts/neighborhoods, or landmark facilities) that a user would recognize and could use to narrow down. Prefer train stations. Avoid the area name itself, vague/duplicate/too-generic names. Output JSON only: {"suggestions": ["name", ...]}.'
      : 'あなたは位置特定を助けるアシスタントです。「近く」の基準にするには広すぎるエリアが与えられます。その中にある、実在し・知名度が高く・地理的に散らばった下位の場所を6〜8個挙げてください（主要な鉄道駅、有名な地区・町名、目印になる施設）。駅を優先。エリア名そのもの・曖昧/重複/一般的すぎる名前は避ける。出力はJSONのみ: {"suggestions": ["名前", ...]}。';
    try {
      const result = await this._callClaude(
        { system: sys, user: en
          ? `Broad area: 「${areaText}」\n\nList 6-8 recognizable, spread-out sub-places. JSON only.`
          : `広すぎるエリア: 「${areaText}」\n\n知名度が高く散らばった下位の場所を6〜8個。JSONのみ返してください。` },
        400,
        this.config.L1_3_MODEL,
        'L1_3'
      );
      const json = this._extractJSON(result);
      const arr = json && Array.isArray(json.suggestions) ? json.suggestions : [];
      return arr.filter(s => typeof s === 'string' && s.trim()).slice(0, 8);
    } catch {
      return [];
    }
  }

  /**
   * L1-3 (colloquial place interpretation / 「もしかして」): a place name may be
   * colloquial/partial/ambiguous (「青山」) while the user commonly means a specific
   * well-known place (東京都港区南青山). Search Box forward-search alone can't surface it
   * (南青山 isn't even in the "青山" results), so world knowledge is required. Return the
   * canonical full name(s) (1-3); JS grounds each via Search Box. Return [] when the name
   * is already specific enough (a city/ward/clear area) — those go to the broad-proximity
   * gate instead of 「もしかして」. Runs in PARALLEL with Search Box (no added latency).
   * @param {string} text - the place name as the user said it (「青山」)
   * @param {string} lang
   */
  async interpretPlaceName(text, lang = 'ja') {
    if (!text) return [];
    const en = lang === 'en';
    const sys = en
      ? 'You interpret Japanese place names. If the given name is colloquial/partial/ambiguous but a well-known specific place is commonly meant, return its canonical full name(s) (1-3), e.g. "青山" → "東京都港区南青山", "東京都港区北青山". If it is already specific enough (a city/ward/clearly-defined area), return an empty list. Use real official names. Output JSON only: {"places": ["...", ...]}.'
      : 'あなたは日本の地名解釈アシスタントです。与えられた地名が口語的・部分的・曖昧で、一般常識的に特定の有名な場所を指すと考えられる場合、その正式な地名を1〜3個返してください（例:「青山」→「東京都港区南青山」「東京都港区北青山」）。市区町村や明確に定まった地名など、既に十分具体的な場合は空配列。実在する正式名称で。出力はJSONのみ: {"places": ["...", ...]}。';
    try {
      const result = await this._callClaude(
        { system: sys, user: en ? `Place name: 「${text}」\nJSON only.` : `地名: 「${text}」\nJSONのみ返してください。` },
        300,
        this.config.L1_3_MODEL,
        'L1_3'
      );
      const json = this._extractJSON(result);
      const arr = json && Array.isArray(json.places) ? json.places : [];
      return arr.filter(s => typeof s === 'string' && s.trim()).slice(0, 3);
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
    // 上限超過分も含め全条件＋各poiのqueries[]を出すため出力が長くなり得る。max_tokens不足だと
    // JSONが途中で切れてパース失敗→「通信エラー」になる。余裕を持たせる（§透明化A）。
    const MAX_TOK = 3000;

    let lastDetail = '';
    for (let attempt = 0; attempt <= this.config.L1_MAX_RETRY; attempt++) {
      try {
        const { text, stop_reason } = await this._callClaude(
          this._buildL1Prompt(fullText, lang),
          MAX_TOK,
          this.config.L1_MODEL,
          'L1',
          // L1は出力が大きく生成に時間がかかる → 既定8秒では足りない。専用に長めのタイムアウト。
          // cacheSystem: 巨大で不変な L1 システムプロンプトをプロンプトキャッシュ（2回目以降は約90%減）。
          { returnMeta: true, cacheSystem: true, timeoutMs: Math.max(this.config.API_TIMEOUT_MS, this.config.L1_TIMEOUT_MS || 20000) }
        );
        const json = this._extractJSON(text);
        if (json) return json;
        // JSONが取れない＝打ち切り or 不正JSON。原因を詳細化（デバッグ表示・リトライ判断用）。
        const truncated = stop_reason === 'max_tokens';
        const tail = (text || '').slice(-160).replace(/\s+/g, ' ');
        lastDetail = truncated
          ? `L1 response truncated (stop_reason=max_tokens, max_tokens=${MAX_TOK}). 条件を減らすか max_tokens を上げてください。tail="…${tail}"`
          : `L1 returned unparseable JSON (stop_reason=${stop_reason}). tail="…${tail}"`;
        // 打ち切りは再試行しても同じ長さで切れる（temp=0・決定的）→ リトライせず即中断。
        if (truncated) break;
      } catch (e) {
        // ネットワーク/HTTP等の一過性エラーはリトライ価値がある→ ループ継続（最終試行後にthrow）。
        lastDetail = e?.message || String(e);
      }
    }
    throw new Error(lastDetail || 'L1: failed to produce valid JSON after retries');
  }

  /**
   * 高速な確認文だけを生成（L1本体と並行してHaikuで実行し、真っ先に「〜を探しますね」を出す）。
   * 解析はしない＝ユーザーの依頼の丁寧な復唱のみ。場所探し以外なら空文字。
   * @returns {Promise<string>}
   */
  async confirmInput(userText, lang = 'ja') {
    if (typeof PROMPT_CONFIRM === 'undefined') return '';
    try {
      const langNote = lang === 'en' ? '\nReply in English.' : '';
      const result = await this._callClaude(
        { system: PROMPT_CONFIRM, user: `発話:\n${userText}${langNote}` },
        160,
        this.config.L1_CONFIRM_MODEL || 'claude-haiku-4-5-20251001',
        'L1c' // stats未計上（L1本体を汚さない・極小コール）
      );
      const text = (result || '').trim().replace(/^["「]|["」]$/g, '');
      return text.length > 1 ? text : '';
    } catch { return ''; }
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
      'L2_1',
      { cacheSystem: true } // 不変な L2-1 システムプロンプトをプロンプトキャッシュ
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
      'L2_2',
      { cacheSystem: true } // 不変な L2-2 システムプロンプトをプロンプトキャッシュ
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
   * temperature を受け付けるモデルか（allowlist）。
   * 4.6世代以前（sonnet-4-6 / opus-4-6 / haiku-4-5系 / claude-3系）のみ true。
   * Sonnet 5 等の5世代・Opus 4.7+・Fable 5 は temperature を廃止しており、送ると 400 になる。
   * temperature を「送らない」のは全モデルで安全（＝既定サンプリング）なので、
   * 対応が分かっているモデルにだけ送る安全側の方式にしている。
   */
  _supportsTemperature(model) {
    return /sonnet-4-6|opus-4-6|haiku-4-5|claude-3/.test(String(model || ''));
  }

  /**
   * モデル別のタイムアウト下限(ms)。4.6/Haiku 系は速いので下限なし(0)＝呼び出し側/既定に委ねる。
   * Sonnet 5・Opus 4.7+・Fable 5 は1コールが重く、既定8秒だと L2/L3 でもタイムアウトしがちなので
   * 下限を引き上げる（L1 は元々 L1_TIMEOUT_MS=20s で十分長い）。
   */
  _minTimeoutMs(model) {
    const m = String(model || '');
    if (this._supportsTemperature(m)) return 0;      // 4.6世代以前は速い
    return this.config.SLOW_MODEL_TIMEOUT_MS || 20000; // 5世代/Opus4.7+/Fable5
  }

  async _callClaude(prompt, maxTokens = 400, model = null, role = null, opts = {}) {
    const controller = new AbortController();
    const useModel = model || this.config.CLAUDE_MODEL;
    // opts.timeoutMs: 呼び出し側でタイムアウトを上書き可能（L1は出力が大きく生成に時間がかかるため長め）。
    // さらにモデル依存の下限を課す：Sonnet 5 等の5世代・Opus 4.7+・Fable 5 は 4.6 より1コールが
    // 重く、既定8秒では L2/L3 でもタイムアウトしがち → 下限を引き上げる。
    const timeoutMs = Math.max(opts.timeoutMs || this.config.API_TIMEOUT_MS, this._minTimeoutMs(useModel));
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // opts.cacheSystem: システムプロンプトをプロンプトキャッシュ対象にする（不変で使い回す L1/L2 向け）。
    // 文字列を content ブロック配列にし、末尾に cache_control を付ける（prefixキャッシュ）。
    const systemField = (opts.cacheSystem && typeof prompt.system === 'string')
      ? [{ type: 'text', text: prompt.system, cache_control: { type: 'ephemeral' } }]
      : prompt.system;

    try {
      const reqBody = {
        model:      useModel,
        max_tokens: maxTokens,
        system: systemField,
        messages: [{ role: 'user', content: prompt.user }],
      };
      // temperature は対応モデルにだけ付与（5世代/Opus4.7+ は送ると400）。
      if (this._supportsTemperature(useModel)) reqBody.temperature = 0;
      const resp = await fetch(this.config.CLAUDE_API_PROXY, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        signal:  controller.signal,
        body: JSON.stringify(reqBody),
      });
      if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
      const data = await resp.json();
      // Accumulate stats by role
      const s = role && this.stats?.[role];
      if (s) {
        s.model = useModel;
        s.inTok      += data?.usage?.input_tokens         || 0;
        s.outTok     += data?.usage?.output_tokens        || 0;
        s.cacheRead  += data?.usage?.cache_read_input_tokens     || 0;
        s.cacheWrite += data?.usage?.cache_creation_input_tokens || 0;
        s.ms     += (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
        s.calls  += 1;
      }
      // content 配列内の全 text ブロックを連結して取り出す。
      // Sonnet 5 等（Claude 5系）は先頭ブロックが text とは限らず（reasoning等が先頭に来ると
      // content[0].text が undefined になり空文字→JSONパース失敗）、content[0] 決め打ちだと
      // 「unparseable JSON (end_turn), tail=空」になる。全 text ブロック連結で堅牢化。
      const text = Array.isArray(data?.content)
        ? data.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('')
        : (data?.content?.[0]?.text ?? '');
      // opts.returnMeta: 呼び出し側（L1）が stop_reason を見て打ち切り(max_tokens)を検知できるようにする。
      if (opts.returnMeta) return { text, stop_reason: data?.stop_reason ?? null, usage: data?.usage ?? null };
      return text;
    } catch (e) {
      // abort は「時間切れ」。素の "signal is aborted without reason" では原因が分からないので明示化。
      if (timedOut || e?.name === 'AbortError') {
        throw new Error(`LLM timeout after ${timeoutMs}ms (model=${useModel}, max_tokens=${maxTokens})`);
      }
      throw e;
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
      user:   `ユーザー入力：「${userText}」\n\n地理的な条件は重要な順に、上限を超える分も含めてすべて conditions 配列に入れてください（システムが上限${maxC}件を適用し、超過分はユーザーへ通知します）。地図データで判定できない非地理的な特徴は unsupported_features 配列に入れてください（confirmation では触れない。JSが決定的に通知します）。${langNote}QuerySchema JSONのみを返してください。`,
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
