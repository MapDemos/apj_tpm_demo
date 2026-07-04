/**
 * LLM Client — the only module allowed to call Claude API.
 * Handles L1 (query parsing) and L2 (candidate negative filter).
 * Reference: systemdesign_20260704.md §2-1, implementation_instructions §5, §6
 */

class LLMClient {
  constructor(config) {
    this.config = config;
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
          400
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
  // L2: Negative filter on candidates
  // ─────────────────────────────────────────────

  /**
   * Given a target and candidate list, return IDs to exclude.
   * Conservative: only exclude obvious mismatches (R).
   * @param {object} target - QuerySchema.target
   * @param {Array<{id: number|string, name: string}>} candidates
   * @returns {Promise<Array<number|string>>} exclude_ids
   */
  async filterCandidates(target, candidates) {
    if (!candidates || candidates.length === 0) return [];

    const result = await this._callClaude(
      this._buildL2Prompt(target, candidates),
      1024  // large enough for exclude_ids list even with ~150 candidates
    );
    try {
      const json = this._extractJSON(result);
      return Array.isArray(json?.exclude_ids) ? json.exclude_ids : [];
    } catch {
      return []; // on failure, keep all candidates (conservative)
    }
  }

  // ─────────────────────────────────────────────
  // Internal
  // ─────────────────────────────────────────────

  async _callClaude(prompt, maxTokens = 400) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.API_TIMEOUT_MS);

    try {
      const resp = await fetch(this.config.CLAUDE_API_PROXY, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        signal:  controller.signal,
        body: JSON.stringify({
          model:      this.config.CLAUDE_MODEL,
          max_tokens: maxTokens,
          temperature: 0,
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.user }],
        }),
      });
      if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
      const data = await resp.json();
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

  _buildL2Prompt(target, candidates) {
    if (typeof PROMPT_L2 === 'undefined') throw new Error('PROMPT_L2 not loaded');
    const list = candidates.map(c => `{"id":${JSON.stringify(c.id)},"name":${JSON.stringify(c.name ?? '')}}`).join('\n');
    return {
      system: PROMPT_L2,
      user:   `探索対象：${target.text}（${target.type}）\n\n候補:\n${list}\n\n明らかに対象外のIDを{"exclude_ids":[...]}形式で返してください。`,
    };
  }
}
