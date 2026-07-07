/**
 * Emergency Location Finder - Main Application
 *
 * Orchestrates UI, Mapbox GL JS map, and Claude AI agent.
 * Provides frontend map-visualization tools to Claude alongside
 * the data-fetching tools from MapboxMCPClient.
 *
 * Based on spec §5: フロントエンド地図連動仕様
 *
 * Modeled after JapanDayTripApp from the reference project,
 * but self-contained (no @mapdemos/ai-framework dependency).
 *
 * Requires (loaded via script tags before this file):
 *   config.js, prompts/prompt.js,
 *   modules/spatial-utils.js, modules/mapbox-mcp.js
 */

class LocationFinderApp {

  constructor() {
    this.config    = CONFIG;
    this.mapboxMCP = null;  // initialized in initialize()

    // Map state
    this.map              = null;
    this.candidateMarkers = [];
    this.finalMarker      = null;
    this._mapLayerRegistry = []; // { layers:[{id,type}], sources:[id], gen:N }
    this._mapGen           = 0;  // current generation (increments each user send)

    // Conversation history for Claude
    this.messages = [];

    // Language state
    this._lang = 'ja';

    // Token tracking
    this._tokens = { input: 0, output: 0 };

    // Debug step mode
    this._debugMode       = false;
    this._debugStepResolve = null;
    this._debugPauseCount = 0;

    // Hint system
    this._hintResolve = null;

    // Probable area
    this._probableAreaActive = false;

    // Current agent loop turn (for layer metadata)
    this._currentTurn = 0;

    // Flag: finalize_location_marker was called during the current loop
    this._finalizedDuringLoop = false;

    // Condition tracking for mechanical match_level determination
    this._conditionTracker = []; // [{passed: Set<name>}]
    this._lastProximity    = null; // [lng, lat] for distance sorting

  }

  // ═══════════════════════════════════════════════════════════════
  // Initialization
  // ═══════════════════════════════════════════════════════════════

  async initialize() {
    try {
      // 1. Init Mapbox MCP (data-fetching tools)
      this.mapboxMCP = new MapboxMCPClient(this.config, this);
      await this.mapboxMCP.initialize();

      // 2. Init Mapbox GL JS map
      await this._initMap();

      // 3. Wire up UI event listeners
      this._setupEventListeners();

      // 4. Restore saved model prefs + wire settings modal + badge
      this._initSettings();

      // 5. Init JS-driven QueryEngine (new architecture)
      this._initQueryEngine();

      // 6. Welcome message (bilingual via LANG)
      this.addMessage('assistant', LANG[this._lang].welcome);

    } catch (err) {
      console.error('[App] initialize() failed:', err);
      this.addMessage('error', `初期化エラー: ${err.message}`);
    }
  }

  _initQueryEngine() {
    const llm = new LLMClient(this.config);
    const ui  = this._buildUICallbacks();
    this.queryEngine = new QueryEngine({ mcp: this.mapboxMCP, llm, ui, config: this.config });
  }

  /** Wire the ⚙️ settings modal (per-role model selection) + restore saved prefs. */
  _initSettings() {
    // Restore saved prefs (migrate old single {L1,L2} → {L1,L2_1,L2_2}: L2 was the
    // target-relevance model, so it maps to L2_2; L2_1 defaults to Haiku).
    try {
      const saved = JSON.parse(localStorage.getItem('geonator_models') || '{}');
      if (saved.L1)   this.config.L1_MODEL   = saved.L1;
      if (saved.L2_1) this.config.L2_1_MODEL = saved.L2_1;
      if (saved.L2_2) this.config.L2_2_MODEL = saved.L2_2;
      else if (saved.L2) this.config.L2_2_MODEL = saved.L2; // legacy key
      if (saved.L3) this.config.L3_MODEL = saved.L3;
    } catch (_) {}
    // L2-1 behavior: category=null handling (separate from model prefs)
    try {
      const b = JSON.parse(localStorage.getItem('geonator_l2_1') || '{}');
      if (typeof b.keepNull === 'boolean') this.config.L2_1_KEEP_NULL_CATEGORY = b.keepNull;
    } catch (_) {}
    // Search behavior: max conditions (0-5)
    try {
      const b = JSON.parse(localStorage.getItem('geonator_search') || '{}');
      if (Number.isFinite(b.maxConditions)) this.config.MAX_CONDITIONS = Math.max(0, Math.min(5, b.maxConditions));
    } catch (_) {}

    const l1Sel  = document.getElementById('l1ModelSelect');
    const l21Sel = document.getElementById('l2_1ModelSelect');
    const l22Sel = document.getElementById('l2_2ModelSelect');
    const l3Sel  = document.getElementById('l3ModelSelect');
    const nullSel = document.getElementById('l2_1NullSelect');
    const maxCondSel = document.getElementById('maxConditionsSelect');
    const modal  = document.getElementById('settingsModal');
    if (l1Sel)  l1Sel.value  = this.config.L1_MODEL;
    if (l21Sel) l21Sel.value = this.config.L2_1_MODEL;
    if (l22Sel) l22Sel.value = this.config.L2_2_MODEL;
    if (l3Sel)  l3Sel.value  = this.config.L3_MODEL;
    if (nullSel) nullSel.value = this.config.L2_1_KEEP_NULL_CATEGORY === false ? 'exclude' : 'include';
    if (maxCondSel) maxCondSel.value = String(this.config.MAX_CONDITIONS);

    const persist = () => {
      try {
        localStorage.setItem('geonator_models', JSON.stringify({
          L1: this.config.L1_MODEL, L2_1: this.config.L2_1_MODEL, L2_2: this.config.L2_2_MODEL, L3: this.config.L3_MODEL,
        }));
      } catch (_) {}
      this._updateModelBadge();
    };
    const persistNull = () => {
      try { localStorage.setItem('geonator_l2_1', JSON.stringify({ keepNull: this.config.L2_1_KEEP_NULL_CATEGORY })); } catch (_) {}
    };
    const persistSearch = () => {
      try { localStorage.setItem('geonator_search', JSON.stringify({ maxConditions: this.config.MAX_CONDITIONS })); } catch (_) {}
    };
    l1Sel?.addEventListener('change',  e => { this.config.L1_MODEL   = e.target.value; persist(); });
    l21Sel?.addEventListener('change', e => { this.config.L2_1_MODEL = e.target.value; persist(); });
    l22Sel?.addEventListener('change', e => { this.config.L2_2_MODEL = e.target.value; persist(); });
    l3Sel?.addEventListener('change',  e => { this.config.L3_MODEL   = e.target.value; persist(); });
    nullSel?.addEventListener('change', e => { this.config.L2_1_KEEP_NULL_CATEGORY = e.target.value !== 'exclude'; persistNull(); });
    maxCondSel?.addEventListener('change', e => { this.config.MAX_CONDITIONS = parseInt(e.target.value, 10); persistSearch(); });

    this._initScoringSettings();

    // Single "↺ すべてデフォルトに戻す" — models + scoring weights + decisiveness at once.
    const MODEL_DEFAULTS = { L1: 'claude-haiku-4-5-20251001', L2_1: 'claude-haiku-4-5-20251001', L2_2: 'claude-sonnet-4-6', L3: 'claude-haiku-4-5-20251001' };
    document.getElementById('settingsResetBtn')?.addEventListener('click', () => {
      this.config.L1_MODEL   = MODEL_DEFAULTS.L1;
      this.config.L2_1_MODEL = MODEL_DEFAULTS.L2_1;
      this.config.L2_2_MODEL = MODEL_DEFAULTS.L2_2;
      this.config.L3_MODEL   = MODEL_DEFAULTS.L3;
      this.config.L2_1_KEEP_NULL_CATEGORY = false; // default: exclude null-category candidates (strict)
      this.config.MAX_CONDITIONS = 3;              // default condition cap
      if (l1Sel)  l1Sel.value  = MODEL_DEFAULTS.L1;
      if (l21Sel) l21Sel.value = MODEL_DEFAULTS.L2_1;
      if (l22Sel) l22Sel.value = MODEL_DEFAULTS.L2_2;
      if (l3Sel)  l3Sel.value  = MODEL_DEFAULTS.L3;
      if (nullSel) nullSel.value = 'exclude';
      if (maxCondSel) maxCondSel.value = '3';
      try { localStorage.removeItem('geonator_models'); localStorage.removeItem('geonator_l2_1'); localStorage.removeItem('geonator_search'); } catch (_) {}
      this._updateModelBadge();
      this._resetScoring?.(); // weights + decisiveness (defined in _initScoringSettings)
    });

    document.getElementById('settingsBtn')?.addEventListener('click', () => {
      if (modal) modal.style.display = 'flex';
    });
    document.getElementById('settingsCloseBtn')?.addEventListener('click', () => {
      if (modal) modal.style.display = 'none';
    });
    modal?.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });

    this._updateModelBadge();
  }

  _updateModelBadge() {
    const el = document.getElementById('model-badge');
    if (!el) return;
    const s = m => (m || '').replace('claude-', '').replace(/-\d{8}$/, '');
    el.textContent = `L1:${s(this.config.L1_MODEL)} / L2-1:${s(this.config.L2_1_MODEL)} / L2-2:${s(this.config.L2_2_MODEL)} / L3:${s(this.config.L3_MODEL)}`;
  }

  /**
   * Scoring settings UI (2 of the 3 modal sections):
   *  - スコアの重みづけ: 3 weight sliders that ALWAYS sum to 100% (moving one
   *    redistributes the other two proportionally). Stored as fractions summing to 1.0.
   *  - 結論の出し方: 言い切り度 slider (separate control, not a weight).
   * Exposes this._resetScoring() so the single "↺ すべてデフォルトに戻す" button
   * (wired in _initSettings) can restore weights + decisiveness together.
   * Values live in CONFIG (read by QueryEngine on the NEXT search) + persist to localStorage.
   */
  _initScoringSettings() {
    const DEFAULTS = { wRel: 0.30, wCond: 0.50, wAnchor: 0.20, dec: 1.0 };
    const WKEYS = ['SCORE_WEIGHT_RELEVANCE', 'SCORE_WEIGHT_CONDITION', 'SCORE_WEIGHT_ANCHOR'];

    // Restore saved scoring prefs
    try {
      const s = JSON.parse(localStorage.getItem('geonator_scoring') || '{}');
      if (typeof s.wRel    === 'number') this.config.SCORE_WEIGHT_RELEVANCE = s.wRel;
      if (typeof s.wCond   === 'number') this.config.SCORE_WEIGHT_CONDITION = s.wCond;
      if (typeof s.wAnchor === 'number') this.config.SCORE_WEIGHT_ANCHOR    = s.wAnchor;
      if (typeof s.dec     === 'number') this.config.SCORE_DECISIVENESS     = s.dec;
    } catch (_) {}

    const el = id => document.getElementById(id);
    const wSlider = { SCORE_WEIGHT_RELEVANCE: el('wRelSlider'), SCORE_WEIGHT_CONDITION: el('wCondSlider'), SCORE_WEIGHT_ANCHOR: el('wAnchorSlider') };
    const wVal    = { SCORE_WEIGHT_RELEVANCE: el('wRelVal'),    SCORE_WEIGHT_CONDITION: el('wCondVal'),    SCORE_WEIGHT_ANCHOR: el('wAnchorVal') };
    const decSlider = el('decisivenessSlider'), decVal = el('decisivenessVal');

    // Integer percentages summing to exactly 100 (largest-remainder rounding).
    const pctInts = fracs => {
      const raw = fracs.map(f => f * 100);
      const out = raw.map(Math.floor);
      let rem = 100 - out.reduce((a, b) => a + b, 0);
      const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
      for (let k = 0; k < rem && k < order.length; k++) out[order[k][1]]++;
      return out;
    };

    const syncUI = () => {
      const w = WKEYS.map(k => this.config[k] ?? 0);
      const sum = w.reduce((a, b) => a + b, 0) || 1;
      const pct = pctInts(w.map(x => x / sum)); // render as shares of 100
      WKEYS.forEach((k, i) => {
        if (wSlider[k]) wSlider[k].value = String(pct[i]);
        if (wVal[k])    wVal[k].textContent = `${pct[i]}%`;
      });
      const d = this.config.SCORE_DECISIVENESS ?? 0.4;
      if (decSlider) decSlider.value = String(Math.round(d * 100));
      if (decVal)    decVal.textContent = `言い切り度 ${Math.round(d * 100)}%`;
    };

    const persist = () => {
      try {
        localStorage.setItem('geonator_scoring', JSON.stringify({
          wRel: this.config.SCORE_WEIGHT_RELEVANCE, wCond: this.config.SCORE_WEIGHT_CONDITION,
          wAnchor: this.config.SCORE_WEIGHT_ANCHOR, dec: this.config.SCORE_DECISIVENESS,
        }));
      } catch (_) {}
    };

    // Redistribute so the 3 weights always sum to 1.0 (UI shows 100%).
    const setWeight = (changedKey, frac) => {
      frac = Math.max(0, Math.min(1, frac));
      const others = WKEYS.filter(k => k !== changedKey);
      const oldOther = others.map(k => this.config[k] ?? 0);
      const oldSum = oldOther[0] + oldOther[1];
      const remaining = 1 - frac;
      this.config[changedKey] = frac;
      if (oldSum > 1e-9) others.forEach((k, i) => { this.config[k] = remaining * (oldOther[i] / oldSum); });
      else               others.forEach(k => { this.config[k] = remaining / 2; });
    };

    WKEYS.forEach(k => {
      wSlider[k]?.addEventListener('input', e => { setWeight(k, Number(e.target.value) / 100); persist(); syncUI(); });
    });
    decSlider?.addEventListener('input', e => {
      this.config.SCORE_DECISIVENESS = Number(e.target.value) / 100; persist(); syncUI();
    });

    // Exposed for the global "reset all" button in _initSettings.
    this._resetScoring = () => {
      this.config.SCORE_WEIGHT_RELEVANCE = DEFAULTS.wRel;
      this.config.SCORE_WEIGHT_CONDITION = DEFAULTS.wCond;
      this.config.SCORE_WEIGHT_ANCHOR    = DEFAULTS.wAnchor;
      this.config.SCORE_DECISIVENESS     = DEFAULTS.dec;
      try { localStorage.removeItem('geonator_scoring'); } catch (_) {} // 次回ロードはconfig既定
      syncUI();
    };

    syncUI();
  }

  /**
   * Build the UICallbacks object that QueryEngine uses.
   * All DOM manipulation lives here; QueryEngine stays DOM-free.
   */
  _buildUICallbacks() {
    const self = this;
    return {
      showMessage(text) {
        self.addMessage('assistant', text);
      },
      showSearching(text) {
        self._updateThinking(text);
      },
      async showChoices(question, choices) {
        return new Promise(resolve => {
          self.addMessage('assistant', question);
          self._showChoicePanel(question, choices).then(resolve);
        });
      },
      async showHintInput(prompt, suggestions) {
        return new Promise(resolve => {
          self.addMessage('assistant', prompt);
          self._showHintPanel(prompt, (text) => resolve(text), suggestions);
        });
      },
      getLang() { return self._lang; },
      isDebug() { return self._debugMode; },
      debugStep(stepId, label, lines) {
        if (!self._debugMode) return Promise.resolve();
        return new Promise(resolve => self._showStepPanel(stepId, label, lines, resolve));
      },
      showResults(full, partial, none, summary, conditionLabels) {
        // Tier-aware markers. QueryEngine set _tier + _matchInfo.score.
        self._renderTierMarkers([...full, ...partial, ...none]);

        // Candidate list in the dialogue panel (clickable + feedback for ground truth),
        // with the result summary as the header of the SAME bubble.
        self._renderCandidatePanel(full, partial, none, summary);
      },
      async showFeedback(proximityLabel) {
        return new Promise(resolve => {
          self._showFeedbackButtons(resolve, proximityLabel);
        });
      },
      clearResults() {
        self.clearMapElements();
        self._clearDebugLayers();
        self._removeProbableArea?.();
        if (self.finalMarker) { self.finalMarker.remove(); self.finalMarker = null; }
      },
      showProbableArea(candidates, message) { self.showProbableArea(candidates, message); },

      // ── Visualization / telemetry callbacks (always on, not debug-gated) ──
      refreshCounts() {
        self._updateAPICountDisplay();
      },
      drawProximityPoints(points) {
        // proximityアンカー（基準点）の地図表示は無効化（分かりづらいとの指摘）。
        // 検索エリアは drawBBox(targetBbox/condBbox) で引き続き表示する。
        // アンカー由来の bbox だけは範囲把握に有用なので残す。
        (points || []).forEach(p => {
          if (p.bbox) self._dbgAddBbox(p.bbox);
        });
      },
      drawBBox(bbox) {
        if (bbox) self._dbgAddBbox(bbox);
      },
      drawHits(items) {
        self._condLegend = []; // reset per run (target drawn first, conditions appended)
        (items || []).forEach(it => {
          const lng = it.longitude ?? it.lng;
          const lat = it.latitude  ?? it.lat;
          if (lng != null && lat != null) {
            self._dbgAddPoint('dbg-search-hits', 'searchHits', lng, lat, { name: it.name || '' });
          }
        });
        self._rebuildLegend();
      },
      drawConditionHits(items, ci = 0, label = '') {
        (items || []).forEach(it => {
          const lng = it.longitude ?? it.lng;
          const lat = it.latitude  ?? it.lat;
          if (lng != null && lat != null) {
            self._dbgAddPoint('dbg-tq-hits', 'tqHits', lng, lat, { name: it.name || '', ci });
          }
        });
        const P = LocationFinderApp.COND_PALETTE;
        (self._condLegend ||= []).push({ label: label || `条件${ci + 1}`, color: P[ci % P.length] });
        self._rebuildLegend();
      },
      drawPolygons(features) {
        if (!self._dbg || !features?.length) return;
        // Cap to keep the map readable / performant
        const capped = features.slice(0, 200);
        capped.forEach(f => { if (f?.geometry) self._dbg.evalPolys.features.push(f); });
        try { self.map.getSource('dbg-eval-polys')?.setData(self._dbg.evalPolys); } catch(_) {}
        document.getElementById('mapLegend').style.display = 'block';
      },
      fitToBBox(bbox) {
        if (!bbox) return;
        try {
          self.map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 80, duration: 900, maxZoom: 16 });
        } catch(_) {}
      },
      showDebugReport(report) {
        if (!self._debugMode || !report) return;
        self.addMessage('debug', self._renderDebugReport(report));
      },
      showRunStats(stats) {
        if (!stats) return;
        const fmt = n => (n || 0).toLocaleString('ja-JP');
        const secs = (stats.ms / 1000).toFixed(1);
        const shortModel = m => (m || '').replace('claude-', '').replace(/-\d{8}$/, '');
        const parts = [`⏱ 処理時間 ${secs}s`];
        let totIn = 0, totOut = 0;
        // Always list all three roles (even 0 calls) so L2-1/L2-2 cost/time is visible.
        // 0回 = そのクエリで未実行（キャッシュヒット/対象なし）。
        for (const [role, s] of [['L1', stats.llm?.L1], ['L2-1', stats.llm?.L2_1], ['L2-2', stats.llm?.L2_2], ['L3', stats.llm?.L3]]) {
          if (!s) continue;
          parts.push(`${role}(${shortModel(s.model)}): ↑${fmt(s.inTok)} ↓${fmt(s.outTok)} ・${s.calls}回・${(s.ms/1000).toFixed(1)}s`);
          totIn += s.inTok; totOut += s.outTok;
        }
        parts.push(`API: SB ${self.mapboxMCP?._sbRequests ?? 0} / TQ ${self.mapboxMCP?._tqRequests ?? 0} / ISO ${self.mapboxMCP?._isoRequests ?? 0}`);
        self.addMessage('tool-status', parts.join('\n'));
        // header cumulative token display
        self._tokens.input  += totIn;
        self._tokens.output += totOut;
        self._updateTokenDisplay();
      },
    };
  }

  /**
   * Render the QueryEngine debug report into a readable text block.
   * Shows: parsed QuerySchema, per-element processing, query hit/exclude counts,
   * and evaluation partial-match breakdown.
   */
  _renderDebugReport(r) {
    const L = [];
    L.push('🔧 デバッグ情報');

    // ── QuerySchema ──
    if (r.schema) {
      const s = r.schema;
      const anchors = (s.proximity?.anchors || []).map(a => `${a.text}[${a.type}/${a.specificity}]`).join(', ');
      L.push('');
      L.push('【QuerySchema】');
      L.push(`・proximity: ${anchors}${s.proximity?.bearing_filter ? ' 方角=' + s.proximity.bearing_filter : ''}`);
      L.push(`・target: ${s.target?.text}  intent=${s.target?.query_intent}`);
      (s.conditions || []).forEach(c => {
        const d = c.distance || {};
        L.push(`・condition: ${c.text ?? c.type} [${c.type}]  距離=${d.level}/${d.method}${d.minutes ? ' ' + d.minutes + '分' : ''}${d.profile ? ' ' + d.profile : ''}`);
      });
      if (s.confirmation) L.push(`・確認文: ${s.confirmation}`);
    }

    // ── 一次検索 ──
    if (r.proximity) {
      const p = r.proximity;
      L.push('');
      L.push('【一次検索: proximity解決】');
      L.push(`・アンカー: ${p.anchors.join(', ')}（解決点 ${p.pointCount}）`);
      L.push(`・target収集bbox: 約${p.targetBboxM}m / condition収集bbox: 約${p.condBboxM}m${p.bearing ? ' / 方角カット=' + p.bearing : ''}`);
    }

    // ── Step1 収集 ──
    if (r.target) {
      const t = r.target;
      const fmt = (arr) => (arr || []).map(i => typeof i === 'string' ? i : `${i.name}${i.cls ? '[' + i.cls + ']' : ''}${i.distance != null ? ' ' + i.distance + 'm' : ''}`);
      L.push('');
      L.push('【Step1: target収集＋L2意図チェック】');
      L.push(`・意図: ${t.intent}`);
      if (t.sbCount != null || t.tqCount != null) {
        L.push(`・API内訳: Search Box ${t.sbCount ?? 0}件 / Tilequery採用 ${t.tqCount ?? 0}件 / Tilequery除外 ${t.tqDroppedCount ?? 0}件${t.wantClasses ? '（カテゴリclass=' + t.wantClasses.join(',') + '）' : ''}`);
      }
      // Raw fetched lists (before L2), so recall gaps are visible.
      if (t.sbItems?.length)   L.push(`　▸ Search Box取得(${t.sbItems.length}): ${fmt(t.sbItems).join('、')}`);
      if (t.tqItems?.length)   L.push(`　▸ Tilequery採用(${t.tqItems.length}): ${fmt(t.tqItems).join('、')}`);
      if (t.tqDropped?.length) L.push(`　▸ Tilequery除外(名前/class不一致 ${t.tqDropped.length}): ${fmt(t.tqDropped).join('、')}`);
      L.push(`・取得 ${t.raw}件 → L2で不一致 ${t.excluded}件 除外 → 残 ${t.kept}件`);
      if (t.excludedNames?.length) L.push(`　L2除外: ${t.excludedNames.slice(0, 20).join('、')}${t.excluded > 20 ? ' …' : ''}`);
      if (t.keptNames?.length)     L.push(`　残候補: ${t.keptNames.join('、')}`);
    }
    if (r.conditions?.length) {
      L.push('');
      L.push('【Step1: condition収集】');
      r.conditions.forEach(c => {
        L.push(`・${c.label} [${c.type}/${c.level}]: ${c.found}件`);
      });
    }

    // ── L2-1 categoryフィルタ（通常クエリの種別ノイズ除去） ──
    if (r.categoryFilter?.length) {
      L.push('');
      L.push('【L2-1: categoryフィルタ】');
      r.categoryFilter.forEach(g => {
        const rm = [...(g.removePoi || []), ...(g.removeClass || [])];
        const rmTxt = rm.length ? `除外カテゴリ: ${rm.join('・')}` : '除外なし';
        L.push(`・${g.label}: ${g.before}→${g.after}件 (${rmTxt})`);
      });
    }

    // ── Step2 評価（スコア・ティア） ──
    if (r.evaluation) {
      const e = r.evaluation;
      const icon = t => ({ full1:'🥇', full2:'🥈', full3:'🥉', full:'🟢', partial:'🔸', none:'⚪' }[t] || '🟢');
      L.push('');
      L.push('【Step2: 距離評価（スコア/ティア）】');
      L.push(`・全一致 ${e.full.length}件 / 部分一致 ${e.partial.length}件 / 参考 ${e.noneCount}件`);
      const flr = f => f.floors != null ? ` 🏢${f.floors}階` : '';
      e.full.slice(0, 20).forEach(f => L.push(`　${icon(f.tier)} ${f.name}  [${f.rel || '-'}] score=${f.score}${flr(f)} ← [${f.labels.join(', ')}]`));
      e.partial.slice(0, 12).forEach(p => L.push(`　${icon(p.tier)} ${p.name} (${p.hit}/${p.total}) [${p.rel || '-'}] score=${p.score}${flr(p)} ← [${p.labels.join(', ')}]`));
    }

    // ── 絶対条件フィルタで除外された候補（過剰除外の検知用）──
    if (r.excludedByHardFilter?.length) {
      L.push('');
      L.push(`【絶対条件フィルタで除外 ${r.excludedByHardFilter.length}件】`);
      r.excludedByHardFilter.slice(0, 20).forEach(x => L.push(`　✖ ${x.name}：${x.reason}`));
    }

    return L.join('\n');
  }

  /**
   * Show 3 feedback buttons after results:
   *   done     — 終了する
   *   narrow   — 更に絞り込む（今の候補プールの中だけで絞る）
   *   research — 〈proximity〉周辺で探し直す（条件を足して再検索）
   */
  _showFeedbackButtons(onAction, proximityLabel) {
    const container = document.createElement('div');
    container.className = 'feedback-buttons';
    container.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;';

    const px = (proximityLabel || '').trim();
    const buttons = this._lang === 'en'
      ? [
          { label: '✅ Finish',            value: 'done' },
          { label: '🔍 Narrow down',       value: 'narrow' },
          { label: px ? `🔄 Search again around ${px}` : '🔄 Search again with more info', value: 'research' },
        ]
      : [
          { label: '✅ 終了する',           value: 'done' },
          { label: '🔍 更に絞り込む',        value: 'narrow' },
          { label: px ? `🔄 ${px}周辺で探し直す` : '🔄 条件を足して探し直す', value: 'research' },
        ];

    // Keep the resolver so _resetChat can cancel a pending feedback wait — otherwise
    // clearing chat while awaiting feedback leaves run() hung (input stays disabled).
    this._feedbackResolve = onAction;
    for (const { label, value } of buttons) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.className   = 'choice-btn';
      btn.onclick = () => {
        container.remove();
        this._feedbackResolve = null;
        this.addMessage('user', label);
        onAction(value);
      };
      container.appendChild(btn);
    }

    const chatMessages = document.getElementById('chatMessages');
    if (chatMessages) chatMessages.appendChild(container);
  }

  /**
   * Debug step panel: shows the stage summary + a "▶ 次へ" button and waits.
   * Tagged with data-step so map elements can highlight it on click.
   */
  _showStepPanel(stepId, label, lines, onNext) {
    const container = document.getElementById('chatMessages');
    const wrapper = document.createElement('div');
    wrapper.className = 'message debug-step';
    wrapper.dataset.step = stepId;
    wrapper.style.cursor = 'pointer';
    wrapper.title = this._lang === 'en'
      ? 'Click to show only this step on the map (click again to restore)'
      : 'クリックでこのステップの地図要素だけ表示（再クリックで元に戻す）';
    const body = (lines || []).map(l => _esc(l)).join('<br>');
    wrapper.innerHTML =
      `<div class="msg-label">🪜 ${_esc(label)}</div>` +
      `<div class="message-bubble">${body}<div style="margin-top:8px">` +
      `<button class="choice-btn step-next-btn">▶ 次へ</button></div></div>`;
    // Click the panel body (not the ▶次へ button) → isolate this step's map elements.
    wrapper.addEventListener('click', (e) => {
      if (e.target.closest('.step-next-btn')) return;
      this._isolateStep(stepId);
    });
    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;
    // Make the pause obvious: the "thinking" spinner would otherwise keep
    // spinning and look like a hang while we wait for the click.
    this._updateThinking(this._lang === 'ja'
      ? '⏸ ステップ待機中 — チャットの「▶ 次へ」で継続'
      : '⏸ Paused — click "▶ Next" in the chat to continue');
    const btn = wrapper.querySelector('.step-next-btn');
    // Register so toggling debug off (or reset) can release a pending step.
    const done = () => {
      if (this._debugStepResolve !== done) return; // already released
      this._debugStepResolve = null;
      btn.disabled = true;
      btn.textContent = '✓';
      this._updateThinking(this._lang === 'ja' ? '処理中…' : 'Processing…');
      onNext();
    };
    this._debugStepResolve = done;
    btn.addEventListener('click', done);
  }

  /**
   * Debug: clicking a step panel shows ONLY that step's map elements (exclusive),
   * clicking the same panel again (or a step with no map layers) restores the default
   * (all elements visible). Layers are grouped by step; tier markers count as the
   * Step2 (evaluation) result.
   */
  _isolateStep(stepId) {
    const GROUPS = {
      'step-proximity': ['dbg-proximity-c', 'dbg-bboxes-l', 'dbg-bbox-labels-sym'],
      'step-collect':   ['dbg-search-hits-c', 'dbg-search-hits-l', 'dbg-tq-hits-c', 'dbg-tq-hits-l', 'dbg-clusters-ring', 'dbg-clusters-label'],
      'step-eval':      ['dbg-eval-polys-fill', 'dbg-eval-polys-line', 'dbg-route-buf-f', 'dbg-route-line-l', 'dbg-route-labels-sym'],
    };
    const ALL = Object.values(GROUPS).flat();
    const isolating = this._isolatedStep !== stepId && !!GROUPS[stepId];
    this._isolatedStep = isolating ? stepId : null;

    const setVis = (lid, on) => { try { if (this.map.getLayer(lid)) this.map.setLayoutProperty(lid, 'visibility', on ? 'visible' : 'none'); } catch (_) {} };
    for (const lid of ALL) setVis(lid, !isolating || GROUPS[stepId].includes(lid));

    // Tier markers = the evaluated candidates → shown by default and on Step2 (eval).
    const showMarkers = !isolating || stepId === 'step-eval';
    this.candidateMarkers.forEach(m => { try { m.getElement().style.display = showMarkers ? '' : 'none'; } catch (_) {} });

    document.querySelectorAll('.debug-step').forEach(el =>
      el.classList.toggle('step-isolated', isolating && el.dataset.step === stepId));
  }

  /** Rebuild the map legend: proximity / target / each condition (color) / reach area. */
  _rebuildLegend() {
    const el = document.getElementById('mapLegend');
    if (!el) return;
    const en = this._lang === 'en';
    const row = (color, text, extra = '') =>
      `<div class="legend-row"><span class="legend-dot" style="background:${color};${extra}"></span>${_esc(text)}</div>`;
    const rows = [
      row('#f97316', en ? 'proximity / search area' : 'proximity / 検索範囲'),
      row('#06b6d4', en ? 'target candidates' : 'target候補'),
      ...(this._condLegend || []).map(c => row(c.color, `${en ? 'condition' : '条件'}: ${c.label}`)),
      row('#8b5cf6', en ? 'reach area (eval)' : '評価範囲(到達圏)'),
    ];
    el.innerHTML = rows.join('');
    el.style.display = 'block';
  }

  /** Highlight the chat step message a clicked map element belongs to. */
  _highlightStep(stepId) {
    if (!stepId) return;
    document.querySelectorAll('.step-highlight').forEach(el => el.classList.remove('step-highlight'));
    const el = document.querySelector(`[data-step="${stepId}"]`);
    if (el) {
      el.classList.add('step-highlight');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Map init
  // ─────────────────────────────────────────────────────────────

  async _initMap() {
    mapboxgl.accessToken = this.config.MAPBOX_ACCESS_TOKEN;

    this.map = new mapboxgl.Map({
      container:          'map',
      style:              this.config.MAP_STYLE,
      center:             this.config.DEFAULT_MAP_CENTER,
      zoom:               this.config.DEFAULT_MAP_ZOOM,
      language:           this._lang,
      attributionControl: false,
    });

    this.map.addControl(new mapboxgl.NavigationControl({ visualizePitch: false }), 'top-right');
    this.map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');

    return new Promise(resolve => this.map.on('load', () => {
      document.getElementById('mapStatus').textContent = '地図の準備ができました';
      this._initDebugLayers();
      resolve();
    }));
  }

  // ─────────────────────────────────────────────────────────────
  // UI events
  // ─────────────────────────────────────────────────────────────

  _setupEventListeners() {
    const input   = document.getElementById('chatInput');
    const sendBtn = document.getElementById('sendBtn');

    sendBtn.addEventListener('click', () => this._handleSend());

    // Double-Enter to send: first Enter = newline, second Enter on empty line = send
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        const val = input.value;
        if (val.endsWith('\n') && val.trim() !== '') {
          e.preventDefault();
          this._handleSend();
        }
        // Otherwise let the browser insert the newline naturally
      }
    });

    // Auto-resize textarea
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });

    document.getElementById('clearChatBtn').addEventListener('click', () => this._resetChat());

    document.getElementById('lang-toggle').addEventListener('click', () => this._toggleLanguage());
    document.getElementById('settingsLangBtn')?.addEventListener('click', () => this._toggleLanguage());

    // Thinking float widget toggle
    const toggleLog = () => {
      const log  = document.getElementById('thinkingLog');
      const btn  = document.getElementById('thinkingToggleBtn');
      const open = log.style.display === 'none';
      log.style.display  = open ? 'block' : 'none';
      btn.textContent    = open ? '▼' : '▲';
    };
    document.getElementById('thinkingBadge')?.addEventListener('click', toggleLog);
    document.getElementById('thinkingCollapseBtn')?.addEventListener('click', toggleLog);

    document.getElementById('debugToggleBtn').addEventListener('click', () => {
      this._debugMode = !this._debugMode;
      const btn = document.getElementById('debugToggleBtn');
      btn.textContent = this._debugMode ? LANG[this._lang].debugOn : LANG[this._lang].debugOff;
      btn.classList.toggle('active', this._debugMode);
      // If turning off mid-pause, resume immediately
      if (!this._debugMode && this._debugStepResolve) {
        this._debugStepResolve();
        this._debugStepResolve = null;
      }
    });

    // Example chips
    document.querySelectorAll('.example-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        input.value = btn.dataset.q;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        input.focus();
      });
    });
  }

  async _handleSend() {
    const input   = document.getElementById('chatInput');
    const sendBtn = document.getElementById('sendBtn');
    const text    = input.value.trim();
    if (!text) return;

    // Hide examples on first send
    const examples = document.getElementById('examplesArea');
    if (examples) examples.style.display = 'none';

    input.value      = '';
    sendBtn.disabled = true;
    input.disabled   = true;

    this.addMessage('user', text);
    this._advanceMapGen();
    this._showThinking(LANG[this._lang].connecting);

    try {
      await this.processUserMessage(text);
    } catch (err) {
      this.addMessage('error', `エラー: ${err.message}`);
    } finally {
      this._hideThinking();
      sendBtn.disabled = false;
      input.disabled   = false;
      input.focus();
    }
  }

  _resetChat() {
    this.messages = [];
    this._tokens  = { input: 0, output: 0 };
    this._updateTokenDisplay();
    if (this.mapboxMCP) {
      this.mapboxMCP._sbRequests  = 0;
      this.mapboxMCP._tqRequests  = 0;
      this.mapboxMCP._tqCacheHits = 0;
      this.mapboxMCP._isoRequests  = 0;
      this.mapboxMCP._isoCacheHits = 0;
      this.mapboxMCP._tqCache.clear();
      this.mapboxMCP._poiGridCache?.clear();
      this.mapboxMCP._searchResultCache?.clear();
      this.mapboxMCP._resultBuffer?.clear();
      this.mapboxMCP._resultIdCounter = 0;
      this.mapboxMCP._primarySearchIds?.clear();
    }
    this._resetFlowState();
    this._conditionTracker = [];
    this._lastProximity    = null;
    this._updateAPICountDisplay();
    // Resolve any pending debug pause
    if (this._debugStepResolve) { this._debugStepResolve(); this._debugStepResolve = null; }
    // Resolve any pending hint request
    if (this._hintResolve) { this._hintResolve(null); this._hintResolve = null; }
    // Resolve any pending feedback wait (unknown value → _handleFeedback does nothing,
    // so run() returns cleanly and _handleSend's finally re-enables the input).
    if (this._feedbackResolve) { this._feedbackResolve(null); this._feedbackResolve = null; }
    // Hide the in-progress "検索しています" widget immediately (belt-and-braces;
    // _handleSend's finally also hides it once the resolved run() returns).
    this._hideThinking?.();
    // Remove probable area polygon
    this._removeProbableArea();
    this.clearMapElements();
    this._clearDebugLayers();
    if (this.finalMarker) { this.finalMarker.remove(); this.finalMarker = null; }
    document.getElementById('resolutionPanel')?.remove();
    document.getElementById('chatMessages').innerHTML = '';
    document.getElementById('thinkingSteps').innerHTML = '';
    document.getElementById('mapStatus').textContent = '地図の準備ができました';
    const examples = document.getElementById('examplesArea');
    if (examples) examples.style.display = '';
    this.addMessage('assistant', LANG[this._lang].welcome);
  }

  /**
   * Render candidate markers by tier (JS-driven scoring).
   * gold = full match, top score (stands out dramatically when scores spread)
   * silver = full match, lower score
   * match = full match, flat distribution (no meaningful winner → all equal)
   * bronze = partial match
   * none = no condition matched (shown only when nothing else matched)
   */
  _renderTierMarkers(candidates) {
    this.candidateMarkers.forEach(m => m.remove());
    this.candidateMarkers = [];
    if (!candidates || candidates.length === 0) return;

    // Rank-based tiers. Full-match (full1/2/3/full) pulse; top 3 get callouts; #1 focused.
    const TIER = {
      full1: { size: 22, color: '#f59e0b', ring: '#fde68a', z: 6, glow: true,  label: '🏅 最有力(全一致)', badge: '1' },
      full2: { size: 18, color: '#f59e0b', ring: '#fcd34d', z: 5, glow: true,  label: '2番目(全一致)',    badge: '2' },
      full3: { size: 16, color: '#f59e0b', ring: '#fcd34d', z: 4, glow: true,  label: '3番目(全一致)',    badge: '3' },
      full:  { size: 13, color: '#60a5fa', ring: '#bfdbfe', z: 3, glow: true,  label: '全一致',           badge: '' },
      partial:{ size: 11, color: '#94a3b8', ring: '#cbd5e1', z: 2, glow: false, label: '部分一致',         badge: '' },
      none:  { size: 9,  color: '#64748b', ring: '#475569', z: 1, glow: false, label: '参考',             badge: '' },
    };

    // Draw lower tiers first so #1 ends up on top
    const order = ['none', 'partial', 'full', 'full3', 'full2', 'full1'];
    const sorted = [...candidates].sort((a, b) => order.indexOf(a._tier) - order.indexOf(b._tier));

    const topMarkers = {}; // tier → marker (full1/2/3) for callouts + focus
    for (const place of sorted) {
      const tier = TIER[place._tier] || TIER.none;
      const lng = place.longitude ?? place.lng;
      const lat = place.latitude  ?? place.lat;
      if (lng == null || lat == null) continue;

      // Outer element: Mapbox controls its `transform` for positioning — do NOT
      // apply any CSS transform here (would fight Mapbox and make markers jump).
      const el = document.createElement('div');
      el.className = `tier-marker-wrap tier-${place._tier}`;
      el.style.zIndex = String(tier.z);

      // Inner element: all visual styling + hover/pulse animation live here.
      const dot = document.createElement('div');
      dot.className = `tier-dot${tier.glow ? ' tier-glow' : ''}`;
      // Full-match tiers (gold/silver/match) pulse in their OWN color (--pulse drives the
      // radar ring + halo). Partial/参考 don't pulse.
      dot.style.cssText =
        `width:${tier.size}px;height:${tier.size}px;background:${tier.color};` +
        `border:2px solid ${tier.ring};border-radius:50%;` +
        `box-shadow:${tier.glow ? `0 0 0 4px ${tier.color}59, 0 0 16px 4px ${tier.color}99` : '0 1px 4px rgba(0,0,0,.4)'};` +
        `cursor:pointer;display:flex;align-items:center;justify-content:center;` +
        `font-size:${Math.round(tier.size*0.5)}px;color:#1a1000;font-weight:700;line-height:1;`;
      if (tier.glow) dot.style.setProperty('--pulse', tier.color);
      if (tier.badge) dot.textContent = tier.badge; // rank number on top-3
      el.title = `${tier.label}: ${place.name || '(名前なし)'}（クリックで評価ステップを表示）`;
      el.appendChild(dot);

      const mi = place._matchInfo || {};
      const scorePct = mi.score != null ? Math.round(mi.score * 100) : null;
      // L2 relevance (4段階): definitely=絶対そう / probably=多分そう / unknown=わからない。
      // 「違う」は評価前に除外済みなので、ここに来るのは上記3つのみ。
      const REL = {
        definitely: { stars: '★★★', text: '絶対そう',   color: '#16a34a' },
        probably:   { stars: '★★☆', text: '多分そう',   color: '#84cc16' },
        unknown:    { stars: '★☆☆', text: 'わからない', color: '#64748b' },
      };
      const rel = REL[mi.relevance];
      const popupHTML =
        `<div style="font-weight:700;color:${tier.color}">${tier.badge} ${tier.label}${scorePct != null ? `（スコア ${scorePct}）` : ''}</div>` +
        `<strong>${_esc(place.name || '(名前なし)')}</strong>` +
        (rel ? `<div class="popup-reason" style="color:${rel.color}">関連性 ${rel.stars} ${rel.text}</div>` : '') +
        (mi.floors != null ? `<div class="popup-reason">🏢 ${mi.floors}階相当</div>` : '') +
        (mi.labels?.length ? `<div class="popup-reason">✓ ${_esc(mi.labels.join('、'))}${mi.total ? `（${mi.hit}/${mi.total}）` : ''}</div>` : '');

      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat(_safeLL(lng, lat))
        .setPopup(new mapboxgl.Popup({ offset: tier.size / 2 + 6, closeButton: false }).setHTML(popupHTML))
        .addTo(this.map);
      marker._candId = place.id; // link to dialogue-panel candidate rows
      dot.addEventListener('click', () => {
        marker.togglePopup();
        if (this._debugMode) this._highlightStep('step-eval');
      });
      this.candidateMarkers.push(marker);
      if (['full1', 'full2', 'full3'].includes(place._tier)) topMarkers[place._tier] = { marker, lng, lat };
    }

    // Callouts on the top 3 full-match (最有力/2番目/3番目), map focus on the #1.
    ['full1', 'full2', 'full3'].forEach((t, i) => {
      if (topMarkers[t]) setTimeout(() => topMarkers[t].marker.togglePopup(), 500 + i * 250);
    });
    if (topMarkers.full1) {
      const top = topMarkers.full1;
      try { this.map.flyTo({ center: _safeLL(top.lng, top.lat), zoom: 16, duration: 900, essential: true }); } catch (_) {}
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Candidate list in dialogue panel + feedback (ground-truth capture)
  // ─────────────────────────────────────────────────────────────

  static _TIER_ICON = { full1: '🥇', full2: '🥈', full3: '🥉', full: '🟢', partial: '🔸', none: '⚪' };

  // Per-condition colors for Step1 collection (distinct from target=teal, proximity=orange,
  // eval=violet). Indexed by condition order (ci); MAX_CONDITIONS caps at 5.
  static COND_PALETTE = ['#a855f7', '#ec4899', '#eab308', '#22c55e', '#f43f5e'];

  /**
   * Render candidates as a clickable list in the conversation panel, each with
   * ✓正解 / ✗違う feedback buttons. Feedback is stored in localStorage as ground
   * truth (shared between operator and Claude via CSV export). Available in both
   * normal and debug mode.
   */
  _renderCandidatePanel(full, partial, none, summary) {
    const rows = [...(full || []), ...(partial || [])];
    if (rows.length === 0 && (!none || none.length === 0) && !summary) return;

    const container = document.getElementById('chatMessages');
    const wrapper = document.createElement('div');
    wrapper.className = 'message candidates';

    const panel = document.createElement('div');
    panel.className = 'candidate-panel';

    // Result summary at the top of the bubble (before the candidate list).
    if (summary) {
      const sum = document.createElement('div');
      sum.className = 'candidate-summary';
      sum.textContent = summary;
      panel.appendChild(sum);
    }

    // Header + export
    const header = document.createElement('div');
    header.className = 'candidate-header';
    header.innerHTML = `<span>候補 ${rows.length}件 — 正しい結果を教えてください</span>`;
    const exportBtn = document.createElement('button');
    exportBtn.className = 'cand-export-btn';
    exportBtn.textContent = '⬇ CSV';
    exportBtn.title = '蓄積したフィードバックをCSVで書き出す';
    exportBtn.onclick = () => this._exportFeedback();
    header.appendChild(exportBtn);
    panel.appendChild(header);

    const rowEls = [];
    rows.forEach((c, i) => {
      const mi = c._matchInfo || {};
      const lng = c.longitude ?? c.lng, lat = c.latitude ?? c.lat;
      const icon = LocationFinderApp._TIER_ICON[c._tier] || '🟢';
      const scorePct = mi.score != null ? Math.round(mi.score * 100) : '-';
      const dist = c.distance != null ? ` ・${c.distance}m` : '';

      const row = document.createElement('div');
      row.className = 'cand-row';
      row.innerHTML =
        `<span class="cand-rank">${i + 1}</span>` +
        `<span class="cand-icon">${icon}</span>` +
        `<span class="cand-name">${_esc(c.name || '(名前なし)')}</span>` +
        `<span class="cand-score">${scorePct}${dist}</span>`;
      row.title = 'クリックで地図上の位置へ';
      row.addEventListener('click', () => this._focusCandidate(c.id, lng, lat));

      const fb = document.createElement('div');
      fb.className = 'cand-fb';
      const mk = (txt, label, cls) => {
        const b = document.createElement('button');
        b.className = `cand-fb-btn ${cls}`;
        b.textContent = txt;
        b.onclick = (e) => {
          e.stopPropagation();
          this._recordFeedback(c, label, i + 1);
          fb.querySelectorAll('.cand-fb-btn').forEach(x => x.classList.remove('chosen'));
          b.classList.add('chosen');
        };
        return b;
      };
      fb.appendChild(mk('✓ 正解', 'correct', 'ok'));
      fb.appendChild(mk('✗ 違う', 'wrong', 'ng'));
      row.appendChild(fb);
      panel.appendChild(row);
      rowEls.push(row);
    });

    // Show only the top 5; reveal the rest via "もっと表示".
    const LIMIT = 5;
    if (rowEls.length > LIMIT) {
      rowEls.slice(LIMIT).forEach(r => { r.style.display = 'none'; });
      const more = document.createElement('button');
      more.className = 'cand-more-btn';
      const en = this._lang === 'en';
      more.textContent = en ? `▼ Show more (${rowEls.length - LIMIT} more)` : `▼ もっと表示（残り${rowEls.length - LIMIT}件）`;
      more.onclick = () => { rowEls.slice(LIMIT).forEach(r => { r.style.display = ''; }); more.remove(); };
      panel.appendChild(more);
    }

    // Panel-level: no correct candidate exists (critical for the all_far regime)
    const footer = document.createElement('div');
    footer.className = 'candidate-footer';
    const noneBtn = document.createElement('button');
    noneBtn.className = 'cand-none-btn';
    noneBtn.textContent = 'この中に正解はない（該当なし）';
    noneBtn.onclick = () => {
      this._recordFeedback(null, 'none', null);
      noneBtn.classList.add('chosen');
      noneBtn.textContent = '記録しました：該当なし';
    };
    footer.appendChild(noneBtn);
    if (none && none.length) {
      const n = document.createElement('span');
      n.className = 'cand-none-count';
      n.textContent = `（参考: 条件未一致 ${none.length}件は非表示）`;
      footer.appendChild(n);
    }
    panel.appendChild(footer);

    wrapper.appendChild(panel);
    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;
  }

  /** Fly to a candidate and open its map popup. */
  _focusCandidate(id, lng, lat) {
    if (lng == null || lat == null) return;
    this.map.flyTo({ center: [lng, lat], zoom: 16, duration: 800, essential: true });
    const marker = (this.candidateMarkers || []).find(m => m._candId === id);
    if (marker && !marker.getPopup().isOpen()) marker.togglePopup();
  }

  /**
   * Append one ground-truth feedback row to localStorage.
   * label: 'correct' | 'wrong' | 'none'. Records the place identity + the scoring
   * params in effect, so labels stay valid even after the scoring is retuned.
   */
  _recordFeedback(candidate, label, rank) {
    const mi = candidate?._matchInfo || {};
    const row = {
      ts:           new Date().toISOString(),
      query:        this._lastQuery || '',
      label,
      candidate_id: candidate?.id ?? '',
      name:         candidate?.name ?? '',
      lat:          candidate?.latitude ?? candidate?.lat ?? '',
      lng:          candidate?.longitude ?? candidate?.lng ?? '',
      rank:         rank ?? '',
      score:        mi.score ?? '',
      tier:         candidate?._tier ?? '',
      relevance:    candidate?._relevance ?? '',
      w_rel:        this.config.SCORE_WEIGHT_RELEVANCE ?? '',
      w_cond:       this.config.SCORE_WEIGHT_CONDITION ?? '',
      w_anchor:     this.config.SCORE_WEIGHT_ANCHOR ?? '',
      decisiveness: this.config.SCORE_DECISIVENESS ?? '',
      gold_min:     this.config.GOLD_MIN_SCORE ?? '',
    };
    let all = [];
    try { all = JSON.parse(localStorage.getItem('geonator_feedback') || '[]'); } catch (_) {}
    all.push(row);
    try { localStorage.setItem('geonator_feedback', JSON.stringify(all)); } catch (_) {}
  }

  /** Export accumulated feedback as a downloadable CSV. */
  _exportFeedback() {
    let all = [];
    try { all = JSON.parse(localStorage.getItem('geonator_feedback') || '[]'); } catch (_) {}
    if (!all.length) { this.addMessage('assistant', 'フィードバックはまだ記録されていません。'); return; }

    const cols = ['ts','query','label','candidate_id','name','lat','lng','rank','score','tier','relevance','w_rel','w_cond','w_anchor','decisiveness','gold_min'];
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.join(',')].concat(all.map(r => cols.map(c => esc(r[c])).join(','))).join('\n');

    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `geonator_feedback_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    this.addMessage('assistant', `フィードバック ${all.length}件 を CSV でエクスポートしました。`);
  }

  // ═══════════════════════════════════════════════════════════════
  // Frontend Map-Visualization Tools (exposed to Claude via tools array)
  // Based on spec §5: リアクティブ地図操作ツール
  // ═══════════════════════════════════════════════════════════════

  /**
   * draw_search_boundary
   * Renders a semi-transparent blue polygon showing the search area.
   * @param {number[]} bbox - [minX, minY, maxX, maxY]
   */
  drawSearchBoundary(rawBbox) {
    // Enforce ±500m max (same cap as MCP side)
    const bbox = _capBBoxFE(rawBbox);
    const [minX, minY, maxX, maxY] = bbox;
    const idx = this._mapLayerRegistry.length;
    const p   = `bbox-${idx}`;

    const midLat = (minY + maxY) / 2;
    const wm = Math.round(Math.abs(maxX - minX) * 111320 * Math.cos(midLat * Math.PI / 180));
    const hm = Math.round(Math.abs(maxY - minY) * 110540);
    const sbLabel = wm === hm ? `${wm}m` : `${wm}×${hm}m`;

    const meta = { tool: 'draw_search_boundary', turn: this._currentTurn, params: sbLabel };

    const geojson = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[ [minX,minY],[maxX,minY],[maxX,maxY],[minX,maxY],[minX,minY] ]],
        },
        properties: meta,
      }],
    };

    this.map.addSource(`${p}-poly`, { type: 'geojson', data: geojson });
    this.map.addLayer({ id: `${p}-fill`, type: 'fill', source: `${p}-poly`,
      paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.12 } });
    this.map.addLayer({ id: `${p}-line`, type: 'line', source: `${p}-poly`,
      paint: { 'line-color': '#60a5fa', 'line-width': 2, 'line-dasharray': [4, 2] } });

    this.map.on('click', `${p}-fill`, (e) => this._showLayerPopup(e.lngLat, e.features[0].properties));
    this.map.on('mouseenter', `${p}-fill`, () => { this.map.getCanvas().style.cursor = 'pointer'; });
    this.map.on('mouseleave', `${p}-fill`, () => { this.map.getCanvas().style.cursor = ''; });

    this.map.addSource(`${p}-lbl`, { type: 'geojson', data: {
      type: 'FeatureCollection',
      features: [{ type: 'Feature',
        geometry: { type: 'Point', coordinates: [(minX + maxX) / 2, maxY] },
        properties: { label: sbLabel } }],
    }});
    this.map.addLayer({ id: `${p}-sym`, type: 'symbol', source: `${p}-lbl`,
      layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-anchor': 'bottom',
                'text-offset': ['literal', [0, -0.3]],
                'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': '#60a5fa', 'text-halo-color': 'rgba(8,13,26,0.9)', 'text-halo-width': 1.5 } });

    this._mapLayerRegistry.push({
      layers:  [{ id: `${p}-fill`, type: 'fill' }, { id: `${p}-line`, type: 'line' },
                { id: `${p}-sym`,  type: 'symbol' }],
      sources: [`${p}-poly`, `${p}-lbl`],
      gen:     this._mapGen,
    });

    this.map.fitBounds([[minX, minY], [maxX, maxY]], { padding: 70, duration: 1200 });

    return '検索範囲を地図に描画しました';
  }

  /**
   * add_candidate_markers
   * Plots pins for each candidate POI. match_level determined mechanically from
   * _conditionTracker. Sorted by proximity distance (no arbitrary LLM ranking).
   */
  addCandidateMarkers(places) {
    this.candidateMarkers.forEach(m => m.remove());
    this.candidateMarkers = [];

    const totalConditions = this._conditionTracker.length;

    // Mechanical match_level + distance from proximity
    const processed = places.map(place => {
      let matchLevel = place.match_level || 'partial';
      if (totalConditions > 0) {
        const passed = this._conditionTracker.filter(s => s.has(place.name)).length;
        matchLevel = passed === totalConditions ? 'full' : 'partial';
      }
      return { ...place, match_level: matchLevel };
    }).sort((a, b) => {
      // full before partial, same-level order preserved
      if (a.match_level === 'full' && b.match_level !== 'full') return -1;
      if (a.match_level !== 'full' && b.match_level === 'full') return 1;
      return 0;
    });

    processed.forEach((place) => {
      const isFull = place.match_level === 'full';
      const badgeClass = isFull ? 'match-full' : 'match-partial';
      const badgeLabel = isFull ? '🟢 条件合致' : '🟡 一部合致';

      const el = document.createElement('div');
      el.className = `candidate-marker ${isFull ? 'priority-1' : 'priority-2'}`;
      // 番号なし - バッジのみ
      el.title = place.name;

      const popupHTML =
        `<div class="${badgeClass}">${badgeLabel}</div>` +
        `<strong>${_esc(place.name)}</strong>` +
        (place.address ? `<div class="popup-address">${_esc(place.address)}</div>` : '') +
        (place.reason  ? `<div class="popup-reason">💡 ${_esc(place.reason)}</div>` : '');

      const popup = new mapboxgl.Popup({ offset: 30, closeButton: false })
        .setHTML(popupHTML);

      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat(_safeLL(place.longitude, place.latitude))
        .setPopup(popup)
        .addTo(this.map);

      el.addEventListener('click', () => marker.togglePopup());
      this.candidateMarkers.push(marker);
    });

    if (processed.length === 1) {
      this.map.flyTo({ center: [processed[0].longitude, processed[0].latitude], zoom: 16, duration: 1000 });
    } else if (processed.length > 1) {
      const bounds = processed.reduce(
        (b, p) => b.extend([p.longitude, p.latitude]),
        new mapboxgl.LngLatBounds(
          [processed[0].longitude, processed[0].latitude],
          [processed[0].longitude, processed[0].latitude]
        )
      );
      this.map.fitBounds(bounds, { padding: 90, maxZoom: 17, duration: 1200 });
    }

    // Auto-open first full-match candidate
    const firstFull = processed.findIndex(p => p.match_level === 'full');
    const autoOpen = firstFull >= 0 ? firstFull : 0;
    if (processed.length >= 2 && this.candidateMarkers[autoOpen]) {
      setTimeout(() => this.candidateMarkers[autoOpen].togglePopup(), 1400);
    }

    const fullCount    = processed.filter(p => p.match_level === 'full').length;
    const partialCount = processed.filter(p => p.match_level === 'partial').length;
    return `条件合致${fullCount}件、一部合致${partialCount}件を地図にプロット`;
  }

  /**
   * clear_map_elements
   * Removes all search-boundary polygons and candidate markers.
   */
  clearMapElements() {
    this.candidateMarkers.forEach(m => m.remove());
    this.candidateMarkers = [];
    this._removeProbableArea();
    this._clearMapLayers();
    return 'マップ要素をクリアしました';
  }

  /**
   * finalize_location_marker
   * Plants the confirmed 📍 pin and flies the camera in.
   * @param {number} lat
   * @param {number} lng
   * @param {string} address
   */
  finalizeLocationMarker(lat, lng, address) {
    if (this.finalMarker) { this.finalMarker.remove(); this.finalMarker = null; }

    const el = document.createElement('div');
    el.className   = 'final-marker';
    el.textContent = '📍';

    const popup = new mapboxgl.Popup({ offset: [0, -20], closeOnClick: false })
      .setHTML(
        `<span class="popup-confirmed">確定</span>` +
        `<br><strong>${_esc(address)}</strong>` +
        `<div class="popup-address">${lat.toFixed(6)}, ${lng.toFixed(6)}</div>`
      );

    this.finalMarker = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat(_safeLL(lng, lat))
      .setPopup(popup)
      .addTo(this.map);

    this.finalMarker.togglePopup();

    this.map.flyTo({ center: _safeLL(lng, lat), zoom: 17, duration: 2000, essential: true });

    document.getElementById('mapStatus').textContent = `📍 ${address}`;

    this._finalizedDuringLoop = true; // ループ終了後にパネルを表示するフラグ
    return `確定: ${address} [${lat}, ${lng}]`;
  }

  _showResolutionPanel() {
    document.getElementById('resolutionPanel')?.remove();

    const container = document.getElementById('chatMessages');
    const wrapper = document.createElement('div');
    wrapper.id = 'resolutionPanel';
    wrapper.className = 'message resolution-panel';
    wrapper.innerHTML = `
      <div class="resolution-buttons">
        <button class="resolution-btn ok" id="resBtn-ok">✅ OK確定</button>
        <button class="resolution-btn retry" id="resBtn-retry">🔄 やり直し</button>
        <button class="resolution-btn give-up" id="resBtn-giveup">⏹ 諦める</button>
      </div>
    `;
    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;

    document.getElementById('resBtn-ok').addEventListener('click', () => {
      wrapper.remove();
      document.getElementById('mapStatus').textContent = '✅ 捜索完了';
      this._disableInput();
    });

    document.getElementById('resBtn-retry').addEventListener('click', () => {
      wrapper.remove();
      if (this.finalMarker) { this.finalMarker.remove(); this.finalMarker = null; }
      document.getElementById('mapStatus').textContent = '地図の準備ができました';
      this._enableInput();
    });

    document.getElementById('resBtn-giveup').addEventListener('click', () => {
      wrapper.remove();
      document.getElementById('mapStatus').textContent = '⏹ 未解決';
      this._disableInput();
    });
  }

  _disableInput() {
    document.getElementById('chatInput').disabled = true;
    document.getElementById('sendBtn').disabled = true;
  }

  _enableInput() {
    document.getElementById('chatInput').disabled = false;
    document.getElementById('sendBtn').disabled = false;
    document.getElementById('chatInput').focus();
  }

  // ─────────────────────────────────────────────────────────────
  // Internal: boundary layer cleanup
  // ─────────────────────────────────────────────────────────────

  _removeBoundaryLayers() {
    ['search-boundary-fill', 'search-boundary-line', 'sb-label-sym'].forEach(id => {
      try { this.map.removeLayer(id); } catch (_) {}
    });
    ['search-boundary', 'sb-label'].forEach(id => {
      try { this.map.removeSource(id); } catch (_) {}
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Debug visualization layers
  // ─────────────────────────────────────────────────────────────


  /** Initialize persistent GeoJSON sources/layers for debug visualization. */
  _initDebugLayers() {
    this._dbg = {
      proximity:   { type: 'FeatureCollection', features: [] },
      searchHits:  { type: 'FeatureCollection', features: [] },
      tqHits:      { type: 'FeatureCollection', features: [] },
      bboxes:      { type: 'FeatureCollection', features: [] },
      bboxLabels:  { type: 'FeatureCollection', features: [] },
      evalPolys:   { type: 'FeatureCollection', features: [] },  // Step2 isochrone/radius reach polygons
      clusters:    { type: 'FeatureCollection', features: [] },  // DBSCAN cluster centers
      routeBuf:    { type: 'FeatureCollection', features: [] },
      routeLine:   { type: 'FeatureCollection', features: [] },
      routeLabels: { type: 'FeatureCollection', features: [] },
    };

    const add = (id, data, layers) => {
      this.map.addSource(id, { type: 'geojson', data });
      layers.forEach(l => this.map.addLayer({ source: id, ...l }));
    };

    // Orange: proximity center point
    add('dbg-proximity', this._dbg.proximity, [{
      id: 'dbg-proximity-c', type: 'circle',
      paint: { 'circle-radius': 8, 'circle-color': '#f97316', 'circle-opacity': 0.95,
               'circle-stroke-width': 2, 'circle-stroke-color': '#fff' },
    }]);

    // Orange dashed: search bbox
    add('dbg-bboxes', this._dbg.bboxes, [{
      id: 'dbg-bboxes-l', type: 'line',
      paint: { 'line-color': '#f97316', 'line-width': 1.5,
               'line-dasharray': ['literal', [3, 2]], 'line-opacity': 0.75 },
    }]);

    // Purple: Step2 evaluation reach polygons (isochrone / radius circle)
    add('dbg-eval-polys', this._dbg.evalPolys, [
      { id: 'dbg-eval-polys-fill', type: 'fill',
        paint: { 'fill-color': '#8b5cf6', 'fill-opacity': 0.07 } },
      { id: 'dbg-eval-polys-line', type: 'line',
        paint: { 'line-color': '#a78bfa', 'line-width': 1, 'line-opacity': 0.5,
                 'line-dasharray': ['literal', [2, 2]] } },
    ]);

    // Teal: Search Box hit points + labels
    add('dbg-search-hits', this._dbg.searchHits, [
      {
        id: 'dbg-search-hits-c', type: 'circle',
        paint: { 'circle-radius': 5, 'circle-color': '#06b6d4', 'circle-opacity': 0.8,
                 'circle-stroke-width': 1, 'circle-stroke-color': '#fff' },
      },
      {
        id: 'dbg-search-hits-l', type: 'symbol',
        layout: {
          'text-field':            ['get', 'name'],
          'text-size':             10,
          'text-offset':           ['literal', [0.7, 0]],
          'text-anchor':           'left',
          'text-allow-overlap':    false,
          'text-ignore-placement': false,
          'text-max-width':        8,
        },
        paint: {
          'text-color':       '#06b6d4',
          'text-halo-color':  'rgba(8,13,26,0.85)',
          'text-halo-width':  1.2,
        },
      },
    ]);

    // Purple: Tilequery hit points + labels
    // Condition hits colored per-condition by `ci` (condition index), so target and each
    // condition_n are visually distinct in Step1 collection.
    const P = LocationFinderApp.COND_PALETTE;
    // wrap ci by palette length so it stays consistent with the legend (which also wraps)
    const condColor = ['match', ['%', ['coalesce', ['get', 'ci'], 0], P.length], ...P.flatMap((c, i) => [i, c]), P[0]];
    add('dbg-tq-hits', this._dbg.tqHits, [
      {
        id: 'dbg-tq-hits-c', type: 'circle',
        paint: { 'circle-radius': 5, 'circle-color': condColor, 'circle-opacity': 0.8,
                 'circle-stroke-width': 1, 'circle-stroke-color': '#fff' },
      },
      {
        id: 'dbg-tq-hits-l', type: 'symbol',
        layout: {
          'text-field':            ['get', 'name'],
          'text-size':             10,
          'text-offset':           ['literal', [0.7, 0]],
          'text-anchor':           'left',
          'text-allow-overlap':    false,
          'text-ignore-placement': false,
          'text-max-width':        8,
        },
        paint: {
          'text-color':       condColor,
          'text-halo-color':  'rgba(8,13,26,0.85)',
          'text-halo-width':  1.2,
        },
      },
    ]);

    // Violet: Route corridor buffer fill + route line
    // Primary = 不透明・太い / 代替ルート = 半透明・細い
    add('dbg-route-buf', this._dbg.routeBuf, [{
      id: 'dbg-route-buf-f', type: 'fill',
      paint: {
        'fill-color': '#8b5cf6',
        'fill-opacity': ['case', ['get', 'primary'], 0.15, 0.07],
      },
    }]);
    add('dbg-route-line', this._dbg.routeLine, [{
      id: 'dbg-route-line-l', type: 'line',
      paint: {
        'line-color': '#8b5cf6',
        'line-width':   ['case', ['get', 'primary'], 6, 3],
        'line-opacity': ['case', ['get', 'primary'], 1.0, 0.5],
        'line-dasharray': ['case', ['get', 'primary'], ['literal', [1]], ['literal', [4, 2]]],
      },
    }]);

    // Size labels for bboxes (shown outside top edge)
    const labelPaint = {
      'text-color':      '#f97316',
      'text-halo-color': 'rgba(8,13,26,0.9)',
      'text-halo-width': 1.5,
    };
    const labelLayout = (anchor, offset) => ({
      'text-field':            ['get', 'label'],
      'text-size':             11,
      'text-font':             ['literal', ['DIN Offc Pro Medium', 'Arial Unicode MS Bold']],
      'text-anchor':           anchor,
      'text-offset':           ['literal', offset],
      'text-allow-overlap':    true,
      'text-ignore-placement': true,
    });

    add('dbg-bbox-labels', this._dbg.bboxLabels, [{
      id: 'dbg-bbox-labels-sym', type: 'symbol',
      layout: labelLayout('bottom', [0, -0.4]),
      paint: labelPaint,
    }]);

    add('dbg-route-labels', this._dbg.routeLabels, [{
      id: 'dbg-route-labels-sym', type: 'symbol',
      layout: { ...labelLayout('left', [0.5, 0]), 'text-color': '#8b5cf6' },
      paint: { ...labelPaint, 'text-color': '#c084fc' },
    }]);

    // Cluster centers: hollow ring (no fill) + Cxx label
    // Deliberately NOT a filled circle to distinguish from candidate markers
    add('dbg-clusters', this._dbg.clusters, [
      {
        id: 'dbg-clusters-ring', type: 'circle',
        paint: {
          'circle-radius':         14,
          'circle-color':          'transparent',
          'circle-opacity':        0,
          'circle-stroke-width':   2.5,
          'circle-stroke-color':   '#f59e0b',
          'circle-stroke-opacity': 0.9,
        },
      },
      {
        id: 'dbg-clusters-label', type: 'symbol',
        layout: {
          'text-field':            ['concat', 'C', ['to-string', ['get', 'cid']]],
          'text-size':             10,
          'text-font':             ['literal', ['DIN Offc Pro Medium', 'Arial Unicode MS Bold']],
          'text-offset':           ['literal', [1.8, 0]],
          'text-anchor':           'left',
          'text-allow-overlap':    true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color':       '#f59e0b',
          'text-halo-color':  'rgba(8,13,26,0.9)',
          'text-halo-width':  1.2,
        },
      },
    ]);

    this._wireDebugInteractions();
  }

  /**
   * Hover → tooltip explaining what the element is; click → highlight the
   * corresponding step in the chat panel.
   */
  _wireDebugInteractions() {
    const specs = [
      { layer: 'dbg-proximity-c',    step: 'step-proximity', label: () => 'proximityアンカー（基準点）' },
      { layer: 'dbg-bboxes-l',       step: 'step-proximity', label: f => `検索範囲 bbox（${f?.properties?.label || ''}）` },
      { layer: 'dbg-eval-polys-fill',step: 'step-eval',      label: () => '評価範囲（isochrone/半径）' },
      { layer: 'dbg-search-hits-c',  step: 'step-collect',   label: f => `target候補: ${f?.properties?.name || ''}` },
      { layer: 'dbg-tq-hits-c',      step: 'step-collect',   label: f => `条件候補: ${f?.properties?.name || ''}` },
    ];
    const popup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 8, className: 'dbg-tip-popup' });
    for (const { layer, step, label } of specs) {
      if (!this.map.getLayer(layer)) continue;
      this.map.on('mouseenter', layer, () => { this.map.getCanvas().style.cursor = 'pointer'; });
      this.map.on('mousemove', layer, (e) => {
        const f = e.features?.[0];
        popup.setLngLat(e.lngLat).setHTML(`<div class="dbg-tip">${_esc(label(f))}</div>`).addTo(this.map);
      });
      this.map.on('mouseleave', layer, () => { this.map.getCanvas().style.cursor = ''; popup.remove(); });
      this.map.on('click', layer, () => this._highlightStep(step));
    }
  }

  /** Reset all debug layers to empty. */
  _clearDebugLayers() {
    if (!this._dbg) return;
    Object.keys(this._dbg).forEach(k => { this._dbg[k].features = []; });
    ['dbg-proximity','dbg-bboxes','dbg-bbox-labels','dbg-eval-polys','dbg-search-hits','dbg-clusters','dbg-tq-hits','dbg-route-buf','dbg-route-line','dbg-route-labels'].forEach(id => {
      try { this.map.getSource(id)?.setData({ type: 'FeatureCollection', features: [] }); } catch(_){}
    });
    // Reset any step isolation: make all debug layers visible again for the next run.
    this._isolatedStep = null;
    ['dbg-proximity-c','dbg-bboxes-l','dbg-bbox-labels-sym','dbg-search-hits-c','dbg-search-hits-l','dbg-tq-hits-c','dbg-tq-hits-l','dbg-clusters-ring','dbg-clusters-label','dbg-eval-polys-fill','dbg-eval-polys-line','dbg-route-buf-f','dbg-route-line-l','dbg-route-labels-sym'].forEach(lid => {
      try { if (this.map.getLayer(lid)) this.map.setLayoutProperty(lid, 'visibility', 'visible'); } catch(_){}
    });
    document.getElementById('mapLegend').style.display = 'none';
  }

  _dbgAddPoint(sourceId, stateKey, lng, lat, props = {}) {
    if (!this._dbg) return;
    this._dbg[stateKey].features.push({
      type: 'Feature', geometry: { type: 'Point', coordinates: _safeLL(lng, lat) }, properties: props,
    });
    try { this.map.getSource(sourceId)?.setData(this._dbg[stateKey]); } catch(_){}
    document.getElementById('mapLegend').style.display = 'block';
  }

  _dbgAddBbox(bbox) {
    if (!this._dbg || !bbox || bbox.length < 4) return;
    const [minX, minY, maxX, maxY] = bbox;
    this._dbg.bboxes.features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[[minX,minY],[maxX,minY],[maxX,maxY],[minX,maxY],[minX,minY]]] },
      properties: {},
    });
    try { this.map.getSource('dbg-bboxes')?.setData(this._dbg.bboxes); } catch(_){}

    // Size label at top-center of the bbox
    const midLat = (minY + maxY) / 2;
    const wm = Math.round(Math.abs(maxX - minX) * 111320 * Math.cos(midLat * Math.PI / 180));
    const hm = Math.round(Math.abs(maxY - minY) * 110540);
    const label = wm === hm ? `${wm}m` : `${wm}×${hm}m`;
    this._dbg.bboxLabels.features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [(minX + maxX) / 2, maxY] },
      properties: { label },
    });
    try { this.map.getSource('dbg-bbox-labels')?.setData(this._dbg.bboxLabels); } catch(_){}
    document.getElementById('mapLegend').style.display = 'block';
  }

  /** Visualize Search Box args (proximity/bbox) before the tool call. */
  _visualizeSearchArgs(toolName, args) {
    if (toolName === 'search_nearby_poi') {
      if (args.proximity?.length >= 2) {
        this._dbgAddPoint('dbg-proximity', 'proximity', args.proximity[0], args.proximity[1], { type: 'proximity' });
      }
      if (args.bbox) this._dbgAddBbox(args.bbox);
    }
    // Show A/B endpoints for route tool
    if (toolName === 'get_route_pois') {
      if (args.from_lat && args.from_lng)
        this._dbgAddPoint('dbg-proximity', 'proximity', args.from_lng, args.from_lat, { type: 'route_from' });
      if (args.to_lat && args.to_lng)
        this._dbgAddPoint('dbg-proximity', 'proximity', args.to_lng, args.to_lat, { type: 'route_to' });
    }
  }

  /** Visualize tool results (hit points) after the tool call. */
  _visualizeToolResult(toolName, resultStr) {
    try {
      const result = JSON.parse(resultStr);
      if (toolName === 'search_nearby_poi') {
        (result.items || []).forEach(item => {
          if (item.longitude != null && item.latitude != null) {
            this._dbgAddPoint('dbg-search-hits', 'searchHits', item.longitude, item.latitude, { name: item.name || '' });
          }
        });
      }
      if (toolName === 'scan_street_features' || toolName === 'get_facing_road') {
        (result.items || result.all_roads || []).forEach(item => {
          if (item.coords?.length >= 2) {
            this._dbgAddPoint('dbg-tq-hits', 'tqHits', item.coords[0], item.coords[1], { name: item.name || '', layer: item.layer || '' });
          }
        });
      }
      // Draw route corridor from stored geometry (not in result JSON)
      if (toolName === 'get_route_pois' && this.mapboxMCP._lastRouteData) {
        const { routesCoords, bufferMeters } = this.mapboxMCP._lastRouteData;
        this._drawRouteOnMap(routesCoords, bufferMeters);
        this.mapboxMCP._lastRouteData = null;
      }
    } catch(_) {}
  }

  /** Draw Directions API routes (primary + alternatives) + Turf buffer corridors on map. */
  _drawRouteOnMap(routesCoords, bufferMeters) {
    if (!routesCoords?.length) return;

    // Build FeatureCollections: primary route first, then alternatives
    const lineFeatures = routesCoords.map((coords, i) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: { primary: i === 0, route_index: i },
    }));
    const bufFeatures = routesCoords.map((coords, i) => {
      const f = turf.buffer(turf.lineString(coords), bufferMeters, { units: 'meters' });
      f.properties = { primary: i === 0, route_index: i };
      return f;
    });

    this._dbg.routeLine.features = lineFeatures;
    this._dbg.routeBuf.features  = bufFeatures;
    try {
      this.map.getSource('dbg-route-line')?.setData(this._dbg.routeLine);
      this.map.getSource('dbg-route-buf')?.setData(this._dbg.routeBuf);
    } catch(_) {}

    // Buffer width label at midpoint of primary route
    try {
      const primaryCoords = routesCoords[0];
      if (primaryCoords && primaryCoords.length >= 2) {
        const midIdx = Math.floor(primaryCoords.length / 2);
        const [midLng, midLat] = primaryCoords[midIdx];
        // Offset label slightly above the route
        const offsetLat = midLat + (bufferMeters / 110540) * 1.3;
        this._dbg.routeLabels.features = [{
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [midLng, offsetLat] },
          properties: { label: `±${bufferMeters}m` },
        }];
        this.map.getSource('dbg-route-labels')?.setData(this._dbg.routeLabels);
      }
    } catch(_) {}

    // Fit map to all routes combined
    const allCoords = routesCoords.flat();
    const bounds = allCoords.reduce(
      (b, c) => b.extend(c),
      new mapboxgl.LngLatBounds(allCoords[0], allCoords[0])
    );
    this.map.fitBounds(bounds, { padding: 100, maxZoom: 17, duration: 1000 });
    document.getElementById('mapLegend').style.display = 'block';
  }

  // ─────────────────────────────────────────────────────────────
  // Probable area polygon
  // ─────────────────────────────────────────────────────────────

  /**
   * show_probable_area: Draw a convex hull around candidates when Claude
   * cannot commit to a single location.
   */
  showProbableArea(candidates, message) {
    this._removeProbableArea();
    if (!candidates?.length) return 'candidates が空です';

    const pts = turf.featureCollection(
      candidates.map(c => turf.point(_safeLL(c.longitude, c.latitude)))
    );

    let area;
    try {
      if (candidates.length === 1) {
        area = turf.buffer(pts.features[0], 0.08, { units: 'kilometers' });
      } else {
        const hull = turf.convex(pts);
        area = hull
          ? turf.buffer(hull, 0.05, { units: 'kilometers' })
          : turf.buffer(turf.bboxPolygon(turf.bbox(pts)), 0.05, { units: 'kilometers' });
      }
    } catch(_) {
      area = turf.bboxPolygon(turf.bbox(pts));
    }

    const centroid = turf.centroid(area);
    const label    = message || 'この辺にいると思われます';

    this.map.addSource('probable-area', { type: 'geojson', data: area });
    this.map.addLayer({
      id: 'probable-area-fill', type: 'fill', source: 'probable-area',
      paint: { 'fill-color': '#ef4444', 'fill-opacity': 0.12 },
    });
    this.map.addLayer({
      id: 'probable-area-line', type: 'line', source: 'probable-area',
      paint: { 'line-color': '#ef4444', 'line-width': 2.5, 'line-dasharray': [5, 3] },
    });
    this.map.addSource('probable-area-label-src', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [{ ...centroid, properties: { label } }] },
    });
    this.map.addLayer({
      id: 'probable-area-label', type: 'symbol', source: 'probable-area-label-src',
      layout: {
        'text-field':            ['get', 'label'],
        'text-size':             13,
        'text-anchor':           'center',
        'text-allow-overlap':    true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color':       '#ef4444',
        'text-halo-color':  'rgba(8,13,26,0.92)',
        'text-halo-width':  2,
      },
    });

    this._probableAreaActive = true;

    const bbox = turf.bbox(area);
    this.map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 80, duration: 1200 });
    document.getElementById('mapStatus').textContent = `🔴 ${label}`;

    return `エリアをポリゴンで表示しました（${candidates.length}候補を包含）`;
  }

  _drawIsochroneLayer({ polygon, anchorLat, anchorLng, minutes, radiusMeters, profile }) {
    const idx = this._mapLayerRegistry.length;
    const p   = `iso-${idx}`;

    this.map.addSource(`${p}-poly`, { type: 'geojson', data: polygon });
    this.map.addLayer({ id: `${p}-fill`, type: 'fill', source: `${p}-poly`,
      paint: { 'fill-color': '#8b5cf6', 'fill-opacity': 0.12 } });
    this.map.addLayer({ id: `${p}-line`, type: 'line', source: `${p}-poly`,
      paint: { 'line-color': '#a78bfa', 'line-width': 2, 'line-dasharray': [4, 2] } });

    const center = turf.centroid(polygon);
    const [cLng, cLat] = center.geometry.coordinates;
    this.map.addSource(`${p}-lbl`, { type: 'geojson', data: {
      type: 'FeatureCollection',
      features: [{ type: 'Feature',
        geometry: { type: 'Point', coordinates: [cLng, cLat] },
        properties: { label: radiusMeters != null ? `${radiusMeters}m圏内` : `${minutes}分 (${profile === 'driving' ? '車' : '徒歩'})` } }],
    }});
    this.map.addLayer({ id: `${p}-sym`, type: 'symbol', source: `${p}-lbl`,
      layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-anchor': 'center',
                'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': '#a78bfa', 'text-halo-color': 'rgba(8,13,26,0.9)', 'text-halo-width': 1.5 } });

    this._mapLayerRegistry.push({
      layers:  [{ id: `${p}-fill`, type: 'fill' }, { id: `${p}-line`, type: 'line' }, { id: `${p}-sym`, type: 'symbol' }],
      sources: [`${p}-poly`, `${p}-lbl`],
      gen:     this._mapGen,
    });
  }

  _removeProbableArea() {
    ['probable-area-label', 'probable-area-fill', 'probable-area-line'].forEach(id => {
      try { this.map.removeLayer(id); } catch(_) {}
    });
    ['probable-area', 'probable-area-label-src'].forEach(id => {
      try { this.map.removeSource(id); } catch(_) {}
    });
    this._probableAreaActive = false;
  }

  // ─────────────────────────────────────────────────────────────
  // Map computation visualization
  // ─────────────────────────────────────────────────────────────

  /** Show map-side feedback while a tool is executing. */
  _showMapComputing(toolName, args) {
    const overlay = document.getElementById('mapComputing');
    const text    = document.getElementById('mapComputingText');
    const status  = document.getElementById('mapStatus');

    const labels = {
      get_midpoint_area:        `🗺 中間地点を計算中… (${args.placeA} ↔ ${args.placeB})`,
      search_nearby_poi:        `🔍 POI検索中… (${(Array.isArray(args.queries) ? args.queries : [args.queries].filter(Boolean)).slice(0,2).join(' / ')})`,
      scan_street_features:     `📡 半径 ${args.radius}m をスキャン中…`,
      draw_search_boundary:     '📐 検索範囲を描画中…',
      add_candidate_markers:    '📌 候補ピンを配置中…',
      clear_map_elements:       '🧹 マップをクリア中…',
      finalize_location_marker: '✅ 確定地点をマーク中…',
    };

    const msg = labels[toolName] || `${toolName} 実行中…`;
    if (text)   text.textContent   = msg;
    if (status) status.textContent = msg;
    if (overlay) overlay.style.display = 'flex';

    // Draw Tilequery radius circles on the map
    if (toolName === 'scan_street_features' && args.lat && args.lng) {
      const meta = { tool: toolName, turn: this._currentTurn, params: `r=${args.radius}m | target=${args.target || 'both'}` };
      this._drawScanCircle(args.lat, args.lng, args.radius, 'amber', meta);
      this.map.flyTo({ center: [args.lng, args.lat], zoom: Math.max(this.map.getZoom(), 14), duration: 800 });
    }

    if (toolName === 'scan_natural_features' && args.lat && args.lng) {
      const meta = { tool: toolName, turn: this._currentTurn, params: `r=${args.radius}m` };
      this._drawScanCircle(args.lat, args.lng, args.radius, 'amber', meta);
      this.map.flyTo({ center: [args.lng, args.lat], zoom: Math.max(this.map.getZoom(), 13), duration: 800 });
    }

    if (toolName === 'get_facing_road' && args.lat && args.lng) {
      const meta = { tool: toolName, turn: this._currentTurn, params: 'r=50m (自動拡張)' };
      this._drawScanCircle(args.lat, args.lng, 50, 'amber', meta);
      this.map.flyTo({ center: [args.lng, args.lat], zoom: Math.max(this.map.getZoom(), 16), duration: 600 });
    }

    if (toolName === 'evaluate_distance' && args.anchor_lat && args.anchor_lng) {
      this.map.flyTo({ center: [args.anchor_lng, args.anchor_lat], zoom: Math.max(this.map.getZoom(), 13), duration: 800 });
    }

    // search_nearby_poi: fly to proximity, draw all Tilequery grid circles
    if (toolName === 'search_nearby_poi' && args.proximity?.length >= 2) {
      const [pLng, pLat] = args.proximity;
      this._lastProximity = [pLng, pLat]; // track for distance sorting
      this.map.flyTo({ center: [pLng, pLat], zoom: Math.max(this.map.getZoom(), 13), duration: 800 });
      // radius_metersからbboxを計算（MCP側と同じロジック）
      let vizBbox = args.bbox;
      if (args.radius_meters != null && !vizBbox) {
        const r    = Math.min(args.radius_meters, 400);
        const dLng = r / (111320 * Math.cos(pLat * Math.PI / 180));
        const dLat = r / 110540;
        vizBbox = [pLng - dLng, pLat - dLat, pLng + dLng, pLat + dLat];
        // radius_meters使用時はClaudeがdraw_search_boundaryを呼べないため自動描画
        this.drawSearchBoundary(vizBbox);
      }

      if (vizBbox?.length === 4) {
        // Replicate _gridTilequeryPOI grid logic (with inset) to show actual scan circles
        const [minX, minY, maxX, maxY] = vizBbox;
        const gridRadius = 200;
        const spacingM   = gridRadius * 1.5;
        const DEG_LNG    = 1 / (111320 * Math.cos(pLat * Math.PI / 180));
        const DEG_LAT    = 1 / 110540;
        const radiusLng  = gridRadius * DEG_LNG;
        const radiusLat  = gridRadius * DEG_LAT;
        const gMinX = minX + radiusLng, gMaxX = maxX - radiusLng;
        const gMinY = minY + radiusLat, gMaxY = maxY - radiusLat;
        const qs = Array.isArray(args.queries) ? args.queries.slice(0, 2).join(', ') + (args.queries.length > 2 ? '…' : '') : '';
        const gridMeta = { tool: toolName, turn: this._currentTurn, params: `r=200m${qs ? ` | ${qs}` : ''}` };

        if (gMinX >= gMaxX || gMinY >= gMaxY) {
          this._drawScanCircle((minY + maxY) / 2, (minX + maxX) / 2, gridRadius, 'cyan', gridMeta);
        } else {
          const widthM  = (gMaxX - gMinX) / DEG_LNG;
          const heightM = (gMaxY - gMinY) / DEG_LAT;
          const nx = Math.max(1, Math.ceil(widthM  / spacingM) + 1);
          const ny = Math.max(1, Math.ceil(heightM / spacingM) + 1);
          for (let iy = 0; iy < ny; iy++) {
            for (let ix = 0; ix < nx; ix++) {
              const gLng = nx === 1 ? (gMinX + gMaxX) / 2 : gMinX + ix * (gMaxX - gMinX) / (nx - 1);
              const gLat = ny === 1 ? (gMinY + gMaxY) / 2 : gMinY + iy * (gMaxY - gMinY) / (ny - 1);
              this._drawScanCircle(gLat, gLng, gridRadius, 'cyan', gridMeta);
            }
          }
        }
      }
    }
  }

  /** Remove map computation visuals after a tool completes. */
  _hideMapComputing() {
    const overlay = document.getElementById('mapComputing');
    if (overlay) overlay.style.display = 'none';
  }

  /** Show a popup with layer metadata (tool, turn, params). */
  _showLayerPopup(lngLat, meta) {
    const toolLabel = LANG[this._lang]?.tools?.[meta.tool] || meta.tool;
    new mapboxgl.Popup({ closeButton: true, className: 'layer-info-popup', maxWidth: '240px' })
      .setLngLat(lngLat)
      .setHTML(
        `<div class="layer-popup-tool">${_esc(toolLabel)}</div>` +
        `<div class="layer-popup-turn">ターン ${meta.turn ?? '-'}</div>` +
        (meta.params ? `<div class="layer-popup-params">${_esc(meta.params)}</div>` : '')
      )
      .addTo(this.map);
  }

  /**
   * Draw a filled circle showing the Tilequery scan radius. Accumulates with generation tracking.
   * @param {string} color - 'amber' (single-point Tilequery) or 'cyan' (grid circles)
   * @param {object|null} meta - { tool, turn, params } for click popup
   */
  _drawScanCircle(lat, lng, radiusMeters, color = 'amber', meta = null) {
    const idx    = this._mapLayerRegistry.length;
    const p      = `scan-${idx}`;
    const center = turf.point([lng, lat]);
    const circleGeom = turf.circle(center, radiusMeters / 1000, { units: 'kilometers', steps: 64 });
    const circle = {
      ...circleGeom,
      properties: meta || {},
    };

    const fillColor = color === 'cyan' ? '#06b6d4' : '#f59e0b';
    const lineColor = color === 'cyan' ? '#22d3ee' : '#f59e0b';
    const dotColor  = color === 'cyan' ? '#06b6d4' : '#f59e0b';

    this.map.addSource(`${p}-poly`, { type: 'geojson', data: circle });
    this.map.addLayer({ id: `${p}-fill`, type: 'fill', source: `${p}-poly`,
      paint: { 'fill-color': fillColor, 'fill-opacity': 0.08 } });
    this.map.addLayer({ id: `${p}-line`, type: 'line', source: `${p}-poly`,
      paint: { 'line-color': lineColor, 'line-width': 1.5, 'line-dasharray': [3, 2] } });

    if (meta) {
      this.map.on('click', `${p}-fill`, (e) => this._showLayerPopup(e.lngLat, meta));
      this.map.on('mouseenter', `${p}-fill`, () => { this.map.getCanvas().style.cursor = 'pointer'; });
      this.map.on('mouseleave', `${p}-fill`, () => { this.map.getCanvas().style.cursor = ''; });
    }

    this.map.addSource(`${p}-ctr`, { type: 'geojson', data: {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: {} }],
    }});
    this.map.addLayer({ id: `${p}-dot`, type: 'circle', source: `${p}-ctr`,
      paint: { 'circle-radius': 4, 'circle-color': dotColor, 'circle-opacity': 0.9,
               'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });

    const degsNorth = radiusMeters / 110540;
    this.map.addSource(`${p}-lbl`, { type: 'geojson', data: {
      type: 'FeatureCollection',
      features: [{ type: 'Feature',
        geometry: { type: 'Point', coordinates: [lng, lat + degsNorth] },
        properties: { label: `r=${radiusMeters}m` } }],
    }});
    this.map.addLayer({ id: `${p}-sym`, type: 'symbol', source: `${p}-lbl`,
      layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-anchor': 'bottom',
                'text-offset': ['literal', [0, -0.3]],
                'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': lineColor, 'text-halo-color': 'rgba(8,13,26,0.9)', 'text-halo-width': 1.5 } });

    this._mapLayerRegistry.push({
      layers:  [{ id: `${p}-fill`, type: 'fill' }, { id: `${p}-line`, type: 'line' },
                { id: `${p}-dot`,  type: 'circle' }, { id: `${p}-sym`, type: 'symbol' }],
      sources: [`${p}-poly`, `${p}-ctr`, `${p}-lbl`],
      gen:     this._mapGen,
    });
  }

  /** Gray-out a single layer (called when it ages one generation). */
  _grayOutLayer(id) {
    const layer = this.map.getLayer(id);
    if (!layer) return;
    try {
      switch (layer.type) {
        case 'fill':
          this.map.setPaintProperty(id, 'fill-color',   '#6b7280');
          this.map.setPaintProperty(id, 'fill-opacity',  0.06);
          break;
        case 'line':
          this.map.setPaintProperty(id, 'line-color',   '#6b7280');
          this.map.setPaintProperty(id, 'line-opacity',  0.35);
          break;
        case 'circle':
          this.map.setPaintProperty(id, 'circle-color',        '#6b7280');
          this.map.setPaintProperty(id, 'circle-opacity',       0.4);
          this.map.setPaintProperty(id, 'circle-stroke-color', '#4b5563');
          break;
        case 'symbol':
          this.map.setPaintProperty(id, 'text-color',      '#6b7280');
          this.map.setPaintProperty(id, 'text-halo-color', 'rgba(8,13,26,0.5)');
          break;
      }
    } catch (_) {}
  }

  /**
   * Called when the user sends a new message.
   * Gen-1 layers → gray out. Gen-2+ layers → remove.
   */
  _advanceMapGen() {
    this._mapGen++;
    const keep = [];
    this._mapLayerRegistry.forEach(entry => {
      const age = this._mapGen - entry.gen;
      if (age === 1) {
        // gray out
        entry.layers.forEach(({ id }) => this._grayOutLayer(id));
        keep.push(entry);
      } else if (age >= 2) {
        // remove
        entry.layers.forEach(({ id }) => { try { this.map.removeLayer(id);  } catch (_) {} });
        entry.sources.forEach(id       => { try { this.map.removeSource(id); } catch (_) {} });
      } else {
        keep.push(entry);
      }
    });
    this._mapLayerRegistry = keep;
  }

  /** Remove all tracked map layers (used by clearMapElements / resetChat). */
  _clearMapLayers() {
    this._mapLayerRegistry.forEach(({ layers, sources }) => {
      layers.forEach(({ id }) => { try { this.map.removeLayer(id);  } catch (_) {} });
      sources.forEach(id     => { try { this.map.removeSource(id); } catch (_) {} });
    });
    this._mapLayerRegistry = [];
    this._mapGen = 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // Tool Aggregation
  // ═══════════════════════════════════════════════════════════════

  /**
   * Frontend map-visualization tool definitions (Claude schema).
   * Combined with mapboxMCP.listTools() to form the full tools array.
   */
  _getFrontendToolDefinitions() {
    return [
      {
        name: 'draw_search_boundary',
        description: '地図にBBOX検索範囲を描画する。探索エリア確定時に実行。',
        input_schema: {
          type: 'object',
          properties: { bbox: { type: 'array', items: { type: 'number' }, description: '[minX,minY,maxX,maxY]' } },
          required: ['bbox'],
        },
      },
      {
        name: 'add_candidate_markers',
        description: '条件に合致する候補を確度順の番号付きピンで地図にプロット。件数を絞らず該当するものをすべて渡すこと。places[0]が最有力候補。reason(根拠)を付記。最有力のポップアップは自動で開く。',
        input_schema: {
          type: 'object',
          properties: {
            places: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name:        { type: 'string' },
                  latitude:    { type: 'number' },
                  longitude:   { type: 'number' },
                  address:     { type: 'string' },
                  reason:      { type: 'string' },
                  match_level: {
                    type: 'string',
                    enum: ['full', 'partial'],
                    description: 'full=全条件合致、partial=一部条件合致。条件に合致しないものは渡さないこと。'
                  },
                },
                required: ['name', 'latitude', 'longitude'],
              },
            },
          },
          required: ['places'],
        },
      },
      {
        name: 'clear_map_elements',
        description: '地図の検索範囲ポリゴンと候補ピンをすべて消去する。確定フェーズ移行時に実行。',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'show_probable_area',
        description:
          '候補が2〜4件あり1点に絞れない場合、またはエリアは特定できるが具体的建物・住所が不明な場合に使用。候補を包含するエリアポリゴン（赤系）を地図に表示する。' +
          'finalize_location_markerとは異なり確定しない。add_candidate_markersと併用可能。messageには根拠（「〇〇と□□の間にいると思われます」等）を含めること。',
        input_schema: {
          type: 'object',
          properties: {
            candidates: {
              type: 'array',
              description: '候補地点の配列',
              items: {
                type: 'object',
                properties: {
                  latitude:  { type: 'number' },
                  longitude: { type: 'number' },
                },
                required: ['latitude', 'longitude'],
              },
            },
            message: { type: 'string', description: 'ポリゴン中央に表示するメッセージ' },
          },
          required: ['candidates'],
        },
      },
      {
        name: 'finalize_location_marker',
        description: '確定座標に赤ピンを立てポップアップと住所を表示しズームインする。候補1件のみ・オペレーター肯定応答・絞り込み根拠が揃った時点で即座にclear_map_elements→本ツールの順で実行すること（先延ばし禁止）。',
        input_schema: {
          type: 'object',
          properties: {
            lat:     { type: 'number' },
            lng:     { type: 'number' },
            address: { type: 'string' },
          },
          required: ['lat', 'lng', 'address'],
        },
      },
      {
        name: 'log_flow_step',
        description:
          '各フローステップの完了を記録する。ステップの順序を監視し、スキップや余分な実行を検出する。' +
          '必須ステップ: input_eval → primary_search → step1_main → step1_type_check → step1_conditions → step2_eval → result_present。' +
          'Step1以降を繰り返す場合: step1_prime → step2_eval → result_present。' +
          '結果: {ok, error?, action?} — errorがあればその指示に従うこと。',
        input_schema: {
          type: 'object',
          properties: {
            step: {
              type: 'string',
              enum: ['input_eval', 'primary_search', 'step1_main', 'step1_type_check', 'step1_conditions', 'step2_eval', 'result_present', 'step1_prime'],
              description: '完了したステップ名',
            },
            data: {
              type: 'object',
              description: '検証用データ',
              properties: {
                feature_type: { type: 'string', description: 'primary_search時のSearch Box feature_type' },
                candidate_count: { type: 'number', description: 'step1_main完了後の候補数' },
              },
            },
          },
          required: ['step'],
        },
      },
      {
        name: 'ask_choice',
        description: '探索対象が複数ある場合にオペレーターへ選択肢をボタン形式で提示し、どれをメインに探すか確認する。ユーザーの回答を待ってから探索を開始すること。',
        input_schema: {
          type: 'object',
          properties: {
            question: { type: 'string', description: '確認の質問文（例：「どちらを先に探しますか？」）' },
            choices:  {
              type: 'array',
              items: { type: 'string' },
              description: '選択肢ラベルの配列（例：["ホテル", "レンタカー屋"]）',
            },
          },
          required: ['question', 'choices'],
        },
      },
    ];
  }

  /**
   * Execute any tool — routes to frontend methods or MapboxMCPClient.
   *
   * @param {string} name  - Tool name
   * @param {object} args  - Tool arguments
   * @returns {Promise<string>} Result string (Minified JSON or status message)
   */
  async _executeTool(name, args) {
    switch (name) {
      case 'draw_search_boundary':
        return this.drawSearchBoundary(args.bbox);
      case 'add_candidate_markers':
        return this.addCandidateMarkers(args.places || []);
      case 'clear_map_elements':
        return this.clearMapElements();
      case 'show_probable_area':
        return this.showProbableArea(args.candidates || [], args.message);
      case 'finalize_location_marker':
        return this.finalizeLocationMarker(args.lat, args.lng, args.address);
      case 'log_flow_step':
        return this._logFlowStep(args.step, args.data || {});
      case 'ask_choice':
        return await this._showChoicePanel(args.question, args.choices || []);
      case 'evaluate_distance': {
        const result = await this.mapboxMCP.executeTool(name, args);
        if (this.mapboxMCP._lastIsochroneData) {
          this._drawIsochroneLayer(this.mapboxMCP._lastIsochroneData);
          this.mapboxMCP._lastIsochroneData = null;
        }
        // Track which candidates passed this condition
        try {
          const d = JSON.parse(result);
          if (d.inside_items) {
            this._conditionTracker.push(new Set(d.inside_items.map(i => i.name)));
          }
        } catch(_) {}
        return result;
      }
      default:
        return await this.mapboxMCP.executeTool(name, args);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // JS-Driven Entry Point (replaces agentic Claude loop)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Delegate to QueryEngine (JS-driven architecture).
   * @param {string} userText
   */
  async processUserMessage(userText) {
    this._resetFlowState();
    this._lastQuery = userText; // captured for ground-truth feedback rows
    this.map.flyTo({ zoom: 10, duration: 900, essential: true });
    await this.queryEngine.run(userText);
  }

  // ═══════════════════════════════════════════════════════════════
  // Legacy Claude AI Agent Loop (DEPRECATED — kept for reference)
  // ═══════════════════════════════════════════════════════════════

  /**
   * @deprecated Use processUserMessage → QueryEngine instead.
   * Retained temporarily for reference during migration.
   */
  async _legacyAgentLoop(userText) {
    this._conditionTracker = [];
    this._lastProximity    = null;
    this.messages.push({ role: 'user', content: userText });

    const allTools = [
      ...this.mapboxMCP.listTools(),
      ...this._getFrontendToolDefinitions(),
    ];

    // Reset map to overview on each new query
    this._clearDebugLayers();
    this.clearMapElements();
    if (this.finalMarker) { this.finalMarker.remove(); this.finalMarker = null; }
    this.map.flyTo({ zoom: 8, duration: 900, essential: true });

    PerfLogger.startQuery(userText);
    let turnCount       = 0;
    let hintRequested   = false;
    let maxTurns        = this.config.MAX_TOOL_TURNS;
    let toolTurnCount   = 0;  // counts only tool_use turns

    for (let turn = 0; turn < maxTurns; turn++) {

      // ── Hint request after MAX_HINT_TURNS tool calls ───────
      if (!hintRequested && toolTurnCount >= this.config.MAX_HINT_TURNS) {
        hintRequested = true;
        const hintText = await this._requestHintFromUser(allTools);
        if (hintText) {
          this.messages.push({ role: 'user', content: hintText });
          this.addMessage('user', hintText);
          maxTurns = turn + 1 + this.config.HINT_EXTRA_TURNS;
        }
        // Whether hint provided or not, continue (Claude may finalize)
      }
      turnCount++;
      this._updateThinking(`Claude API (ターン ${turn + 1})…`);

      // ── Claude API call ────────────────────────────────────────
      const apiHandle = PerfLogger.startOp(`Claude API ターン ${turn + 1}`);
      const apiStep   = this._addThinkingStep(`🤖 Claude API (ターン ${turn + 1})`);

      let res;
      try {
        res = await fetch(this.config.CLAUDE_API_PROXY, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            model:       this.config.CLAUDE_MODEL,
            max_tokens:  this.config.MAX_TOKENS,
            temperature: this.config.TEMPERATURE ?? 0,
            system:      POSITION_AGENT_PROMPT,
            messages:    this.messages,
            tools:       allTools,
          }),
        });
      } catch (err) {
        throw new Error(`ネットワークエラー: ${err.message}`);
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        throw new Error(`API Error ${res.status}: ${errText}`);
      }

      const data = await res.json();
      const usage = data.usage || {};
      this._tokens.input  += usage.input_tokens  || 0;
      this._tokens.output += usage.output_tokens || 0;
      this._updateTokenDisplay();

      const apiElapsed = PerfLogger.endOp(
        apiHandle,
        `in=${usage.input_tokens ?? '?'} out=${usage.output_tokens ?? '?'} stop=${data.stop_reason}`
      );
      this._resolveThinkingStep(
        apiStep,
        `${apiElapsed}s · in:${usage.input_tokens ?? '?'} out:${usage.output_tokens ?? '?'}`
      );

      // Extract text blocks
      const textContent = (data.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');

      this.messages.push({ role: 'assistant', content: data.content });
      // Compress tool_results Claude just consumed to save tokens in future turns
      this._compressLastToolResults();

      // ── end_turn ───────────────────────────────────────────────
      if (data.stop_reason === 'end_turn') {
        if (textContent) this.addMessage('assistant', textContent);
        break;
      }

      // ── max_tokens: 出力トークン上限に到達 ────────────────────
      if (data.stop_reason === 'max_tokens') {
        if (textContent) this.addMessage('assistant', textContent);
        this.addMessage('error', '⚠️ 出力トークン上限に達しました。MAX_TOKENSを増やすか、クエリを分割してください。');
        break;
      }

      // ── tool_use ───────────────────────────────────────────────
      if (data.stop_reason === 'tool_use') {
        toolTurnCount++;
        if (textContent) this.addMessage('thinking-msg', textContent);

        const toolUseBlocks = (data.content || []).filter(b => b.type === 'tool_use');
        const toolResults   = [];

        this._currentTurn = turn + 1;

        // 複数ツールが返された場合、デバッグモード以外では並列実行
        const parallel = !this._debugMode && toolUseBlocks.length > 1;

        if (parallel) {
          this._updateThinking(`⚡ ${toolUseBlocks.length}件 並列実行中…`);
          const parallelSteps = toolUseBlocks.map(tu =>
            this._addThinkingStep(`${getToolLabel(tu.name, this._lang)} (並列)`)
          );

          const results = await Promise.all(toolUseBlocks.map(async (tu, i) => {
            const toolHandle = PerfLogger.startOp(`Tool: ${tu.name}`);
            const result = await this._executeTool(tu.name, tu.input);
            this._updateAPICountDisplay();
            const elapsed = PerfLogger.endOp(toolHandle);
            this._resolveThinkingStep(parallelSteps[i], elapsed + 's');
            return result;
          }));

          this._hideMapComputing();
          toolUseBlocks.forEach((tu, i) => {
            toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: results[i] });
          });
        } else {
          // 逐次実行（デバッグモード or 単一ツール）
          for (const tu of toolUseBlocks) {
            const label = getToolLabel(tu.name, this._lang);
            this._updateThinking(label);
            const toolStep   = this._addThinkingStep(label);
            const toolHandle = PerfLogger.startOp(`Tool: ${tu.name}`);
            this._showMapComputing(tu.name, tu.input);
            if (this._debugMode) this._visualizeSearchArgs(tu.name, tu.input);

            const result = await this._executeTool(tu.name, tu.input);

            this._hideMapComputing();
            if (this._debugMode) this._visualizeToolResult(tu.name, result);
            this._updateAPICountDisplay();
            const toolElapsed = PerfLogger.endOp(toolHandle);
            this._resolveThinkingStep(toolStep, toolElapsed + 's');

            if (this._debugMode) {
              await this._debugPause(tu.name, tu.input, result);
            }

            toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
          }
        }

        this.messages.push({ role: 'user', content: toolResults });

        // Warn Claude when the next turn is the last so it finalizes
        if (turn === maxTurns - 2) {
          const lastTurnWarning = this._lang === 'ja'
            ? 'これ以上ツールを呼ぶことができません。現在の情報で最も可能性の高い候補をadd_candidate_markersかfinalize_location_markerで表示してください。'
            : 'No more tool calls available. Please show the most likely candidates using add_candidate_markers or finalize_location_marker based on current findings.';
          this.messages.push({ role: 'user', content: lastTurnWarning });
        }

      } else {
        if (textContent) this.addMessage('assistant', textContent);
        break;
      }
    }

    const totalSec = PerfLogger.endQuery(turnCount);
    this.addMessage('tool-status', `⏱ 完了: ${totalSec}s / APIターン ${turnCount}回`);

    if (this._finalizedDuringLoop) {
      this._finalizedDuringLoop = false;
      document.getElementById('resolutionPanel')?.remove();
      this._showResolutionPanel();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // UI Helpers
  // ═══════════════════════════════════════════════════════════════

  /**
   * Append a message bubble to the chat panel.
   *
   * @param {'user'|'assistant'|'thinking-msg'|'tool-status'|'error'} role
   * @param {string} text
   */
  addMessage(role, text) {
    const container = document.getElementById('chatMessages');

    const t = LANG[this._lang];
    const roleLabels = {
      user:           t.roleUser,
      assistant:      t.roleAssistant,
      'thinking-msg': t.roleThinking,
      'tool-status':  t.roleTool,
      error:          t.roleError,
    };

    const wrapper = document.createElement('div');
    wrapper.className = `message ${role}`;

    if (roleLabels[role]) {
      const lbl = document.createElement('div');
      lbl.className   = 'msg-label';
      lbl.textContent = roleLabels[role];
      wrapper.appendChild(lbl);
    }

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.innerHTML = _formatMsg(text);
    wrapper.appendChild(bubble);

    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;
  }

  // ─────────────────────────────────────────────────────────────
  // Token optimization: compress consumed tool results
  // ─────────────────────────────────────────────────────────────

  /**
   * After Claude processes tool results, replace the raw JSON with a compact
   * summary. We walk backwards to find the most recent tool_result user message,
   * look up the matching tool_use block in the preceding assistant message
   * to know the tool name, then compress.
   */
  _compressLastToolResults() {
    // Find the most recent tool_result user message (skip the very last message
    // since that's the assistant response we just added)
    for (let i = this.messages.length - 2; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
      if (!msg.content.some(b => b.type === 'tool_result')) continue;

      // Build tool_use_id → { name, input } map from the preceding assistant message
      const toolNameMap = {};
      const prevAssist = i > 0 ? this.messages[i - 1] : null;
      if (prevAssist?.role === 'assistant' && Array.isArray(prevAssist.content)) {
        prevAssist.content
          .filter(b => b.type === 'tool_use')
          .forEach(b => { toolNameMap[b.id] = { name: b.name, input: b.input }; });
      }

      // Compress each tool_result block
      msg.content = msg.content.map(b => {
        if (b.type !== 'tool_result') return b;
        const toolMeta  = toolNameMap[b.tool_use_id] || {};
        const toolName  = toolMeta.name || 'unknown';
        const toolInput = toolMeta.input || {};
        const compressed = this._summarizeToolResult(toolName, b.content, toolInput);
        if (this.config.DEBUG && compressed !== b.content) {
          const before = b.content?.length ?? 0;
          const after  = compressed?.length ?? 0;
          console.log(`[TokenOpt] ${toolName}: ${before}c → ${after}c (-${Math.round((1 - after/before)*100)}%)`);
        }
        return { ...b, content: compressed };
      });
      break;
    }
  }

  /**
   * Return a compact JSON string retaining only the fields Claude
   * might need to reference in later turns.
   */
  _summarizeToolResult(toolName, content, toolInput = {}) {
    try {
      const d = JSON.parse(content);
      if (d.error) return JSON.stringify({ error: d.error });

      switch (toolName) {
        case 'search_nearby_poi': {
          const isPrimary = toolInput.purpose === 'primary_search';
          // primary_search は上位3件のみ渡す（Step1以降への汚染防止）
          const rawItems = d.items || [];
          const items = isPrimary ? rawItems.slice(0, 3) : rawItems;
          return JSON.stringify({
            source: d.source,
            count:  items.length,
            items: items.map(i => ({
              id:   i._rid,
              name: i.name,
              ...(isPrimary ? {} : { latitude: i.latitude, longitude: i.longitude }),
              ...(i.feature_type ? { feature_type: i.feature_type } : {}),
              ...(i.bbox         ? { bbox:         i.bbox }         : {}),
            })),
          });
        }

        case 'scan_street_features':
          return JSON.stringify({
            source: d.source, layers: d.layers, count: d.count,
            // Keep name + class/stop_type + coords for spatial reference
            items: (d.items || []).map(i => ({
              layer:     i.layer,
              ...(i.name      ? { name:      i.name }      : {}),
              ...(i.class     ? { class:     i.class }     : {}),
              ...(i.stop_type ? { stop_type: i.stop_type } : {}),
              ...(i.mode      ? { mode:      i.mode }      : {}),
              ...(i.coords    ? { coords:    i.coords }    : {}),
            })),
          });

        case 'get_facing_road':
          return JSON.stringify({
            found:        d.found,
            primary_road: d.primary_road
              ? { name: d.primary_road.name, class: d.primary_road.class }
              : null,
            road_classes: d.road_classes,
            radius_used:  d.radius_used,
          });

        case 'get_midpoint_area':
          // Already compact
          return content;

        case 'get_route_pois':
          return JSON.stringify({
            source:         d.source,
            profile:        d.profile,
            route_count:    d.route_count,
            matching_count: d.matching_count,
            matching_pois:  d.matching_pois,
            excluded_pois:  (d.excluded_pois || []).map(p => ({ name: p.name })),
          });

        default:
          // Map tools return short strings — keep as-is
          return content;
      }
    } catch (_) {
      return content; // parse failed, keep original
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Hint request system
  // ─────────────────────────────────────────────────────────────

  /**
   * Ask Claude what information would help, then show a text input for the operator.
   * Returns the operator's hint text, or null if skipped.
   */
  async _requestHintFromUser(allTools) {
    this._updateThinking('💭 追加情報のリクエストを生成中...');

    // Ask Claude (no tools) what it needs
    let hintMessage = '';
    try {
      const res = await fetch(this.config.CLAUDE_API_PROXY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model:      this.config.CLAUDE_MODEL,
          max_tokens: 400,
          system:     POSITION_AGENT_PROMPT,
          messages: [
            ...this.messages,
            {
              role: 'user',
              content: '複数回の検索を行いましたが、まだ結果を確定できていません。' +
                       '重要: 候補が複数見つかっていてもそれは正常です。絞り込みを求めてはいけません。' +
                       '追加情報が必要なのは「検索自体がうまくいっていない」場合のみです。' +
                       'Step2（評価フェーズ）がまだなら追加情報ではなくStep2を実行してください。' +
                       'もし本当に詰まっている場合のみ、今の状況を1文で説明した上で足りない情報を1点だけ聞いてください。' +
                       'ツールは呼ばず、オペレーターへのメッセージのみ返答してください。',
            },
          ],
          // No tools → force text response
        }),
      });
      if (res.ok) {
        const data = await res.json();
        hintMessage = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      }
    } catch(_) {}

    if (!hintMessage) return null;

    return new Promise(resolve => {
      this._hintResolve = resolve;
      this._showHintPanel(hintMessage, resolve);
      this._updateThinking('⏸ オペレーターからの追加情報を待っています...');
    });
  }

  /** Render the hint request panel in chat and wait for operator input. */
  _showHintPanel(claudeMessage, onResponse, suggestions) {
    const container = document.getElementById('chatMessages');
    const uid = `hint-${Date.now()}`;

    const ht = LANG[this._lang];
    // [L3] agent suggestion buttons (differentiating landmarks). Each is an object
    // { text, landmark, items } carrying its resolved poi_label items (no re-query).
    const sugList = Array.isArray(suggestions) ? suggestions.filter(s => s && s.text) : [];
    const sugTitle = this._lang === 'en' ? '💡 Agent suggestions' : '💡 エージェントからの提案';
    const sugHTML = sugList.length
      ? `<div class="hint-suggest-title">${sugTitle}</div><div class="hint-suggest" id="${uid}-sug">` +
        sugList.map((s, i) => `<button class="choice-btn hint-suggest-btn" data-i="${i}">${_esc(s.text)}</button>`).join('') +
        `</div>`
      : '';
    const wrapper = document.createElement('div');
    wrapper.className = 'message hint-request';
    wrapper.innerHTML = `
      <div class="msg-label">${ht.hintTitle(this.config.HINT_EXTRA_TURNS)}</div>
      <div class="hint-bubble">
        <div class="hint-question">${_formatMsg(claudeMessage)}</div>
        ${sugHTML}
        <textarea id="${uid}-input" class="hint-input" placeholder="${ht.hintPlaceholder}" rows="3"></textarea>
        <div class="hint-actions">
          <button class="hint-submit-btn" id="${uid}-ok">${ht.hintSubmit}</button>
          <button class="hint-skip-btn"   id="${uid}-skip">${ht.hintSkip}</button>
        </div>
      </div>
    `;
    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;

    // Suggestion click = submit that suggestion as the hint.
    if (sugList.length) {
      wrapper.querySelectorAll('.hint-suggest-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const s = sugList[+btn.dataset.i];
          document.getElementById(`${uid}-input`).disabled = true;
          document.getElementById(`${uid}-ok`).disabled    = true;
          document.getElementById(`${uid}-skip`).style.display = 'none';
          wrapper.querySelectorAll('.hint-suggest-btn').forEach(b => { b.disabled = true; });
          this.addMessage('user', s.text);
          this._hintResolve = null;
          onResponse(s); // resolve with the suggestion object (carries resolved items)
        });
      });
    }

    document.getElementById(`${uid}-ok`).addEventListener('click', () => {
      const text = document.getElementById(`${uid}-input`).value.trim();
      if (!text) return;
      document.getElementById(`${uid}-input`).disabled = true;
      document.getElementById(`${uid}-ok`).disabled    = true;
      document.getElementById(`${uid}-ok`).textContent = LANG[this._lang].hintDone;
      document.getElementById(`${uid}-skip`).style.display = 'none';
      this._hintResolve = null;
      onResponse(text);
    });

    document.getElementById(`${uid}-skip`).addEventListener('click', () => {
      document.getElementById(`${uid}-input`).disabled   = true;
      document.getElementById(`${uid}-ok`).disabled      = true;
      document.getElementById(`${uid}-skip`).disabled    = true;
      wrapper.querySelector('.hint-bubble').style.opacity = '0.5';
      this._hintResolve = null;
      onResponse(null);
    });
  }

  _logFlowStep(step, data = {}) {
    if (!this._flowState) this._resetFlowState();

    const VALID_SEQUENCE = ['input_eval', 'primary_search', 'step1_main', 'step1_type_check', 'step1_conditions', 'step2_eval', 'result_present'];

    if (step !== 'step1_prime' && this._flowState.completed.includes(step)) {
      return JSON.stringify({
        ok: false,
        error: `ステップ "${step}" は既に実行済みです。重複実行は禁止されています。`,
      });
    }

    if (step === 'primary_search' && data.feature_type) {
      const TOO_BROAD = ['place', 'region', 'country', 'district'];
      if (TOO_BROAD.includes(data.feature_type)) {
        return JSON.stringify({
          ok: false,
          error: `地理的範囲が広すぎます（feature_type: ${data.feature_type}）。`,
          action: 'オペレーターに「もう少し具体的な地名・駅名・施設名を教えてください」と質問すること。',
        });
      }
    }

    // step1_main開始時にプライマリ検索IDをバッファから削除（Step1への汚染防止）
    if (step === 'step1_main') {
      if (this.mapboxMCP?._primarySearchIds?.size > 0) {
        this.mapboxMCP._primarySearchIds.forEach(id => this.mapboxMCP._resultBuffer.delete(id));
        this.mapboxMCP._primarySearchIds.clear();
      }
    }

    if (step === 'step1_main' && data.candidate_count != null) {
      if (data.candidate_count > 30) {
        return JSON.stringify({
          ok: false,
          error: `候補が多すぎます（${data.candidate_count}件）。`,
          action: 'Step2評価を開始する前に、オペレーターに絞り込み条件の追加を求めること。',
        });
      }
      this._flowState.step1MainCount = data.candidate_count;
    }

    // ① type_checkのbefore/after整合性チェック
    if (step === 'step1_type_check') {
      const before = data.before_count;
      const after  = data.after_count;
      if (before == null || after == null) {
        return JSON.stringify({
          ok: false,
          error: 'step1_type_checkにはbefore_countとafter_countの指定が必須です。',
          action: 'log_flow_step("step1_type_check", {before_count: <型確認前件数>, after_count: <型確認後件数>}) を呼ぶこと。',
        });
      }
      if (after > before) {
        return JSON.stringify({ ok: false, error: `型確認後の候補数(${after})が型確認前(${before})より多くなっています。` });
      }
      this._flowState.typeCheckAfterCount = after;
    }

    // step2_eval開始時にconditionTrackerをリセット（ループ蓄積バグ防止）
    if (step === 'step2_eval') {
      this._conditionTracker = [];
    }

    // ② step2_evalの評価数がtype_checkのafterと一致するか
    if (step === 'step2_eval') {
      const evaluated   = data.evaluated_count;
      const conditions  = data.conditions_checked;
      const expected    = this._flowState.typeCheckAfterCount;
      if (evaluated != null && expected != null && evaluated !== expected) {
        return JSON.stringify({
          ok: false,
          error: `評価した候補数(${evaluated})が型確認後の候補数(${expected})と一致しません。全候補を評価してください。`,
        });
      }
      if (conditions != null && conditions === 0) {
        return JSON.stringify({ ok: false, error: '条件が1つも評価されていません。evaluate_distanceを実行してください。' });
      }
    }

    if (!this._flowState.loopStarted) {
      const expectedIdx = VALID_SEQUENCE.indexOf(step);
      const lastIdx = this._flowState.completed.length > 0
        ? VALID_SEQUENCE.indexOf(this._flowState.completed[this._flowState.completed.length - 1])
        : -1;
      if (expectedIdx !== -1 && expectedIdx !== lastIdx + 1) {
        const expected = VALID_SEQUENCE[lastIdx + 1];
        return JSON.stringify({
          ok: false,
          error: `ステップの順序が正しくありません。"${expected}" を先に実行してください。`,
        });
      }
    }

    if (step === 'step1_prime') {
      this._flowState.loopStarted = true;
      this._flowState.loopCompleted = [];
    }

    this._flowState.completed.push(step);
    if (this._flowState.loopStarted) {
      this._flowState.loopCompleted.push(step);
    }

    return JSON.stringify({ ok: true, completed: this._flowState.completed });
  }

  _resetFlowState() {
    this._flowState = { completed: [], loopStarted: false, loopCompleted: [] };
  }

  // ─────────────────────────────────────────────────────────────
  // Choice panel
  // ─────────────────────────────────────────────────────────────

  /**
   * Show choice buttons in chat and wait for operator selection.
   * Returns the selected choice string as the tool result.
   */
  _showChoicePanel(question, choices) {
    return new Promise(resolve => {
      const container = document.getElementById('chatMessages');
      const uid = `choice-${Date.now()}`;

      const wrapper = document.createElement('div');
      wrapper.className = 'message choice-request';
      wrapper.innerHTML = `
        <div class="msg-label">🔀 選択</div>
        <div class="choice-bubble">
          <div class="choice-question">${_formatMsg(question)}</div>
          <div class="choice-buttons" id="${uid}-btns">
            ${choices.map((c, i) =>
              `<button class="choice-btn" id="${uid}-btn-${i}">${_esc(c)}</button>`
            ).join('')}
          </div>
        </div>
      `;
      container.appendChild(wrapper);
      container.scrollTop = container.scrollHeight;

      choices.forEach((choice, i) => {
        document.getElementById(`${uid}-btn-${i}`).addEventListener('click', () => {
          // Disable all buttons after selection
          choices.forEach((_, j) => {
            const btn = document.getElementById(`${uid}-btn-${j}`);
            if (btn) {
              btn.disabled = true;
              btn.classList.toggle('choice-btn-selected', j === i);
            }
          });
          this.addMessage('user', choice);
          // Return the RAW choice string (QueryEngine matches it by index).
          // (Old agentic loop used a "選択: " prefix; that broke index matching.)
          resolve(choice);
        });
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Debug step mode
  // ─────────────────────────────────────────────────────────────

  /**
   * Pause the agentic loop until the user clicks "▶ 次のステップへ".
   * Shows a summary of the tool call + result in the chat.
   */
  _debugPause(toolName, toolInput, resultStr) {
    return new Promise(resolve => {
      this._debugStepResolve = resolve;

      // Build result summary for display
      let summary = '';
      try {
        const r = JSON.parse(resultStr);
        if (typeof r === 'string') {
          summary = r.slice(0, 60);
        } else if (r.count != null) {
          summary = `${r.count}件取得（${r.source || ''}）`;
        } else if (r.found != null) {
          summary = r.found
            ? `検出: ${r.primary_road?.name || r.road_classes || '不明'}`
            : '未検出';
        } else if (r.matching_count != null) {
          summary = `経路沿い ${r.matching_count}件 / 除外 ${(r.excluded_pois||[]).length}件`;
        } else if (r.error) {
          summary = `エラー: ${r.error}`;
        } else {
          summary = JSON.stringify(r).slice(0, 80);
        }
      } catch(_) { summary = String(resultStr).slice(0, 80); }

      // Build input summary
      let inputSummary = '';
      try {
        const inp = toolInput || {};
        if (inp.queries)  inputSummary = `queries: [${(inp.queries || []).slice(0,2).join(', ')}…]`;
        else if (inp.lat) inputSummary = `lat=${inp.lat?.toFixed(4)}, lng=${inp.lng?.toFixed(4)}, r=${inp.radius}m`;
        else if (inp.placeA) inputSummary = `${inp.placeA} ↔ ${inp.placeB}`;
        else if (inp.from_lat) inputSummary = `from→to, profile=${inp.profile}`;
        else if (inp.bbox) inputSummary = `bbox=[${(inp.bbox||[]).map(v=>v.toFixed(3)).join(',')}]`;
      } catch(_) {}

      // Create pause message element
      const pauseId = `debug-next-${this._debugPauseCount++}`;

      // Build tabs HTML for search_nearby_poi
      let tabsHtml = '';
      if (toolName === 'search_nearby_poi') {
        try {
          const r = JSON.parse(resultStr);
          const dbg = r._debug;
          if (dbg) {
            const renderList = (items) => (items || []).length
              ? (items || []).map(i => `<div class="debug-poi-item"><span class="debug-poi-name">${_esc(i.name)}</span><span class="debug-poi-dist">${i.distance ?? '-'}m</span></div>`).join('')
              : '<div class="debug-poi-empty">0件</div>';

            tabsHtml = `
              <div class="debug-tabs">
                <div class="debug-tab-bar">
                  <button class="debug-tab active" data-tab="sb">Search Box (${dbg.sb_count})</button>
                  <button class="debug-tab" data-tab="tq">Tilequery (${dbg.tq_count})</button>
                  <button class="debug-tab" data-tab="all">合計 (${r.count})</button>
                </div>
                <div class="debug-tab-content" id="${pauseId}-tab-sb">${renderList(dbg.sb_items)}</div>
                <div class="debug-tab-content" id="${pauseId}-tab-tq" style="display:none">${renderList(dbg.tq_items)}</div>
                <div class="debug-tab-content" id="${pauseId}-tab-all" style="display:none">${renderList([...(dbg.sb_items||[]), ...(dbg.tq_items||[])])}</div>
              </div>
            `;
          }
        } catch(_) {}
      }
      const container = document.getElementById('chatMessages');
      const wrapper = document.createElement('div');
      wrapper.className = 'message debug-pause';
      wrapper.innerHTML = `
        <div class="msg-label">⏸ デバッグ停止</div>
        <div class="debug-pause-bubble">
          <div class="debug-tool-name">${getToolLabel(toolName, this._lang)}</div>
          ${inputSummary ? `<div class="debug-input-summary">入力: ${_esc(inputSummary)}</div>` : ''}
          <div class="debug-result-summary">結果: ${_esc(summary)}</div>
          ${tabsHtml}
          <button class="debug-next-btn" id="${pauseId}">▶ 次のステップへ</button>
        </div>
      `;
      container.appendChild(wrapper);
      container.scrollTop = container.scrollHeight;

      // Update thinking bar
      this._updateThinking('⏸ デバッグ一時停止 — 地図を確認してから「次のステップへ」をクリック');

      document.getElementById(pauseId).addEventListener('click', () => {
        document.getElementById(pauseId).disabled = true;
        document.getElementById(pauseId).textContent = '✓ 続行';
        this._debugStepResolve = null;
        resolve();
      });

      wrapper.querySelectorAll('.debug-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          wrapper.querySelectorAll('.debug-tab').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          const target = tab.dataset.tab;
          wrapper.querySelectorAll('.debug-tab-content').forEach(c => c.style.display = 'none');
          const content = document.getElementById(`${pauseId}-tab-${target}`);
          if (content) content.style.display = 'block';
        });
      });
    });
  }

  _toggleLanguage() {
    this._lang = this._lang === 'ja' ? 'en' : 'ja';
    this._applyLanguage(this._lang);
  }

  _applyLanguage(lang) {
    const t = LANG[lang];
    if (!t) return;

    // Toggle button — shows current language (header + settings modal stay in sync)
    const btn = document.getElementById('lang-toggle');
    if (btn) btn.textContent = t.langBtn;
    const sBtn = document.getElementById('settingsLangBtn');
    if (sBtn) sBtn.textContent = t.langBtn;

    // App title
    const titleEl = document.getElementById('app-title');
    if (titleEl) titleEl.textContent = t.appTitle;

    // Textarea placeholder
    const input = document.getElementById('chatInput');
    if (input) input.placeholder = t.placeholder;

    // Clear chat button
    const clearBtn = document.getElementById('clearChatBtn');
    if (clearBtn) clearBtn.textContent = t.clearChat;

    // Debug toggle button (respect current state)
    const dbgBtn = document.getElementById('debugToggleBtn');
    if (dbgBtn) dbgBtn.textContent = this._debugMode ? t.debugOn : t.debugOff;

    // Examples label
    const exLabel = document.getElementById('examples-label');
    if (exLabel) exLabel.textContent = t.examplesLabel;

    // Example chips: show correct language text + update data-q
    document.querySelectorAll('.example-chip').forEach(chip => {
      const q = chip.dataset[`q${lang.charAt(0).toUpperCase() + lang.slice(1)}`] || chip.dataset.q;
      if (q) chip.dataset.q = q;
      chip.querySelector('.chip-text-ja').style.display = lang === 'ja' ? '' : 'none';
      chip.querySelector('.chip-text-en').style.display = lang === 'en' ? '' : 'none';
    });

    // Settings modal (all sections)
    const st = t.settings;
    if (st) {
      const setText = (id, v) => { const e = document.getElementById(id); if (e && v != null) e.textContent = v; };
      // subtitles that contain a trailing hint <span>: set only the leading text node
      const setLead = (id, v) => { const e = document.getElementById(id); if (e && e.firstChild && v != null) e.firstChild.nodeValue = v + ' '; };
      setText('set-title', st.title);
      setText('set-lang-title', st.langTitle);
      setText('set-lang-row', st.langRow);
      setText('set-model-title', st.modelTitle);
      setText('set-l1-label', st.l1);
      setText('set-l2_1-label', st.l2_1);
      setText('set-l2_2-label', st.l2_2);
      setText('set-l3-label', st.l3);
      setLead('set-l2null-title', st.l2nullTitle);   setText('set-l2null-hint', st.l2nullHint);
      setText('set-l2null-row', st.l2nullRow);
      setText('set-l2null-inc', st.l2nullInclude);
      setText('set-l2null-exc', st.l2nullExclude);
      setLead('set-maxcond-title', st.maxcondTitle); setText('set-maxcond-hint', st.maxcondHint);
      setText('set-maxcond-row', st.maxcondRow);
      setLead('set-weight-title', st.weightTitle);   setText('set-weight-hint', st.weightHint);
      setText('set-wrel-label', st.wRel);
      setText('set-wcond-label', st.wCond);
      setText('set-wanchor-label', st.wAnchor);
      setLead('set-concl-title', st.conclTitle);     setText('set-concl-hint', st.conclHint);
      setText('set-dec-cautious', st.decCautious);
      setText('set-dec-decisive', st.decDecisive);
      setText('set-score-note', st.scoreNote);
      setText('settingsResetBtn', st.resetBtn);
      setText('settingsCloseBtn', st.closeBtn);
    }

    // Update welcome message if conversation hasn't started yet
    const hasUserMsg = document.querySelectorAll('#chatMessages .message.user').length > 0;
    if (!hasUserMsg) {
      const firstBubble = document.querySelector('#chatMessages .message.assistant .message-bubble');
      if (firstBubble) firstBubble.innerHTML = _formatMsg(t.welcome);
    }

    // Map language
    try { this.map.setLanguage(lang); } catch(_) {}

    // Map status
    const mapStatus = document.getElementById('mapStatus');
    if (mapStatus && mapStatus.textContent === LANG[lang === 'ja' ? 'en' : 'ja'].mapReady) {
      mapStatus.textContent = t.mapReady;
    }
  }

  _updateAPICountDisplay() {
    const sb = document.getElementById('api-counter-sb');
    const tq = document.getElementById('api-counter-tq');
    const iso = document.getElementById('api-counter-iso');
    if (sb) sb.textContent = `SB: ${this.mapboxMCP?._sbRequests ?? 0} req`;
    const tqHits = this.mapboxMCP?._tqCacheHits ?? 0;
    const tqReal = this.mapboxMCP?._tqRequests  ?? 0;
    if (tq) tq.textContent = tqHits > 0
      ? `TQ: ${tqReal} req (+${tqHits}↩)`
      : `TQ: ${tqReal} req`;
    const isoHits = this.mapboxMCP?._isoCacheHits ?? 0;
    const isoReal = this.mapboxMCP?._isoRequests  ?? 0;
    if (iso) iso.textContent = isoHits > 0
      ? `ISO: ${isoReal} req (+${isoHits}↩)`
      : `ISO: ${isoReal} req`;
  }

  _updateTokenDisplay() {
    const el = document.getElementById('token-display');
    if (!el) return;
    const fmt = n => n.toLocaleString('ja-JP');
    el.textContent = `↑${fmt(this._tokens.input)} ↓${fmt(this._tokens.output)}`;
  }

  _showThinking(text) {
    const el = document.getElementById('thinkingDisplay');
    el.style.display = 'flex';
    el.style.flexDirection = 'column';
    // Always start collapsed
    document.getElementById('thinkingLog').style.display  = 'none';
    document.getElementById('thinkingToggleBtn').textContent = '▲';
    document.getElementById('thinkingSteps').innerHTML = '';
    this._updateThinking(text);
  }

  _updateThinking(text) {
    document.getElementById('thinkingStatus').textContent = text;
  }

  /** Add a step to the thinking panel. Returns the element so timing can be appended later. */
  _addThinkingStep(text) {
    const steps = document.getElementById('thinkingSteps');
    const step  = document.createElement('div');
    step.className   = 'thinking-step pending';
    step.textContent = text;
    steps.appendChild(step);
    return step;
  }

  /** Update an existing thinking step with elapsed time and mark it done. */
  _resolveThinkingStep(el, elapsedSec) {
    if (!el) return;
    el.textContent = el.textContent + ` (${elapsedSec}s)`;
    el.classList.remove('pending');
  }

  _hideThinking() {
    const el = document.getElementById('thinkingDisplay');
    el.style.display = 'none';
    // Collapse log on hide so next time starts fresh
    document.getElementById('thinkingLog').style.display = 'none';
    document.getElementById('thinkingToggleBtn').textContent = '▲';
  }
}

// ═══════════════════════════════════════════════════════════════
// Performance Logger
// ═══════════════════════════════════════════════════════════════

const PerfLogger = {
  _sessionStart: null,
  _queryLabel:   null,

  /** Call at the start of each user query. */
  startQuery(label) {
    this._sessionStart = performance.now();
    this._queryLabel   = label;
    console.group(`🚀 [LocationFinder] "${label.slice(0, 60)}"  — ${new Date().toLocaleTimeString()}`);
  },

  /** Returns a timer handle. Call end(handle) when the operation finishes. */
  startOp(label) {
    const t = performance.now();
    const total = ((t - this._sessionStart) / 1000).toFixed(2);
    console.log(`  ⏳ [+${total}s] ${label}`);
    return { label, t };
  },

  /** Logs completion and returns elapsed seconds as string. */
  endOp(handle, extra = '') {
    const elapsed = ((performance.now() - handle.t) / 1000).toFixed(2);
    const total   = ((performance.now() - this._sessionStart) / 1000).toFixed(2);
    const suffix  = extra ? `  │  ${extra}` : '';
    console.log(`  ✅ [+${total}s] ${handle.label} → \x1b[32m${elapsed}s\x1b[0m${suffix}`);
    return elapsed;
  },

  /** Print a summary and close the console group. */
  endQuery(turnCount) {
    const total = ((performance.now() - this._sessionStart) / 1000).toFixed(2);
    console.log(`📊 合計: ${total}s  |  API ターン数: ${turnCount}`);
    console.groupEnd();
    return total;
  },
};

// ═══════════════════════════════════════════════════════════════
// Tool status labels (displayed in thinking indicator)
// ═══════════════════════════════════════════════════════════════

// Tool labels are now in LANG[lang].tools — use getToolLabel(name) instead of TOOL_LABELS
function getToolLabel(name, lang = 'ja') {
  return (LANG[lang]?.tools?.[name]) || name;
}

// ═══════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════

/**
 * Guard against swapped lat/lng (Claude occasionally passes [lat,lng] order).
 * In Japan: longitude ≈ 139, latitude ≈ 35.
 * If |lat| > 90 and |lng| <= 90, the values are swapped → correct them.
 */
function _safeLL(lng, lat) {
  if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) {
    if (CONFIG.DEBUG) console.warn(`[safeLL] lat/lng swapped detected, correcting: [${lng},${lat}] → [${lat},${lng}]`);
    return [lat, lng];
  }
  return [lng, lat];
}

// ================================================================
// Language definitions
// ================================================================
const LANG = {
  ja: {
    appTitle:      'ジオネーター',
    langBtn:       '🌐 Switch to EN',
    placeholder:   '場所を入力… (Enter×2で送信)',
    clearChat:     'チャットをクリア',
    debugOff:      '🔍 デバッグ OFF',
    debugOn:       '🔍 デバッグ ON',
    examplesLabel: '入力例',
    mapReady:      '地図の準備ができました',
    mapLoading:    '地図を読み込み中…',
    welcome:
      'こんにちは、ジオネーターです！\n\n' +
      '曖昧な言葉から、場所を特定します。近くのお店や、駅、方角、道路、川や海など、特徴的なものをいくつか教えてください。',
    // Chat role labels
    roleUser:      'オペレーター',
    roleAssistant: 'AI エージェント',
    roleThinking:  'AI 思考',
    roleTool:      'ツール実行',
    roleError:     'エラー',
    roleDebug:     'デバッグ停止',
    roleHint:      '💭 追加情報のお願い',
    // Priority labels
    priorityLabels:   ['最有力候補', '次有力候補', '第3候補', '第4候補', '第5候補'],
    priorityBadges:   ['⭐ 最有力候補', '🔵 次有力候補', '⚪'],
    probableArea:     'この辺にいると思われます',
    // Hint panel
    hintTitle:        (n) => `💭 追加情報のお願い（${n}回追加検索）`,
    hintPlaceholder:  '分かる範囲でお答えください...',
    hintSubmit:       '▶ この情報で続ける',
    hintSkip:         'スキップ（このまま続ける）',
    hintDone:         '✓ 続行中',
    // Processing
    connecting:       'Claude APIに接続中…',
    pausedHint:       '⏸ 追加情報を待っています...',
    debugPaused:      (s) => `⏸ デバッグ一時停止 — ${s}を確認してから「次のステップへ」をクリック`,
    debugNext:        '▶ 次のステップへ',
    debugDone:        '✓ 続行',
    confirmed:        '確定',
    // Tool labels
    tools: {
      get_midpoint_area:               '🗺  中間領域を計算中',
      search_nearby_poi:               '🔍 POIを検索中',
      scan_street_features:            '📡 周辺施設をスキャン中',
      draw_search_boundary:            '📐 検索範囲を描画中',
      add_candidate_markers:           '📌 候補ピンを追加中',
      clear_map_elements:              '🧹 マップをクリア中',
      finalize_location_marker:        '✅ 確定地点をマーク中',
      get_facing_road:                 '🛣  面している道路を判定中',
      get_route_pois:                  '🗺  経路沿いのPOIを判定中',
      scan_natural_features:           '🌿 自然地物をスキャン中',
      show_probable_area:              '🔴 候補エリアを表示中',

      evaluate_distance:               '📏 距離条件を評価中',
      resolve_result:                  '🔍 座標を解決中',
      compute_bbox_from_points:        '📐 出口カバレッジを計算中',
      compute_area_from_landmark_bearing: '🧭 ランドマーク方位からエリアを計算中',
      log_flow_step: '📋 フローステップを記録中',
    },
    // Settings modal
    settings: {
      title:       '設定',
      langTitle:   '言語 / Language',
      langRow:     '表示言語',
      modelTitle:  'モデル',
      l1:          'L1（クエリ解析）',
      l2_1:        'L2-1（通常クエリの関連性・カテゴリ）',
      l2_2:        'L2-2（Targetの関連性）',
      l3:          'L3（絞り込みの目印提案）',
      l2nullTitle: 'L2-1：カテゴリ未設定の扱い',
      l2nullHint:  '（カテゴリ情報が無い候補）',
      l2nullRow:   'カテゴリ=null の候補',
      l2nullInclude: '候補に含める',
      l2nullExclude: '候補に含めない',
      maxcondTitle: '条件の上限',
      maxcondHint:  '（近くにあるものの数・0〜5）',
      maxcondRow:   'conditionの最大数',
      weightTitle: 'スコアの重みづけ',
      weightHint:  '（何を重視するか・合計100%）',
      wRel:        '関連性（意図の一致）',
      wCond:       '条件からの距離（ローソン・バス停等）',
      wAnchor:     'Proximityからの距離（西大島等）',
      conclTitle:  '結論の出し方',
      conclHint:   '（言い切り ⇔ 慎重）',
      decCautious: '慎重（同程度多め）',
      decDecisive: '言い切り（gold積極）',
      scoreNote:   '※ スコアの変更は次の検索から反映されます',
      resetBtn:    '↺ すべてデフォルトに戻す',
      closeBtn:    '閉じる',
    },
  },
  en: {
    appTitle:      'Geonator',
    langBtn:       '🌐 日本語に変更',
    placeholder:   'Describe location… (press Enter twice to send)',
    clearChat:     'Clear Chat',
    debugOff:      '🔍 Debug OFF',
    debugOn:       '🔍 Debug ON',
    examplesLabel: 'Examples',
    mapReady:      'Map ready',
    mapLoading:    'Loading map…',
    welcome:
      'Hi, I\'m Geonator!\n\n' +
      'I identify locations from vague descriptions. Share nearby features — stores, stations, directions, roads, rivers, or landmarks.',
    roleUser:      'Caller',
    roleAssistant: 'AI Agent',
    roleThinking:  'AI Thinking',
    roleTool:      'Tool',
    roleError:     'Error',
    roleDebug:     'Debug Pause',
    roleHint:      '💭 More info needed',
    priorityLabels:   ['Top Candidate', '2nd Candidate', '3rd Option', '4th Option', '5th Option'],
    priorityBadges:   ['⭐ Top Candidate', '🔵 2nd Candidate', '⚪'],
    probableArea:     'Likely in this area',
    hintTitle:        (n) => `💭 Need more info (${n} more searches)`,
    hintPlaceholder:  'Type what you know…',
    hintSubmit:       '▶ Continue with this info',
    hintSkip:         'Skip',
    hintDone:         '✓ Continuing',
    connecting:       'Connecting to Claude…',
    pausedHint:       '⏸ Waiting for your input…',
    debugPaused:      (s) => `⏸ Debug paused — check the ${s} then click "Next Step"`,
    debugNext:        '▶ Next Step',
    debugDone:        '✓ Done',
    confirmed:        'Confirmed',
    tools: {
      get_midpoint_area:               '🗺  Computing midpoint',
      search_nearby_poi:               '🔍 Searching POIs',
      scan_street_features:            '📡 Scanning street features',
      draw_search_boundary:            '📐 Drawing search area',
      add_candidate_markers:           '📌 Adding candidate pins',
      clear_map_elements:              '🧹 Clearing map',
      finalize_location_marker:        '✅ Marking confirmed location',
      get_facing_road:                 '🛣  Checking road type',
      get_route_pois:                  '🗺  Checking route POIs',
      scan_natural_features:           '🌿 Scanning natural features',
      show_probable_area:              '🔴 Showing probable area',

      evaluate_distance:               '📏 Evaluating distance',
      resolve_result:                  '🔍 Resolving coordinates',
      compute_bbox_from_points:        '📐 Computing exit coverage bbox',
      compute_area_from_landmark_bearing: '🧭 Computing bearing area',
      log_flow_step: '📋 Logging flow step',
    },
    // Settings modal
    settings: {
      title:       'Settings',
      langTitle:   'Language / 言語',
      langRow:     'Display language',
      modelTitle:  'Models',
      l1:          'L1 (query parsing)',
      l2_1:        'L2-1 (general-query relevance · category)',
      l2_2:        'L2-2 (target relevance)',
      l3:          'L3 (refinement landmark suggestions)',
      l2nullTitle: 'L2-1: category=null handling',
      l2nullHint:  '(candidates with no category info)',
      l2nullRow:   'Candidates with category=null',
      l2nullInclude: 'Include as candidates',
      l2nullExclude: 'Exclude from candidates',
      maxcondTitle: 'Condition limit',
      maxcondHint:  '(number of nearby features · 0–5)',
      maxcondRow:   'Max conditions',
      weightTitle: 'Score weighting',
      weightHint:  '(what to prioritize · sums to 100%)',
      wRel:        'Relevance (intent match)',
      wCond:       'Distance from conditions (Lawson, bus stop, etc.)',
      wAnchor:     'Distance from proximity (e.g. Nishi-ojima)',
      conclTitle:  'How to conclude',
      conclHint:   '(decisive ⇔ cautious)',
      decCautious: 'Cautious (more ties)',
      decDecisive: 'Decisive (favor gold)',
      scoreNote:   '※ Scoring changes apply from the next search',
      resetBtn:    '↺ Reset all to defaults',
      closeBtn:    'Close',
    },
  },
};

/** Mirror of MapboxMCPClient._capBBox — cap bbox to ±500m each side. */
function _capBBoxFE(bbox, maxHalfM = 500) {
  const [minX, minY, maxX, maxY] = bbox;
  const cx   = (minX + maxX) / 2;
  const cy   = (minY + maxY) / 2;
  const dLng = maxHalfM / (111320 * Math.cos(cy * Math.PI / 180));
  const dLat = maxHalfM / 110540;
  const hw   = Math.min((maxX - minX) / 2, dLng);
  const hh   = Math.min((maxY - minY) / 2, dLat);
  return [cx - hw, cy - hh, cx + hw, cy + hh];
}

function _esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _formatMsg(text) {
  return _esc(text)
    .replace(/\n/g, '<br>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.*?)`/g,
      '<code style="background:rgba(255,255,255,.08);padding:1px 5px;border-radius:4px;font-size:.9em">$1</code>'
    );
}

// ═══════════════════════════════════════════════════════════════
// Boot
// ═══════════════════════════════════════════════════════════════

window.addEventListener('DOMContentLoaded', async () => {
  const app = new LocationFinderApp();
  await app.initialize();
});
