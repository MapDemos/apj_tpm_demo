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
      L1: { model: this.config.L1_MODEL, inTok: 0, outTok: 0, ms: 0, calls: 0 },
      L2: { model: this.config.L2_MODEL, inTok: 0, outTok: 0, ms: 0, calls: 0 },
    };
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
  async parseQuery(userText, previousText = null) {
    const fullText = previousText ? `${previousText}\n追加情報：${userText}` : userText;

    for (let attempt = 0; attempt <= this.config.L1_MAX_RETRY; attempt++) {
      try {
        const result = await this._callClaude(
          this._buildL1Prompt(fullText),
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

  // ─────────────────────────────────────────────
  // L2: Intent-match check on candidates
  // ─────────────────────────────────────────────

  /**
   * Given an intent label and candidate list, return the IDs that CLEARLY do NOT
   * match the intent (to be removed). Judgment is intent-based, but only clear
   * mismatches are returned — ambiguous candidates are kept (recall priority, R).
   * Returns null on parse failure so the caller can keep all (conservative).
   * @param {string} intentLabel - human-readable description of what is being searched
   * @param {Array<{id: number|string, name: string}>} candidates
   * @returns {Promise<Array<number|string>|null>} mismatch_ids, or null on failure
   */
  /**
   * Rate candidates against the intent: returns { exact:Set, mismatch:Set } of ids.
   * Unlisted ids = 'related' (kept, medium). null on parse failure (caller keeps all).
   */
  async rateCandidates(intentLabel, candidates) {
    if (!candidates || candidates.length === 0) return { exact: new Set(), mismatch: new Set() };

    const result = await this._callClaude(
      this._buildL2Prompt(intentLabel, candidates),
      1024,
      this.config.L2_MODEL,
      'L2'
    );
    try {
      const json = this._extractJSON(result);
      if (!json) return null;
      return {
        exact:    new Set((json.exact    || []).map(String)),
        mismatch: new Set((json.mismatch || []).map(String)),
      };
    } catch {
      return null; // parse failure → caller keeps all as 'related'
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

  _buildL1Prompt(userText) {
    // Full prompt text lives in prompts/prompt-l1.js (loaded separately).
    // Here we just compose the call structure.
    if (typeof PROMPT_L1 === 'undefined') throw new Error('PROMPT_L1 not loaded');
    return {
      system: PROMPT_L1,
      user:   `ユーザー入力：「${userText}」\n\nQuerySchema JSONのみを返してください。`,
    };
  }

  _buildL2Prompt(intentLabel, candidates) {
    if (typeof PROMPT_L2 === 'undefined') throw new Error('PROMPT_L2 not loaded');
    const list = candidates.map(c => `{"id":${JSON.stringify(c.id)},"name":${JSON.stringify(c.name ?? '')}}`).join('\n');
    return {
      system: PROMPT_L2,
      user:   `探しているもの（意図）：${intentLabel}\n\n候補:\n${list}\n\nこの意図に【明らかに】合致しない候補のIDだけを{"mismatch_ids":[...]}形式で返してください。判断が曖昧なものは含めないでください（残します）。`,
    };
  }
}
