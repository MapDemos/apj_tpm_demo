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
    // 本体入力欄に統合した「自由入力の回答待ち」ルータ（refine/絞り込み/確認）。保留中は
    // _handleSend がここへ回答を流す。選択パネルの resolver も停止/クリア時の解放用に保持。
    this._pendingInputResolver = null;
    this._choiceResolve = null;

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

      // 2. Init Mapbox GL JS map — 地図ONの時だけ生成（OFF起動ならWebGL/タイルを立ち上げない）
      this._mapOff = this._readMapOffPref();
      if (!this._mapOff) await this._ensureMap();

      // 3. Wire up UI event listeners
      this._setupEventListeners();

      // 4. Restore saved model prefs + wire settings modal + badge
      this._initSettings();

      // 5. Init JS-driven QueryEngine (new architecture)
      this._initQueryEngine();

      // 6. Welcome message (bilingual via LANG) — L0の固定挨拶（LLM呼び出しではなく決め打ち文言）
      this.addMessage('l0', LANG[this._lang].welcome);

      // Build version in header (キャッシュで古いJSを読んでいないかの確認用)
      const verEl = document.getElementById('app-version');
      if (verEl) verEl.textContent = `v${this.config.APP_VERSION || '?'}`;

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
      if (saved.L0)   this.config.L0_MODEL   = saved.L0;   // L0（会話マネジメント）
      if (saved.L1)   this.config.L1_MODEL   = saved.L1;   // L1-2（クエリ解析）
      if (saved.L1c)  this.config.L1_CONFIRM_MODEL = saved.L1c; // L1-1（確認文の先出し・非活性）
      if (saved.L1_3) this.config.L1_3_MODEL = saved.L1_3; // L1-3（広域の絞り込み提案）
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
    // Judgement mode: hard/soft for same_building & floors
    try {
      const b = JSON.parse(localStorage.getItem('geonator_judge') || '{}');
      if (b.sameBuilding === 'hard' || b.sameBuilding === 'soft') this.config.SAME_BUILDING_MODE = b.sameBuilding;
      if (b.floors === 'hard' || b.floors === 'soft')             this.config.FLOORS_MODE       = b.floors;
    } catch (_) {}

    const l0Sel  = document.getElementById('l0ModelSelect');
    const l1Sel  = document.getElementById('l1ModelSelect');
    const l1cSel = document.getElementById('l1ConfirmModelSelect');
    const l1_3Sel = document.getElementById('l1_3ModelSelect');
    const l21Sel = document.getElementById('l2_1ModelSelect');
    const l22Sel = document.getElementById('l2_2ModelSelect');
    const l3Sel  = document.getElementById('l3ModelSelect');
    const nullSel = document.getElementById('l2_1NullSelect');
    const maxCondSel = document.getElementById('maxConditionsSelect');
    const sbModeSel  = document.getElementById('sameBuildingModeSelect');
    const flModeSel  = document.getElementById('floorsModeSelect');
    const modal  = document.getElementById('settingsModal');
    if (l0Sel)  l0Sel.value  = this.config.L0_MODEL;
    if (l1Sel)  l1Sel.value  = this.config.L1_MODEL;
    if (l1cSel) l1cSel.value = this.config.L1_CONFIRM_MODEL;
    if (l1_3Sel) l1_3Sel.value = this.config.L1_3_MODEL;
    if (l21Sel) l21Sel.value = this.config.L2_1_MODEL;
    if (l22Sel) l22Sel.value = this.config.L2_2_MODEL;
    if (l3Sel)  l3Sel.value  = this.config.L3_MODEL;
    if (nullSel) nullSel.value = this.config.L2_1_KEEP_NULL_CATEGORY === false ? 'exclude' : 'include';
    if (maxCondSel) maxCondSel.value = String(this.config.MAX_CONDITIONS);
    if (sbModeSel) sbModeSel.value = this.config.SAME_BUILDING_MODE ?? 'hard';
    if (flModeSel) flModeSel.value = this.config.FLOORS_MODE ?? 'hard';
    this._markRecommendedModels(); // 各役割の推奨モデルに「（推奨）」を付す

    const persist = () => {
      try {
        localStorage.setItem('geonator_models', JSON.stringify({
          L0: this.config.L0_MODEL,
          L1: this.config.L1_MODEL, L1c: this.config.L1_CONFIRM_MODEL, L1_3: this.config.L1_3_MODEL,
          L2_1: this.config.L2_1_MODEL, L2_2: this.config.L2_2_MODEL, L3: this.config.L3_MODEL,
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
    const persistJudge = () => {
      try { localStorage.setItem('geonator_judge', JSON.stringify({ sameBuilding: this.config.SAME_BUILDING_MODE, floors: this.config.FLOORS_MODE })); } catch (_) {}
    };
    l0Sel?.addEventListener('change',  e => { this.config.L0_MODEL   = e.target.value; persist(); });
    l1Sel?.addEventListener('change',  e => { this.config.L1_MODEL   = e.target.value; persist(); });
    l1cSel?.addEventListener('change', e => { this.config.L1_CONFIRM_MODEL = e.target.value; persist(); });
    l1_3Sel?.addEventListener('change', e => { this.config.L1_3_MODEL = e.target.value; persist(); });
    l21Sel?.addEventListener('change', e => { this.config.L2_1_MODEL = e.target.value; persist(); });
    l22Sel?.addEventListener('change', e => { this.config.L2_2_MODEL = e.target.value; persist(); });
    l3Sel?.addEventListener('change',  e => { this.config.L3_MODEL   = e.target.value; persist(); });
    nullSel?.addEventListener('change', e => { this.config.L2_1_KEEP_NULL_CATEGORY = e.target.value !== 'exclude'; persistNull(); });
    maxCondSel?.addEventListener('change', e => { this.config.MAX_CONDITIONS = parseInt(e.target.value, 10); persistSearch(); });
    sbModeSel?.addEventListener('change', e => { this.config.SAME_BUILDING_MODE = e.target.value; persistJudge(); });
    flModeSel?.addEventListener('change', e => { this.config.FLOORS_MODE       = e.target.value; persistJudge(); });

    // Tab switching (基本 / スコア / 判定方式)
    const tabs  = Array.from(document.querySelectorAll('.settings-tab'));
    const pages = Array.from(document.querySelectorAll('.settings-tabpage'));
    tabs.forEach(tab => tab.addEventListener('click', () => {
      const key = tab.dataset.stab;
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      pages.forEach(p => { p.style.display = p.dataset.stabpage === key ? '' : 'none'; });
    }));

    this._initScoringSettings();

    // Single "↺ すべてデフォルトに戻す" — models + scoring weights + decisiveness at once.
    // 全ロール Haiku 既定（速さ優先）。load-bearing フィールド(within/floors)はJS保険で復元、
    // relevance等もHaikuで実用十分と確認できたため。必要なら設定画面で個別に Sonnet 等へ変更可。
    const HAIKU = 'claude-haiku-4-5-20251001';
    // L2-2(target関連性)だけ名前ニュアンス判定のため Sonnet 4.6 既定。他は Haiku（速さ優先）。
    const MODEL_DEFAULTS = { L0: 'claude-sonnet-4-6', L1: HAIKU, L1c: HAIKU, L1_3: HAIKU, L2_1: HAIKU, L2_2: 'claude-sonnet-4-6', L3: HAIKU };
    document.getElementById('settingsResetBtn')?.addEventListener('click', () => {
      this.config.L0_MODEL   = MODEL_DEFAULTS.L0;
      this.config.L1_MODEL   = MODEL_DEFAULTS.L1;
      this.config.L1_CONFIRM_MODEL = MODEL_DEFAULTS.L1c;
      this.config.L1_3_MODEL = MODEL_DEFAULTS.L1_3;
      this.config.L2_1_MODEL = MODEL_DEFAULTS.L2_1;
      this.config.L2_2_MODEL = MODEL_DEFAULTS.L2_2;
      this.config.L3_MODEL   = MODEL_DEFAULTS.L3;
      this.config.L2_1_KEEP_NULL_CATEGORY = false; // default: exclude null-category candidates (strict)
      this.config.MAX_CONDITIONS = 3;              // default condition cap
      this.config.SAME_BUILDING_MODE = 'hard';     // default: hard filter
      this.config.FLOORS_MODE        = 'hard';     // default: hard filter
      if (l0Sel)  l0Sel.value  = MODEL_DEFAULTS.L0;
      if (l1Sel)  l1Sel.value  = MODEL_DEFAULTS.L1;
      if (l1cSel) l1cSel.value = MODEL_DEFAULTS.L1c;
      if (l1_3Sel) l1_3Sel.value = MODEL_DEFAULTS.L1_3;
      if (l21Sel) l21Sel.value = MODEL_DEFAULTS.L2_1;
      if (l22Sel) l22Sel.value = MODEL_DEFAULTS.L2_2;
      if (l3Sel)  l3Sel.value  = MODEL_DEFAULTS.L3;
      if (nullSel) nullSel.value = 'exclude';
      if (maxCondSel) maxCondSel.value = '3';
      if (sbModeSel) sbModeSel.value = 'hard';
      if (flModeSel) flModeSel.value = 'hard';
      try { localStorage.removeItem('geonator_models'); localStorage.removeItem('geonator_l2_1'); localStorage.removeItem('geonator_search'); localStorage.removeItem('geonator_judge'); } catch (_) {}
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

  /** localStorage から地図OFF設定を読む（初期化で地図生成の要否判断に使う）。
   *  明示設定があればそれを尊重。無ければスマホ幅は既定OFF（スマホ向け軽量表示）。 */
  _readMapOffPref() {
    try {
      const ui = JSON.parse(localStorage.getItem('geonator_ui') || '{}');
      if (typeof ui.mapOff === 'boolean') return ui.mapOff;
    } catch (_) {}
    return (window.matchMedia?.('(max-width: 768px)')?.matches) ?? (window.innerWidth <= 768);
  }

  /** 地図が「有効（ON かつ生成済み）」か。描画系はこれが真の時だけ実行する。 */
  _mapActive() { return !this._mapOff && !!this.map; }

  /** トグル。ONにする時はここで地図生成を保証（遅延生成）。 */
  async _toggleMap() {
    const off = !this._mapOff;
    this._setMapOff(off);              // 先にDOM反映（パネル表示→コンテナ幅を確定させてから生成）
    if (!off) await this._ensureMap(); // OFF→ON: 未生成なら生成（初回もサイズ確定済みで生成）
  }

  /** 地図表示ON/OFFのDOM反映。OFFで .map-off を付け対話パネルを中央表示。ON復帰時は resize。 */
  _setMapOff(off) {
    this._mapOff = !!off;
    document.querySelector('.app-container')?.classList.toggle('map-off', this._mapOff);
    const btn = document.getElementById('mapToggleBtn');
    if (btn) btn.textContent = this._mapOff ? LANG[this._lang].mapShow : LANG[this._lang].mapHide;
    try { localStorage.setItem('geonator_ui', JSON.stringify({ mapOff: this._mapOff })); } catch (_) {}
    // 再表示時: 非表示中はコンテナ幅が0なので mapbox の再計算が必要
    if (!this._mapOff && this.map) setTimeout(() => { try { this.map.resize(); } catch (_) {} }, 60);
  }

  /** 地図OFF時に候補パネルへ差し込む静的地図URL（Static Images API）。上位5件をティア色ピンで。
   *  色は共有 TIER_STYLE、bbox は1次検索の _lastResultBbox を使い、interactive と表示を揃える。 */
  _buildStaticMapUrl(candidates) {
    const token = this.config.MAPBOX_ACCESS_TOKEN;
    const style = (this.config.MAP_STYLE || '').replace('mapbox://styles/', '');
    if (!token || !style) return null;
    const top = (candidates || [])
      .filter(c => (c.longitude ?? c.lng) != null && (c.latitude ?? c.lat) != null)
      .slice(0, 5); // 注記どおり上位5件まで
    if (!top.length) return null;
    const TIER = LocationFinderApp.TIER_STYLE;
    const pins = top.map((c, i) => {
      const lng = (c.longitude ?? c.lng).toFixed(5), lat = (c.latitude ?? c.lat).toFixed(5);
      const color = (TIER[c._tier]?.color || TIER.none.color).replace('#', '');
      return `pin-s-${i + 1}+${color}(${lng},${lat})`; // ラベル=順位(1〜5)、色=ティア
    }).join(',');
    const view = this._staticView(top, this._lastResultBbox);
    // サムネイル用途なので標準解像度（@2xは実質4倍pxで重い）。320x180でさらに軽量化。
    return `https://api.mapbox.com/styles/v1/${style}/static/${pins}/${view}/320x180?access_token=${token}`;
  }

  /** 静的地図の視野: ピンが固まっていれば 'auto'（フィット）、散っていれば1次検索bbox（軽くパディング）。 */
  _staticView(pins, bbox) {
    const lls = pins.map(c => [c.longitude ?? c.lng, c.latitude ?? c.lat]);
    if (!bbox || bbox.length < 4) return 'auto';
    const pW = Math.max(...lls.map(p => p[0])) - Math.min(...lls.map(p => p[0]));
    const pH = Math.max(...lls.map(p => p[1])) - Math.min(...lls.map(p => p[1]));
    const bW = Math.abs(bbox[2] - bbox[0]) || 1, bH = Math.abs(bbox[3] - bbox[1]) || 1;
    if (Math.max(pW / bW, pH / bH) < 0.35) return 'auto'; // 固まってる → autoでフィット
    const padLng = bW * 0.06, padLat = bH * 0.06;         // 枠固定: 端の切れ防止
    return `[${(bbox[0] - padLng).toFixed(5)},${(bbox[1] - padLat).toFixed(5)},${(bbox[2] + padLng).toFixed(5)},${(bbox[3] + padLat).toFixed(5)}]`;
  }

  _updateModelBadge() {
    const el = document.getElementById('model-badge');
    if (!el) return;
    const s = m => (m || '').replace('claude-', '').replace(/-\d{8}$/, '');
    el.textContent = `L0:${s(this.config.L0_MODEL)} / L1-2:${s(this.config.L1_MODEL)} / L1-3:${s(this.config.L1_3_MODEL)} / L2-1:${s(this.config.L2_1_MODEL)} / L2-2:${s(this.config.L2_2_MODEL)} / L3:${s(this.config.L3_MODEL)}`;
  }

  /** 各役割の推奨モデル（＝既定）のオプションに「（推奨）」を付す。言語に追従。 */
  _markRecommendedModels() {
    const suffix = this._lang === 'en' ? ' (Recommended)' : '（推奨）';
    // MODEL_DEFAULTS と一致させること（役割ごとの既定＝推奨）。全ロール Haiku 既定（速さ優先）。
    const rec = {
      l0ModelSelect:   'claude-sonnet-4-6',               // L0 会話マネジメント→対話の質重視でSonnet推奨
      l1ConfirmModelSelect: 'claude-haiku-4-5-20251001', // L1-1 確認文（非活性）
      l1ModelSelect:   'claude-haiku-4-5-20251001',      // L1-2 解析
      l1_3ModelSelect: 'claude-haiku-4-5-20251001',      // L1-3 広域絞り込み提案
      l2_1ModelSelect: 'claude-haiku-4-5-20251001',
      l2_2ModelSelect: 'claude-sonnet-4-6',              // L2-2 関連性=名前ニュアンス→Sonnet推奨
      l3ModelSelect:   'claude-haiku-4-5-20251001',
    };
    const label = (v) =>
      v === 'claude-sonnet-5'  ? 'Sonnet 5'
      : v.includes('sonnet')   ? 'Sonnet 4.6'
      :                          'Haiku 4.5';
    for (const [id, recVal] of Object.entries(rec)) {
      const sel = document.getElementById(id);
      if (!sel) continue;
      for (const opt of sel.options) {
        opt.textContent = label(opt.value) + (opt.value === recVal ? suffix : '');
      }
    }
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
      if (decVal)    decVal.textContent = `${LANG[this._lang]?.settings?.decLabel || '言い切り度'} ${Math.round(d * 100)}%`;
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
      // L0（会話マネジメント）の発話。既存の assistant とは別ロール・別スタイルで表示する。
      showL0Message(text) {
        self.addMessage('l0', text);
      },
      showSearching(text) {
        self._updateThinking(text);
      },
      async showChoices(question, choices) {
        self._hideCancelBtn(); // ユーザー選択待ち＝処理は一旦ユーザーに委ねる→キャンセル不要
        const answer = await new Promise(resolve => {
          self.addMessage('l0', question);
          self._showChoicePanel(question, choices).then(resolve);
        });
        // 選択後は必ず解決処理（Search Box/Tilequery等）が続く → 無音区間を作らないよう考え中を再掲。
        // 直後に本流側の thinking(場所特定/収集…) が具体ラベルへ上書きする。結果描画で自動的に消える。
        self._showCancelBtn();
        self._showTypingIndicator();
        return answer;
      },
      async showHintInput(prompt, suggestions) {
        self._hideCancelBtn(); // 入力待ち＝キャンセル不要
        const text = await new Promise(resolve => {
          self.addMessage('l0', prompt);
          self._showHintPanel(prompt, (text) => resolve(text), suggestions);
        });
        // 入力があれば再解析/再検索/絞り込みが続く → 考え中を再掲（skip=nullは後段の各フロー任せ）。
        if (text) { self._showCancelBtn(); self._showTypingIndicator(); }
        return text;
      },
      getLang() { return self._lang; },
      isDebug() { return self._debugMode; },
      debugStep(stepId, label, lines) {
        if (!self._debugMode) return Promise.resolve();
        return new Promise(resolve => self._showStepPanel(stepId, label, lines, resolve));
      },
      showResults(full, partial, none, summary, conditionLabels, droppedNote) {
        // Tier-aware markers. QueryEngine set _tier + _matchInfo.score.
        self._renderTierMarkers([...full, ...partial, ...none]);

        // Candidate list in the dialogue panel (clickable + feedback for ground truth),
        // with the result summary as the header of the SAME bubble.
        self._renderCandidatePanel(full, partial, none, summary, droppedNote);
      },
      async showFeedback(proximityLabel, opts) {
        self._hideCancelBtn(); // フィードバック待ち＝キャンセル不要
        const action = await new Promise(resolve => {
          self._showFeedbackButtons(resolve, proximityLabel, opts);
        });
        // 「探し直す/更に絞る」は再処理が続く → 考え中を再掲。「終了(done)」は処理無しなので出さない。
        if (action && action !== 'done') { self._showCancelBtn(); self._showTypingIndicator(); }
        return action;
      },
      clearResults() {
        if (!self._mapActive()) return; // 地図OFF: 消すべき地図要素が無い
        self.clearMapElements();
        self._clearDebugLayers();
        self._removeProbableArea?.();
        if (self.finalMarker) { self.finalMarker.remove(); self.finalMarker = null; }
      },
      showProbableArea(candidates, message) { if (!self._mapActive()) return; self.showProbableArea(candidates, message); },

      // ── Visualization / telemetry callbacks (always on, not debug-gated) ──
      refreshCounts() {
        self._updateAPICountDisplay();
      },
      // 1次検索bbox（within到達圏で絞られていればその値）を保持。地図OFF時の静的地図の枠に使う。
      setResultBbox(bbox) { self._lastResultBbox = bbox || null; },
      // 次の計算中に「今何をしているか」を再表示（次の吹き出しで自動的に消える）
      thinking(label) { self._showTypingIndicator(label); },
      // キャンセルされたか（QueryEngineが各局面で確認し、途中で描画を止める）
      isCancelled() { return !!self._cancelled; },
      drawProximityPoints(points) {
        if (!self._mapActive()) return; // 地図OFF: 描画スキップ
        // proximityアンカー（基準点）の地図表示は無効化（分かりづらいとの指摘）。
        // 検索エリアは drawBBox(targetBbox/condBbox) で引き続き表示する。
        // アンカー由来の bbox だけは範囲把握に有用なので残す。
        (points || []).forEach(p => {
          if (p.bbox) self._dbgAddBbox(p.bbox);
        });
      },
      drawBBox(bbox) {
        if (!self._mapActive()) return; // 地図OFF: 描画スキップ
        if (bbox) self._dbgAddBbox(bbox);
      },
      // 候補多すぎ(overflow)→再アンカーで絞り込んだ後の検索bbox。デバッグモード時のみ表示。
      drawNarrowBBox(bbox) {
        if (!self._debugMode || !self._mapActive() || !bbox) return;
        self._drawNarrowBBox(bbox);
      },
      drawHits(items) {
        if (!self._mapActive()) return; // 地図OFF: 描画スキップ
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
        if (!self._mapActive()) return; // 地図OFF: 描画スキップ
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
      // Tilequeryグリッド（各収集点の半径円）をデバッグ地図に描画。デバッグモード時のみ。
      // skipped = 穴skip等で問い合わせなかった点（別スタイルで表示）。
      drawGrid(circles, skipped) {
        console.log('[drawGrid] called', { debug: self._debugMode, mapActive: self._mapActive(), hasDbg: !!self._dbg, circles: circles?.length, skipped: skipped?.length });
        if (!self._debugMode || !self._mapActive() || !self._dbg) return;
        self._drawGridCircles(circles, skipped);
      },
      drawPolygons(features) {
        if (!self._mapActive() || !self._dbg || !features?.length) return;
        // Cap to keep the map readable / performant
        const capped = features.slice(0, 200);
        capped.forEach(f => { if (f?.geometry) self._dbg.evalPolys.features.push(f); });
        try { self.map.getSource('dbg-eval-polys')?.setData(self._dbg.evalPolys); } catch(_) {}
        document.getElementById('mapLegend').style.display = 'block';
      },
      fitToBBox(bbox) {
        if (!self._mapActive() || !bbox) return; // 地図OFF: スキップ
        try {
          self.map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 80, duration: 900, maxZoom: 16 });
        } catch(_) {}
      },
      showDebugReport(report) {
        if (!self._debugMode || !report) return;
        // 生成された QuerySchema を JSON でモーダル表示（コピー可）するボタンを添える。
        const actions = report.schema ? [{
          label: self._lang === 'en' ? '🧬 QuerySchema JSON' : '🧬 QuerySchema JSON を表示',
          onClick: () => self._showSchemaModal(report.schema),
        }] : [];
        self.addMessage('debug', self._renderDebugReport(report), { actions });
      },
      // デバッグ専用の詳細メッセージ（エラー原因など）。通常モードでは何も出さない。
      showDebug(text) {
        if (!self._debugMode || !text) return;
        self.addMessage('debug', text);
      },
      showRunStats(stats) {
        if (!stats) return;
        const fmt = n => (n || 0).toLocaleString('ja-JP');
        const secs = (stats.ms / 1000).toFixed(1);
        const en = self._lang === 'en';
        const shortModel = m => (m || '').replace('claude-', '').replace(/-\d{8}$/, '');

        // ロール別トークン（0回は除外）＋ モデル別集計 ＋ 総計
        const roleData = [];
        let totIn = 0, totOut = 0;
        for (const [role, s] of [['L0', stats.llm?.L0], ['L1-1', stats.llm?.L1c], ['L1-2', stats.llm?.L1], ['L1-3', stats.llm?.L1_3], ['L2-1', stats.llm?.L2_1], ['L2-2', stats.llm?.L2_2], ['L3', stats.llm?.L3]]) {
          if (!s || !s.calls) continue;
          roleData.push({ role, ...s });
          totIn += s.inTok; totOut += s.outTok;
        }
        const byModel = new Map(); // モデル別内訳（同一モデルの複数ロールを合算）
        for (const r of roleData) {
          const key = shortModel(r.model) || '?';
          const m = byModel.get(key) || { inTok: 0, outTok: 0, calls: 0, cacheRead: 0, cacheWrite: 0 };
          m.inTok += r.inTok; m.outTok += r.outTok; m.calls += r.calls;
          m.cacheRead += (r.cacheRead || 0); m.cacheWrite += (r.cacheWrite || 0);
          byModel.set(key, m);
        }
        // Mapbox 製品別リクエスト（フルネーム。カウンタは run()/絞り込み開始でリセット済み＝この操作ぶん）
        const mcp = self.mapboxMCP || {};
        const mbRows = [
          ['Search Box API',   mcp._sbRequests  ?? 0],
          ['Tilequery API',    mcp._tqRequests  ?? 0],
          ['Isochrone API',    mcp._isoRequests ?? 0],
          ['Matrix API',       mcp._matrixRequests ?? 0],
          ['Static Images API', mcp._siRequests ?? 0],
        ];

        // ── DOM 構築：合計は常時表示、それ以下は <details>（クリックで展開）──
        self._hideTypingIndicator?.(); // addMessage 相当（考え中表示を消す）
        const container = document.getElementById('chatMessages');
        const wrapper = document.createElement('div');
        wrapper.className = 'message tool-status';
        const lbl = document.createElement('div');
        lbl.className = 'msg-label';
        lbl.textContent = LANG[self._lang].roleTool;
        wrapper.appendChild(lbl);
        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';

        const totalLine = document.createElement('div');
        totalLine.textContent = en ? `⏱ Total ${secs}s` : `⏱ 処理時間 合計 ${secs}s`;
        bubble.appendChild(totalLine);

        const det = document.createElement('details');
        const sum = document.createElement('summary');
        sum.textContent = en ? '▸ Details (tokens / Mapbox usage)' : '▸ 詳細（消費トークン・Mapbox利用）';
        sum.style.cssText = 'cursor:pointer;opacity:.85;margin-top:4px;user-select:none';
        det.appendChild(sum);

        const lines = [];
        lines.push(en ? `— Tokens total ↑${fmt(totIn)} ↓${fmt(totOut)} —` : `── 消費トークン 合計 ↑${fmt(totIn)} ↓${fmt(totOut)} ──`);
        if (byModel.size) {
          for (const [model, m] of byModel) {
            const cache = (m.cacheRead || m.cacheWrite) ? ` 💾r${fmt(m.cacheRead)}/w${fmt(m.cacheWrite)}` : '';
            lines.push(`${model}: ↑${fmt(m.inTok)} ↓${fmt(m.outTok)}${cache} ・${m.calls}${en ? ' calls' : '回'}`);
          }
        } else {
          lines.push(en ? '(no LLM calls this step)' : '（この処理でLLM呼び出しなし）');
        }
        lines.push(en ? '— Mapbox API requests —' : '── 消費 Mapbox API（製品別）──');
        for (const [name, n] of mbRows) lines.push(`${name}: ${fmt(n)}`);

        if (self._debugMode) {
          if (roleData.length) {
            lines.push(en ? '— LLM by role (debug) —' : '── LLM ロール別（デバッグ）──');
            for (const r of roleData) {
              const cache = (r.cacheRead || r.cacheWrite) ? ` 💾r${fmt(r.cacheRead)}/w${fmt(r.cacheWrite)}` : '';
              lines.push(`${r.role}(${shortModel(r.model)}): ↑${fmt(r.inTok)} ↓${fmt(r.outTok)}${cache} ・${r.calls}${en ? ' calls' : '回'}・${(r.ms / 1000).toFixed(1)}s`);
            }
          }
          // 区間ごとの時間＋発行TQ数（p.tq は累積なので前区間との差を取る＝その区間で叩いたTQ）。
          const phaseAgg = new Map(); // label → { ms, tq }
          let prevTq = 0;
          for (const p of (stats.phases || [])) {
            const dTq = Math.max(0, (p.tq ?? prevTq) - prevTq);
            prevTq = p.tq ?? prevTq;
            const cur = phaseAgg.get(p.l) || { ms: 0, tq: 0 };
            cur.ms += p.ms; cur.tq += dTq;
            phaseAgg.set(p.l, cur);
          }
          if (phaseAgg.size) {
            lines.push(en ? '— Phase breakdown (debug) —' : '── 処理内訳（デバッグ）──');
            for (const [l, v] of phaseAgg) lines.push(`${l}: ${(v.ms / 1000).toFixed(2)}s${v.tq ? ` / TQ ${v.tq}` : ''}`);
          }
        }

        const body = document.createElement('div');
        body.style.cssText = 'margin-top:4px;font-size:.9em;line-height:1.5;white-space:pre-wrap';
        body.innerHTML = lines.map(_esc).join('<br>');
        det.appendChild(body);
        bubble.appendChild(det);
        wrapper.appendChild(bubble);
        container.appendChild(wrapper);
        container.scrollTop = container.scrollHeight;
        self._pinCancelToBottom?.(); // addMessage 相当（キャンセル吹き出しを最下部維持）

        // 上限到達の警告（TQ/SB/ISO）：どのAPIが上限で打ち切られたかを明示
        const cap = self.mapboxMCP?._capHit;
        if (cap && (cap.tq || cap.sb || cap.iso)) {
          const L = LANG[self._lang], caps = [];
          if (cap.tq)  caps.push(L.capTQ(self.config.TQ_MAX_PER_QUERY ?? 2000));
          if (cap.sb)  caps.push(L.capSB(self.config.SB_MAX_PER_QUERY ?? 100));
          if (cap.iso) caps.push(L.capISO(self.config.ISO_MAX_PER_QUERY ?? 100));
          self.addMessage('error', `${L.capWarnHead}\n${caps.join('\n')}`);
        }
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
    L.push(`🔧 デバッグ情報  (v${this.config.APP_VERSION || '?'})`);

    // ── QuerySchema ──
    if (r.schema) {
      const s = r.schema;
      const anchors = (s.proximity?.anchors || []).map(a => `${a.text}[${a.type}/${a.specificity}]`).join(', ');
      L.push('');
      L.push('【QuerySchema】');
      const _w = s.proximity?.within;
      const _within = (() => {
        if (!_w) return '(なし)';
        if (_w.level) return _w.level;
        const mn = _w.minMinutes, mx = _w.maxMinutes ?? _w.minutes, prof = _w.profile || 'walking';
        if (mn != null || mx != null) {
          if (mn != null && mx != null) return `${mn}〜${mx}分(${prof})`;   // ドーナツ（N分以上M分以内）
          if (mn != null) return `${mn}分以上(${prof})`;                     // 下限のみ
          return `${mx}分以内(${prof})`;                                     // 上限のみ
        }
        const met = _w.maxMeters ?? _w.meters;
        return met != null ? `${met}m` : '?';
      })();
      const _scope = s.proximity?.scope ? (s.proximity.scope.text || JSON.stringify(s.proximity.scope)) : '(なし)';
      L.push(`・proximity: ${anchors}  within=${_within}  scope=${_scope}${s.proximity?.bearing_filter ? ' 方角=' + s.proximity.bearing_filter : ''}`);
      L.push(`・target: ${s.target?.text}  intent=${s.target?.query_intent}`);
      (s.conditions || []).forEach(c => {
        const d = c.distance || {};
        L.push(`・condition: ${c.text ?? c.type} [${c.type}]  距離=${d.level}/${d.method}${d.minutes ? ' ' + d.minutes + '分' : ''}${d.profile ? ' ' + d.profile : ''}`);
      });
      if (s.droppedConditionTexts?.length) L.push(`・除外(上限超過): ${s.droppedConditionTexts.join('、')}`);
      if (s.unsupported_features?.length)  L.push(`・除外(非対応の特徴): ${s.unsupported_features.join('、')}`);
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
      if (t.queries?.length) L.push(`・検索語(QE展開): [${t.queries.join(', ')}]${t.queries.length === 1 ? ' ← 未展開' : ''}`);
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
  _showFeedbackButtons(onAction, proximityLabel, opts = {}) {
    const container = document.createElement('div');
    container.className = 'feedback-buttons';
    container.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;';

    const px = (proximityLabel || '').trim();
    let buttons = this._lang === 'en'
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
    // 候補が1件以下なら「更に絞り込む」は無意味（絞る対象が無い）ので隠す。
    if (opts.canNarrow === false) buttons = buttons.filter(b => b.value !== 'narrow');

    // Keep the resolver so _resetChat can cancel a pending feedback wait — otherwise
    // clearing chat while awaiting feedback leaves run() hung (input stays disabled).
    this._feedbackResolve = onAction;
    // fromClick=trueの時だけここでuserバブルを出す（番号入力は _handleSend が既に表示済み）。
    const finalize = (label, value, fromClick) => {
      container.remove();
      this._feedbackResolve = null;
      this._pendingInputResolver = null;
      if (fromClick) this.addMessage('user', label);
      onAction(value);
    };
    buttons.forEach(({ label, value }, i) => {
      const btn = document.createElement('button');
      btn.textContent = `${i + 1}. ${label}`;
      btn.className   = 'choice-btn';
      btn.onclick = () => finalize(label, value, true);
      container.appendChild(btn);
    });

    const chatMessages = document.getElementById('chatMessages');
    if (chatMessages) chatMessages.appendChild(container);

    // 本体入力欄からの番号入力にも対応（ボタンは残したまま・番号は決定的なJS処理）。
    const handleTyped = (text) => {
      // text==null は停止/クリア時の _resolvePendingWaits シグナル。ここでは何もしない
      // （直後に _feedbackResolve(null) が呼ばれ、そちらが待ちの終了を処理する）。
      if (text == null) return;
      const idx = this._parseChoiceSelection(text, buttons.length);
      if (idx != null) { finalize(buttons[idx].label, buttons[idx].value, false); return; }
      this.addMessage('l0', LANG[this._lang].pickNumberHint);
      this._pendingInputResolver = handleTyped; // 待ちを継続
      const mi = document.getElementById('chatInput');
      if (mi) { mi.disabled = false; mi.focus(); }
    };
    this._pendingInputResolver = handleTyped;
    const mainInput = document.getElementById('chatInput');
    if (mainInput) { mainInput.disabled = false; mainInput.focus(); }
  }

  /**
   * Debug step panel: shows the stage summary + a "▶ 次へ" button and waits.
   * Tagged with data-step so map elements can highlight it on click.
   */
  _showStepPanel(stepId, label, lines, onNext) {
    this._hideTypingIndicator();
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
    this._pinCancelToBottom(); // ステップ吹き出しの下にキャンセルを維持
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
      'step-collect':   ['dbg-narrow-l', 'dbg-narrow-labels-sym', 'dbg-grid-fill', 'dbg-grid-line', 'dbg-grid-pts-c', 'dbg-grid-skip-fill', 'dbg-grid-skip-line', 'dbg-search-hits-c', 'dbg-search-hits-l', 'dbg-tq-hits-c', 'dbg-tq-hits-l', 'dbg-clusters-ring', 'dbg-clusters-label'],
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
      ...(this._debugMode ? [
        `<div class="legend-row"><span class="legend-dot legend-circle-only" style="border-color:#34d399"></span>${_esc(en ? 'Tilequery grid' : 'Tilequeryグリッド')}</div>`,
      ] : []),
      ...(this._debugMode && this._dbg?.gridSkip?.features?.length ? [
        `<div class="legend-row"><span class="legend-dot legend-circle-only" style="border-color:#fb7185;border-style:dashed"></span>${_esc(en ? 'grid skipped (hole)' : 'グリッドskip(穴)')}</div>`,
      ] : []),
      ...(this._debugMode && this._dbg?.narrowBbox?.features?.length ? [
        `<div class="legend-row"><span class="legend-dot" style="background:#f43f5e"></span>${_esc(en ? 'narrowed area (overflow)' : '絞込エリア(多すぎ)')}</div>`,
      ] : []),
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

  async _ensureMap() {
    if (this.map) return; // 生成済み（遅延生成・冪等）
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

    sendBtn.addEventListener('click', () => this._onSendOrStop());

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

    // Auto-resize textarea ＋ 入力中の「・・・」アニメ（アシスタント側とお揃いのモチーフ）
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      if (input.value.trim()) this._showUserTyping(); else this._hideUserTyping();
    });
    input.addEventListener('blur', () => this._hideUserTyping());

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

    // 地図表示 ON/OFF（OFFで対話パネルを中央表示＝スマホ風）。設定は localStorage に永続化。
    document.getElementById('mapToggleBtn')?.addEventListener('click', () => this._toggleMap());
    this._setMapOff(this._mapOff); // 起動時のDOM反映（bool は initialize() で確定済み）

    // Example chips
    document.querySelectorAll('.example-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        // Pick the current-language query directly from data-q-ja/en (robust — no reliance
        // on data-q being pre-populated, which was inserting "null" on click).
        input.value = (this._lang === 'en' ? btn.dataset.qEn : btn.dataset.qJa)
          || btn.dataset.qJa || btn.dataset.q || '';
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        input.focus();
      });
    });
  }

  async _handleSend() {
    const input = document.getElementById('chatInput');
    const text  = input.value.trim();
    if (!text) return;
    // 保留中の自由入力待ち（refine/絞り込み/確認の回答）があれば、本体入力をそこへ流す（入力欄統合）。
    // これにより追加条件などが専用textareaでなく本体の入力欄で完結する。
    if (this._pendingInputResolver) {
      const resolve = this._pendingInputResolver;
      this._pendingInputResolver = null;
      input.value = '';
      input.disabled = true;      // 回答後は処理が再開する＝入力を一旦閉じる（次の質問で再開放）
      this._hideUserTyping();
      this.addMessage('user', text);
      resolve(text);
      return;
    }
    if (this._querying) return; // 新規送信は多重発火ガード（実行中は無視・入力は消さない）
    const examples = document.getElementById('examplesArea'); // Hide examples on first send
    if (examples) examples.style.display = 'none';
    input.value = '';
    this._hideUserTyping();
    this.addMessage('user', text);
    await this._execQuery(text);
  }

  /** クエリ実行の共通ルーチン（送信・リトライで共有）。キャンセル/エラー(リトライ)を扱う。 */
  async _execQuery(text) {
    if (this._querying) return; // 多重発火ガード（click+Enter同時/連打での二重起動を防ぐ・同期的に確保）
    this._querying = true;
    const input   = document.getElementById('chatInput');
    this._lastQuery = text;
    this._cancelled = false;
    input.disabled   = true;
    this._setProcessing(true); // 送信ボタンを停止(■)モードに
    this._advanceMapGen();
    this._showThinking(LANG[this._lang].connecting);
    this._showTypingIndicator();

    try {
      await this.processUserMessage(text);
    } catch (err) {
      if (!this._cancelled) this._showErrorWithRetry(err, text);
    } finally {
      this._querying = false; // ロック解除
      this._hideThinking();
      this._hideTypingIndicator();
      this._setProcessing(false); // 送信ボタンを送信(➤)へ戻す
      input.disabled   = false;
      input.focus();
    }
  }

  // 旧・別枠キャンセル吹き出しは廃止。停止は送信ボタン(■)に集約（_setProcessing）。
  // 既存の呼び出し箇所（choices/hint/feedback/候補パネル表示の前後）は「今キャンセル可能な
  // バックグラウンド処理があるか」を正確な境界で示しており、そのまま送信⇄■の切替に流用する。
  _showCancelBtn() { this._setProcessing(true); }  // 処理再開＝■
  _hideCancelBtn() { this._setProcessing(false); } // ユーザー操作待ち（ボタン/候補閲覧）＝キャンセル不要→➤
  _pinCancelToBottom() {} // 旧・別枠吹き出しの位置維持用。送信ボタンは固定位置なので不要。

  /** 送信ボタンを送信(➤)/停止(■)モードに切替。処理中は停止ボタンとして機能する。 */
  _setProcessing(on) {
    const sendBtn = document.getElementById('sendBtn');
    if (!sendBtn) return;
    sendBtn.disabled = false; // 送信・停止のどちらでもクリック可
    if (on) {
      sendBtn.classList.add('stop');
      sendBtn.textContent = '■';
      sendBtn.title = this._lang === 'en' ? 'Stop' : '停止';
    } else {
      sendBtn.classList.remove('stop');
      sendBtn.textContent = '➤';
      sendBtn.title = this._lang === 'en' ? 'Send' : '送信';
    }
  }

  /** 送信ボタンのクリック：停止(■)モードならキャンセル、そうでなければ送信。 */
  _onSendOrStop() {
    const sendBtn = document.getElementById('sendBtn');
    if (sendBtn && sendBtn.classList.contains('stop')) this._cancelQuery();
    else this._handleSend();
  }

  /** 保留中のユーザー入力待ち（選択/自由入力/フィードバック/デバッグ一時停止）をすべて解決して解放。
   *  停止(■)は処理中いつでも押せる＝確認待ち中に停止された時、宙に浮いた await で run() がハングするのを防ぐ。 */
  _resolvePendingWaits(value = null) {
    for (const key of ['_pendingInputResolver', '_choiceResolve', '_feedbackResolve', '_debugStepResolve']) {
      const r = this[key];
      if (r) { this[key] = null; try { r(value); } catch (_) {} }
    }
  }

  /** 番号選択（choice/feedback/提案ボタン共通）：全角数字を半角化し 1..max の整数なら0始まりの
   *  indexを返す。それ以外（自由文・範囲外）は null（＝数字選択ではない）。JSの決定的な処理のみ。 */
  _parseChoiceNumber(text, max) {
    const half = (text || '').trim().replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0));
    if (!/^\d+$/.test(half)) return null;
    const n = parseInt(half, 10);
    return (n >= 1 && n <= max) ? n - 1 : null;
  }

  /** 曖昧な序数表現（最初/真ん中/最後 等）を固定語彙で拾う。意味解釈ではなく辞書引きなので
   *  決定的（LLM不使用）。部分一致でOK（「最初のでお願い」等の言い回しも拾う）。 */
  _parseChoiceOrdinal(text, max) {
    const t = (text || '').trim().toLowerCase();
    if (!t || max < 1) return null;
    const FIRST = ['最初', '一番上', '一番目', '先頭', 'いちばん上', 'はじめ', 'first', 'top'];
    const LAST  = ['最後', '一番下', '一番したの', 'いちばん下', 'last', 'bottom'];
    const MID   = ['真ん中', 'まんなか', '中間', 'middle'];
    if (FIRST.some(w => t.includes(w))) return 0;
    if (LAST.some(w => t.includes(w)))  return max - 1;
    if (max >= 2 && MID.some(w => t.includes(w))) return Math.floor((max - 1) / 2);
    return null;
  }

  /** choice/feedback/提案ボタン共通の選択解釈：番号 → 曖昧な序数表現、の順で試す。
   *  どちらも該当しなければ null（自由文として別途扱う、または「番号でお答えください」案内）。 */
  _parseChoiceSelection(text, max) {
    const byNumber = this._parseChoiceNumber(text, max);
    if (byNumber != null) return byNumber;
    return this._parseChoiceOrdinal(text, max);
  }

  /** 入力中の「・・・」アニメ（アシスタントの考え中とお揃い・右寄せのユーザー吹き出し）。 */
  _showUserTyping() {
    if (document.getElementById('userTypingIndicator')) return;
    const container = document.getElementById('chatMessages');
    if (!container) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'message user typing-indicator user-typing';
    wrapper.id = 'userTypingIndicator';
    wrapper.innerHTML = `<div class="message-bubble"><span class="typing-dots"><span></span><span></span><span></span></span></div>`;
    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;
  }
  _hideUserTyping() { document.getElementById('userTypingIndicator')?.remove(); }

  /** ソフトキャンセル：以降の新規API発行を止め(mcpが_cancelledを見る)、UIを即復帰、結果描画を抑止。 */
  _cancelQuery() {
    if (this._cancelled) return;
    this._cancelled = true;                 // mcp/queryEngine が参照して中断
    this._resolvePendingWaits(null);        // 確認待ち中の停止で run() がハングしないよう待ちを解放
    this._hideThinking();
    this._hideTypingIndicator();
    this._hideUserTyping();
    this.addMessage('l0', LANG[this._lang].cancelled); // キャンセルの受領も会話エージェント(L0)の声で
    this._setProcessing(false); // 停止(■)→送信(➤)へ復帰
    const input = document.getElementById('chatInput');
    if (input) { input.disabled = false; input.focus(); }
  }

  /** エラー表示＋緑の「やり直す」ボタン（同じクエリを再実行）。通信/上限などを細分化して文言化。 */
  _showErrorWithRetry(err, retryText) {
    this.addMessage('error', this._errorText(err), { retry: retryText });
    // デバッグモードでは生のエラー内容（スタック/メッセージ）も併記して原因追跡できるようにする。
    if (this._debugMode && err) this.addMessage('debug', `⚠️ ${err.message || String(err)}${err.stack ? '\n' + err.stack : ''}`);
  }

  /** エラー種別を文言化（通信・タイムアウト・レート制限など）。 */
  _errorText(err) {
    const t = LANG[this._lang];
    const m = (err && err.message ? String(err.message) : '').toLowerCase();
    if (/abort|cancel/.test(m))                       return t.errCancelled;
    if (/rate|429|too many/.test(m))                  return t.errRateLimit;
    if (/timeout|timed out|etimedout/.test(m))        return t.errTimeout;
    if (/network|failed to fetch|fetch|econn|dns|offline/.test(m)) return t.errNetwork;
    return `${t.errGeneric}${err?.message ? `（${err.message}）` : ''}`;
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
      this.mapboxMCP._matrixRequests = 0;
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
    // 保留中の待ち（デバッグ一時停止/自由入力/フィードバック/選択）をまとめて解決して解放。
    // unknown value(null) → 各フローは何もせず run() が綺麗に戻り、入力が再有効化される。
    this._resolvePendingWaits(null);
    this._hideUserTyping();
    // [fix] 入力欄の再有効化を非同期の巻き戻り(run()→_execQuery.finally)に依存しない。
    // クエリ実行中（フィードバック/ヒント/デバッグ一時停止に達する前＝解決すべき保留が無い状態）に
    // クリアすると、その巻き戻りが発生せず _querying=true / input.disabled=true が残り、空パネルなのに
    // 入力できないバグになる。ここで明示的に中断＋ロック解除＋強制再有効化する（クリア後は必ず入力可能に）。
    // 並行実行の旧run()は _execQuery の _advanceMapGen による世代ガードで描画を止めるので安全。
    this._cancelled = true;   // 実行中クエリを中断（run()/mcp が参照して停止）
    this._querying  = false;  // 実行ロック解除
    { const _in = document.getElementById('chatInput');
      if (_in) _in.disabled = false; }
    this._setProcessing(false); // 送信ボタンを送信(➤)に戻す
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
    this.addMessage('l0', LANG[this._lang].welcome);
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
    if (!this._mapActive()) return; // 地図OFF: マーカー/flyTo はスキップ（候補パネルは別途表示される）
    this.candidateMarkers.forEach(m => m.remove());
    this.candidateMarkers = [];
    if (!candidates || candidates.length === 0) return;

    // Rank-based tiers. Full-match (full1/2/3/full) pulse; top 3 get callouts; #1 focused.
    // 色・サイズ等は共有の TIER_STYLE を単一ソースとして参照（static画像と表示を揃える）。
    const TIER = LocationFinderApp.TIER_STYLE;

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

  // ティア別の見た目（色・サイズ等）の【単一ソース】。interactive マーカーと Static Images API
  // の両方がこれを参照する（仕様変更時に両者がブレないように）。color は #RRGGBB。
  static TIER_STYLE = {
    full1: { size: 22, color: '#f59e0b', ring: '#fde68a', z: 6, glow: true,  label: '🏅 最有力(全一致)', badge: '1' },
    full2: { size: 18, color: '#f59e0b', ring: '#fcd34d', z: 5, glow: true,  label: '2番目(全一致)',    badge: '2' },
    full3: { size: 16, color: '#f59e0b', ring: '#fcd34d', z: 4, glow: true,  label: '3番目(全一致)',    badge: '3' },
    full:  { size: 13, color: '#60a5fa', ring: '#bfdbfe', z: 3, glow: true,  label: '全一致',           badge: '' },
    partial:{ size: 11, color: '#94a3b8', ring: '#cbd5e1', z: 2, glow: false, label: '部分一致',         badge: '' },
    none:  { size: 9,  color: '#64748b', ring: '#475569', z: 1, glow: false, label: '参考',             badge: '' },
  };

  // Per-condition colors for Step1 collection (distinct from target=teal, proximity=orange,
  // eval=violet). Indexed by condition order (ci); MAX_CONDITIONS caps at 5.
  static COND_PALETTE = ['#a855f7', '#ec4899', '#eab308', '#22c55e', '#f43f5e'];

  /**
   * Render candidates as a clickable list in the conversation panel, each with
   * ✓正解 / ✗違う feedback buttons. Feedback is stored in localStorage as ground
   * truth (shared between operator and Claude via CSV export). Available in both
   * normal and debug mode.
   */
  _renderCandidatePanel(full, partial, none, summary, droppedNote) {
    this._hideTypingIndicator();
    this._hideCancelBtn(); // 候補が出たらキャンセルは不要（以降はフィードバック/絞り込み）
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

    // 上限超過で除外した条件を結果の場所でも明示（透明化A）。冒頭の早出し吹き出しは別途残る。
    if (droppedNote) {
      const dn = document.createElement('div');
      dn.className = 'candidate-dropped';
      dn.textContent = droppedNote;
      panel.appendChild(dn);
    }

    // 地図OFF時: 候補パネル先頭に静的地図（Static Images API）を差し込む。上位5件をピン表示。
    // 画像サイズは 320×180 固定なので、その比率の枠を先に確保（レイアウトシフト防止）し、
    // 読み込み中はプレースホルダを表示。画像は非同期で読み込み、届いたら差し替える
    // （候補パネル自体はここで即描画され、画像待ちでブロックしない）。
    if (this._mapOff) {
      const url = this._buildStaticMapUrl([...(full || []), ...(partial || []), ...(none || [])]);
      if (url) {
        if (this.mapboxMCP) this.mapboxMCP._siRequests = (this.mapboxMCP._siRequests || 0) + 1; // Static Images API 1リクエスト
        const L = LANG[this._lang];
        const fig = document.createElement('figure');
        fig.className = 'static-map';

        const box = document.createElement('div');
        box.className = 'static-map-box'; // aspect-ratio 320/180 で領域を先に確保

        const loading = document.createElement('div');
        loading.className = 'static-map-loading';
        loading.textContent = L.staticMapLoading;

        const img = document.createElement('img');
        img.alt = L.staticMapAlt;
        img.decoding = 'async';
        // ハンドラを src より先に設定（キャッシュ即時ロードの取りこぼし防止）
        img.onload  = () => { box.classList.add('loaded'); };
        img.onerror = () => { box.classList.add('error'); loading.textContent = L.staticMapError; };
        img.src = url;

        box.appendChild(loading);
        box.appendChild(img);
        fig.appendChild(box);

        const cap = document.createElement('figcaption');
        cap.textContent = L.staticMapCap;
        fig.appendChild(cap);

        panel.appendChild(fig);
      }
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
      const line = document.createElement('div');
      line.className = 'cand-line';
      line.innerHTML =
        `<span class="cand-rank">${i + 1}</span>` +
        `<span class="cand-icon">${icon}</span>` +
        `<span class="cand-name">${_esc(c.name || '(名前なし)')}</span>` +
        `<span class="cand-score">${scorePct}${dist}</span>`;
      row.appendChild(line);
      row.title = 'クリックで地図上の位置へ';
      row.addEventListener('click', () => this._focusCandidate(c.id, lng, lat));

      // なぜこの候補か（満たした条件・階数）を名前の下に表示。反転条件は（がない/ではない）付き。
      const reasons = Array.isArray(mi.reasons) ? mi.reasons : [];
      if (reasons.length) {
        const rz = document.createElement('div');
        rz.className = 'cand-reasons';
        rz.innerHTML = reasons.map(r => `<span class="cand-reason">${_esc(r)}</span>`).join('');
        row.appendChild(rz);
      }

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
      line.appendChild(fb);
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
    if (!this._mapActive() || lng == null || lat == null) return; // 地図OFF: 何もしない
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
      narrowBbox:  { type: 'FeatureCollection', features: [] },  // overflow re-anchor narrowed search bbox
      narrowLabels:{ type: 'FeatureCollection', features: [] },
      evalPolys:   { type: 'FeatureCollection', features: [] },  // Step2 isochrone/radius reach polygons
      grid:        { type: 'FeatureCollection', features: [] },  // Tilequery collection grid (per-point radius circles)
      gridPts:     { type: 'FeatureCollection', features: [] },  // Tilequery grid center points
      gridSkip:    { type: 'FeatureCollection', features: [] },  // grid points NOT queried (donut hole skip etc.)
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

    // Emerald: Tilequery collection grid — per-point radius circles + center dots.
    // Drawn under the hit points so hits stay readable. Debug-mode only.
    add('dbg-grid', this._dbg.grid, [
      { id: 'dbg-grid-fill', type: 'fill',
        paint: { 'fill-color': '#10b981', 'fill-opacity': 0.1 } },
      { id: 'dbg-grid-line', type: 'line',
        paint: { 'line-color': '#34d399', 'line-width': 1.5, 'line-opacity': 0.9 } },
    ]);
    add('dbg-grid-pts', this._dbg.gridPts, [{
      id: 'dbg-grid-pts-c', type: 'circle',
      paint: { 'circle-radius': 3, 'circle-color': '#34d399', 'circle-opacity': 1,
               'circle-stroke-width': 1, 'circle-stroke-color': '#064e3b' },
    }]);

    // Rose (dashed): grid circles that were NOT queried (donut hole skip). Shown so the
    // saved coverage is visible against the queried grid.
    add('dbg-grid-skip', this._dbg.gridSkip, [
      { id: 'dbg-grid-skip-fill', type: 'fill',
        paint: { 'fill-color': '#f43f5e', 'fill-opacity': 0.04 } },
      { id: 'dbg-grid-skip-line', type: 'line',
        paint: { 'line-color': '#fb7185', 'line-width': 1.4, 'line-opacity': 0.85,
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

    // Rose solid: overflow re-anchor narrowed search bbox + size label (debug-only).
    add('dbg-narrow', this._dbg.narrowBbox, [{
      id: 'dbg-narrow-l', type: 'line',
      paint: { 'line-color': '#f43f5e', 'line-width': 2, 'line-opacity': 0.9 },
    }]);
    const rosePaint = { 'text-color': '#fb7185', 'text-halo-color': 'rgba(8,13,26,0.9)', 'text-halo-width': 1.5 };
    add('dbg-narrow-labels', this._dbg.narrowLabels, [{
      id: 'dbg-narrow-labels-sym', type: 'symbol',
      layout: labelLayout('top', [0, 0.4]),
      paint: rosePaint,
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
      { layer: 'dbg-grid-pts-c',     step: 'step-collect',   label: () => 'Tilequery収集グリッド（各点から半径ぶんを問い合わせ）' },
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
    ['dbg-proximity','dbg-bboxes','dbg-bbox-labels','dbg-narrow','dbg-narrow-labels','dbg-eval-polys','dbg-grid','dbg-grid-pts','dbg-grid-skip','dbg-search-hits','dbg-clusters','dbg-tq-hits','dbg-route-buf','dbg-route-line','dbg-route-labels'].forEach(id => {
      try { this.map.getSource(id)?.setData({ type: 'FeatureCollection', features: [] }); } catch(_){}
    });
    // Reset any step isolation: make all debug layers visible again for the next run.
    this._isolatedStep = null;
    ['dbg-proximity-c','dbg-bboxes-l','dbg-bbox-labels-sym','dbg-narrow-l','dbg-narrow-labels-sym','dbg-grid-fill','dbg-grid-line','dbg-grid-pts-c','dbg-grid-skip-fill','dbg-grid-skip-line','dbg-search-hits-c','dbg-search-hits-l','dbg-tq-hits-c','dbg-tq-hits-l','dbg-clusters-ring','dbg-clusters-label','dbg-eval-polys-fill','dbg-eval-polys-line','dbg-route-buf-f','dbg-route-line-l','dbg-route-labels-sym'].forEach(lid => {
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

  /**
   * Draw the Tilequery collection grid: one radius circle per grid point + a center dot.
   * `circles` = queried points, `skipped` = points not queried (donut hole skip etc.).
   * Both are [{lng, lat, radius}], deduped by rounded coord (shared grids repeat points),
   * capped for performance/readability.
   */
  _drawGridCircles(circles, skipped) {
    if (!this._dbg) return;
    const GRID_CAP = 800;
    const build = (list) => {
      const seen = new Set();
      const circleFeatures = [];
      for (const c of (list || [])) {
        if (c?.lng == null || c?.lat == null) continue;
        const key = `${c.lng.toFixed(5)},${c.lat.toFixed(5)},${c.radius}`;
        if (seen.has(key)) continue;
        seen.add(key);
        try { circleFeatures.push(turf.circle([c.lng, c.lat], c.radius, { steps: 24, units: 'meters' })); } catch (_) {}
        if (circleFeatures.length >= GRID_CAP) break;
      }
      return circleFeatures;
    };
    const keptCircles = build(circles);
    const skipCircles = build(skipped);
    // Center dots only for queried points.
    const ptFeatures = [];
    const seenPt = new Set();
    for (const c of (circles || [])) {
      if (c?.lng == null || c?.lat == null) continue;
      const key = `${c.lng.toFixed(5)},${c.lat.toFixed(5)}`;
      if (seenPt.has(key)) continue;
      seenPt.add(key);
      ptFeatures.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: {} });
      if (ptFeatures.length >= GRID_CAP) break;
    }
    this._dbg.grid.features     = keptCircles;
    this._dbg.gridPts.features  = ptFeatures;
    this._dbg.gridSkip.features = skipCircles;
    console.log('[_drawGridCircles] built', { kept: keptCircles.length, skip: skipCircles.length,
      srcGrid: !!this.map.getSource('dbg-grid'), lyrFill: !!this.map.getLayer('dbg-grid-fill'),
      lyrLine: !!this.map.getLayer('dbg-grid-line'),
      visFill: this.map.getLayer('dbg-grid-fill') ? this.map.getLayoutProperty('dbg-grid-fill','visibility') : 'n/a',
      sample: keptCircles[0]?.geometry?.coordinates?.[0]?.[0] });
    try {
      this.map.getSource('dbg-grid')?.setData(this._dbg.grid);
      this.map.getSource('dbg-grid-pts')?.setData(this._dbg.gridPts);
      this.map.getSource('dbg-grid-skip')?.setData(this._dbg.gridSkip);
    } catch (e) { console.warn('[_drawGridCircles] setData error', e); }
    if (keptCircles.length || skipCircles.length) document.getElementById('mapLegend').style.display = 'block';
  }

  /** Draw the overflow re-anchor narrowed search bbox (debug-only) in rose, with a size label. */
  _drawNarrowBBox(bbox) {
    if (!this._dbg || !bbox || bbox.length < 4) return;
    const [minX, minY, maxX, maxY] = bbox;
    this._dbg.narrowBbox.features = [{
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[[minX,minY],[maxX,minY],[maxX,maxY],[minX,maxY],[minX,minY]]] },
      properties: {},
    }];
    const midLat = (minY + maxY) / 2;
    const wm = Math.round(Math.abs(maxX - minX) * 111320 * Math.cos(midLat * Math.PI / 180));
    const hm = Math.round(Math.abs(maxY - minY) * 110540);
    const label = `絞込 ${wm === hm ? `${wm}m` : `${wm}×${hm}m`}`;
    this._dbg.narrowLabels.features = [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [(minX + maxX) / 2, minY] },
      properties: { label },
    }];
    try {
      this.map.getSource('dbg-narrow')?.setData(this._dbg.narrowBbox);
      this.map.getSource('dbg-narrow-labels')?.setData(this._dbg.narrowLabels);
    } catch (_) {}
    document.getElementById('mapLegend').style.display = 'block';
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
  // JS-Driven Entry Point (replaces agentic Claude loop)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Delegate to QueryEngine (JS-driven architecture).
   * @param {string} userText
   */
  async processUserMessage(userText) {
    this._resetFlowState();
    this._lastQuery = userText; // captured for ground-truth feedback rows
    if (this._mapActive()) this.map.flyTo({ zoom: 10, duration: 900, essential: true }); // 地図OFF時はスキップ
    await this.queryEngine.run(userText);
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
  /** チャット内「考えています…」タイピング吹き出し（送信〜最初の応答の間の“間”を埋める）。 */
  _showTypingIndicator(label) {
    this._hideTypingIndicator(); // 重複防止（タイマーもクリア）
    const container = document.getElementById('chatMessages');
    if (!container) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'message assistant typing-indicator';
    wrapper.id = 'typingIndicator';
    const lbl = document.createElement('div');
    lbl.className = 'msg-label';
    lbl.textContent = LANG[this._lang].roleAssistant;
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.innerHTML =
      `<span class="typing-text">${label || LANG[this._lang].thinking}</span>` +
      `<span class="typing-dots"><span></span><span></span><span></span></span>` +
      `<span class="typing-elapsed" id="typingElapsed"></span>`; // 経過秒（カウントアップ・正直な安心表示）
    wrapper.appendChild(lbl); wrapper.appendChild(bubble);
    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;
    this._pinCancelToBottom(); // 考え中の下にキャンセルを維持
    // 経過秒を毎秒更新（残りカウントダウンは不確実なので出さない）
    const t0 = Date.now();
    const en = this._lang === 'en';
    const elEl = document.getElementById('typingElapsed');
    const tick = () => { if (elEl) elEl.textContent = ` ${Math.round((Date.now() - t0) / 1000)}${en ? 's' : '秒'}`; };
    tick();
    this._typingTimer = setInterval(tick, 1000);
  }
  _hideTypingIndicator() {
    if (this._typingTimer) { clearInterval(this._typingTimer); this._typingTimer = null; }
    document.getElementById('typingIndicator')?.remove();
  }

  addMessage(role, text, opts = {}) {
    this._hideTypingIndicator(); // 実メッセージが出る＝考え中を消す
    const container = document.getElementById('chatMessages');

    const t = LANG[this._lang];
    const roleLabels = {
      user:           t.roleUser,
      assistant:      t.roleAssistant,
      l0:             t.roleL0,
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

    // 緑の「やり直す」ボタン（エラー時など、同じクエリを再実行）
    if (opts.retry) {
      const btn = document.createElement('button');
      btn.className = 'btn-retry';
      btn.textContent = LANG[this._lang].retryBtn;
      btn.onclick = () => this._execQuery(opts.retry);
      wrapper.appendChild(btn);
    }

    // 任意アクションボタン（例：デバッグの QuerySchema JSON モーダル表示）
    if (Array.isArray(opts.actions)) {
      for (const a of opts.actions) {
        const btn = document.createElement('button');
        btn.className = 'btn-action';
        btn.style.cssText = 'cursor:pointer;margin-top:8px;background:#3a3f4b;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.9em';
        btn.textContent = a.label;
        btn.onclick = a.onClick;
        wrapper.appendChild(btn);
      }
    }

    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;
    this._pinCancelToBottom(); // キャンセル吹き出しを最下部に維持
  }

  /** [デバッグ] 生成された QuerySchema を JSON でモーダル表示＋クリップボードコピー。 */
  _showSchemaModal(schema) {
    const json = JSON.stringify(schema ?? {}, null, 2);
    const en = this._lang === 'en';
    let overlay = document.getElementById('schemaModal');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'schemaModal';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:9999;padding:24px';
      const card = document.createElement('div');
      card.style.cssText = 'background:#1b1f27;color:#e6e6e6;border:1px solid #333;border-radius:10px;max-width:760px;width:100%;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.5)';
      const head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #333;gap:12px';
      const title = document.createElement('div');
      title.style.cssText = 'font-weight:600';
      title.textContent = 'QuerySchema (JSON)';
      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:8px;flex:none';
      const copyBtn = document.createElement('button');
      copyBtn.style.cssText = 'cursor:pointer;background:#2b6cb0;color:#fff;border:0;border-radius:6px;padding:6px 12px';
      const closeBtn = document.createElement('button');
      closeBtn.style.cssText = 'cursor:pointer;background:#3a3f4b;color:#fff;border:0;border-radius:6px;padding:6px 12px';
      btns.append(copyBtn, closeBtn);
      head.append(title, btns);
      const pre = document.createElement('pre');
      pre.style.cssText = 'margin:0;padding:16px;overflow:auto;font-size:12.5px;line-height:1.5;white-space:pre;flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,monospace';
      card.append(head, pre);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      const close = () => { overlay.style.display = 'none'; };
      closeBtn.onclick = close;
      overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay.style.display === 'flex') close(); });
      overlay._pre = pre; overlay._copyBtn = copyBtn; overlay._closeBtn = closeBtn;
    }
    overlay._closeBtn.textContent = en ? 'Close' : '閉じる';
    overlay._pre.textContent = json;
    const copyBtn = overlay._copyBtn;
    const rest = () => { copyBtn.textContent = en ? '📋 Copy' : '📋 コピー'; };
    rest();
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(json);
        copyBtn.textContent = en ? '✓ Copied' : '✓ コピーしました';
      } catch {
        const r = document.createRange(); r.selectNodeContents(overlay._pre);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        copyBtn.textContent = en ? '⚠ Select + Ctrl/⌘C' : '⚠ 選択して Ctrl/⌘C';
      }
      setTimeout(rest, 1600);
    };
    overlay.style.display = 'flex';
  }

  /** Render the hint request panel in chat and wait for operator input.
   *  自由入力は本体の入力欄に統合（_pendingInputResolver 経由）。パネルには提案ボタンとスキップのみ。 */
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
        sugList.map((s, i) => `<button class="choice-btn hint-suggest-btn" data-i="${i}">${i + 1}. ${_esc(s.text)}</button>`).join('') +
        `</div>`
      : '';
    const wrapper = document.createElement('div');
    wrapper.className = 'message hint-request';
    wrapper.innerHTML = `
      <div class="msg-label">${ht.hintTitle(this.config.HINT_EXTRA_TURNS)}</div>
      <div class="hint-bubble">
        ${sugHTML}
        <div class="hint-actions">
          <button class="hint-skip-btn" id="${uid}-skip">${ht.hintSkip}</button>
        </div>
      </div>
    `;
    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;

    const disableAll = () => wrapper.querySelectorAll('.hint-suggest-btn, .hint-skip-btn')
      .forEach(b => { b.disabled = true; });

    // 回答が来たら待ちを解除し、送信ボタンを処理中(■)へ戻してから onResponse を呼ぶ
    // （回答待ち中は _setProcessing(false) で➤にしているため、resolve時に必ず■へ戻す）。
    const settle = (value) => {
      this._pendingInputResolver = null;
      disableAll();
      this._setProcessing(true);
      onResponse(value);
    };

    // 自由入力は本体の入力欄で受ける。回答待ち中は「送信＝この回答を送る」なので送信ボタンを
    // ➤ に戻す（■のままだと押下がキャンセル扱いになり、回答を送信する手段が無くなる）。
    // 番号（提案ボタンの番号）ならJSの決定的な処理で選ぶ。それ以外は今までどおり自由記述ヒント。
    this._pendingInputResolver = (text) => {
      const idx = sugList.length ? this._parseChoiceSelection(text, sugList.length) : null;
      settle(idx != null ? sugList[idx] : text);
    };
    this._setProcessing(false);
    const mainInput = document.getElementById('chatInput');
    if (mainInput) { mainInput.disabled = false; mainInput.focus(); }

    // Suggestion click = submit that suggestion object.
    if (sugList.length) {
      wrapper.querySelectorAll('.hint-suggest-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const s = sugList[+btn.dataset.i];
          this.addMessage('user', s.text);
          settle(s); // resolve with the suggestion object (carries resolved items)
        });
      });
    }

    document.getElementById(`${uid}-skip`).addEventListener('click', () => {
      wrapper.querySelector('.hint-bubble').style.opacity = '0.5';
      settle(null);
    });
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
      this._choiceResolve = resolve; // 停止/クリア時に解放できるよう保持
      const container = document.getElementById('chatMessages');
      const uid = `choice-${Date.now()}`;

      const wrapper = document.createElement('div');
      wrapper.className = 'message choice-request';
      wrapper.innerHTML = `
        <div class="msg-label">🔀 選択</div>
        <div class="choice-bubble">
          <div class="choice-buttons" id="${uid}-btns">
            ${choices.map((c, i) =>
              `<button class="choice-btn" id="${uid}-btn-${i}">${i + 1}. ${_esc(c)}</button>`
            ).join('')}
          </div>
        </div>
      `;
      container.appendChild(wrapper);
      container.scrollTop = container.scrollHeight;

      // 選択確定（ボタンクリック／番号入力どちらの経路からも呼ぶ）。fromClick=trueの時だけ
      // ここで自分のuserバブルを出す（番号入力は _handleSend が既に入力テキストを表示済み）。
      const finalize = (i, fromClick) => {
        choices.forEach((_, j) => {
          const btn = document.getElementById(`${uid}-btn-${j}`);
          if (btn) { btn.disabled = true; btn.classList.toggle('choice-btn-selected', j === i); }
        });
        if (fromClick) this.addMessage('user', choices[i]);
        this._choiceResolve = null;
        this._pendingInputResolver = null;
        // Return the RAW choice string (QueryEngine matches it by index).
        // (Old agentic loop used a "選択: " prefix; that broke index matching.)
        resolve(choices[i]);
      };

      choices.forEach((choice, i) => {
        document.getElementById(`${uid}-btn-${i}`).addEventListener('click', () => finalize(i, true));
      });

      // 本体入力欄からの番号入力にも対応（ボタンは残したまま・番号は決定的なJS処理）。
      const handleTyped = (text) => {
        // text==null は停止/クリア時の _resolvePendingWaits シグナル。ここでは何もしない
        // （直後に _choiceResolve(null) が呼ばれ、そちらが待ちの終了を処理する）。
        if (text == null) return;
        const idx = this._parseChoiceSelection(text, choices.length);
        if (idx != null) { finalize(idx, false); return; }
        this.addMessage('l0', LANG[this._lang].pickNumberHint);
        this._pendingInputResolver = handleTyped; // 待ちを継続
        const mi = document.getElementById('chatInput');
        if (mi) { mi.disabled = false; mi.focus(); }
      };
      this._pendingInputResolver = handleTyped;
      const mainInput = document.getElementById('chatInput');
      if (mainInput) { mainInput.disabled = false; mainInput.focus(); }
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

    // Map toggle button (respect current state)
    const mapBtn = document.getElementById('mapToggleBtn');
    if (mapBtn) mapBtn.textContent = this._mapOff ? t.mapShow : t.mapHide;
    // （キャンセルボタンは処理中に動的生成する吹き出しなのでここでは扱わない）

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
      setText('set-l1c-label', st.l1confirm);
      setText('set-l1-label', st.l1);
      setText('set-l1_3-label', st.l1_3);
      setText('set-l2_1-label', st.l2_1);
      setText('set-l2_2-label', st.l2_2);
      setText('set-l3-label', st.l3);
      setText('set-l1c-why', st.l1cWhy);
      setText('set-l1-why', st.l1Why);
      setText('set-l1_3-why', st.l1_3Why);
      setText('set-l2_1-why', st.l2_1Why);
      setText('set-l2_2-why', st.l2_2Why);
      setText('set-l3-why', st.l3Why);
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
      // 言い切り度の値ラベル（例: 「言い切り度 100%」）も言語に追従
      const dv = document.getElementById('decisivenessVal');
      if (dv && st.decLabel) dv.textContent = `${st.decLabel} ${Math.round((this.config.SCORE_DECISIVENESS ?? 1) * 100)}%`;
      setText('set-score-note', st.scoreNote);
      // tabs
      setText('set-tab-basic', st.tabBasic);
      setText('set-tab-score', st.tabScore);
      setText('set-tab-judge', st.tabJudge);
      // 判定方式 tab
      setLead('set-judge-title', st.judgeTitle);     setText('set-judge-hint', st.judgeHint);
      setText('set-samebuilding-row', st.sameBuildingRow);
      setText('set-floors-row', st.floorsRow);
      setText('set-sb-hard', st.hardOpt); setText('set-sb-soft', st.softOpt);
      setText('set-fl-hard', st.hardOpt); setText('set-fl-soft', st.softOpt);
      setText('set-judge-note', st.judgeNote);
      setText('settingsResetBtn', st.resetBtn);
      setText('settingsCloseBtn', st.closeBtn);
      setText('settingsBtn', st.settingsBtn); // ヘッダーの設定ボタン（英語/日本語）
    }
    this._markRecommendedModels?.(); // 「（推奨）」/「(Recommended)」を現在の言語で付け直す

    // Update welcome message if conversation hasn't started yet
    const hasUserMsg = document.querySelectorAll('#chatMessages .message.user').length > 0;
    if (!hasUserMsg) {
      const firstBubble = document.querySelector('#chatMessages .message.l0 .message-bubble');
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
    const mx = document.getElementById('api-counter-mx');
    if (mx) mx.textContent = `MX: ${this.mapboxMCP?._matrixRequests ?? 0} req`;
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
    mapHide:       '🗺 地図表示OFF',
    mapShow:       '🗺 地図表示ON',
    staticMapCap:  '上位5件まで表示',
    staticMapAlt:  '検索結果の地図（上位5件）',
    staticMapLoading: '地図を読み込み中…',
    staticMapError:   '地図を読み込めませんでした',
    thinking:      '考えています',
    examplesLabel: '入力例',
    mapReady:      '地図の準備ができました',
    mapLoading:    '地図を読み込み中…',
    welcome: 'こんにちは、ジオネーターです！どこを探しますか？',
    // Chat role labels
    roleUser:      'オペレーター',
    roleAssistant: 'AI エージェント',
    roleL0:        'ジオネーター',
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
    pickNumberHint:   '番号（例: 1）か「最初」「真ん中」「最後」などでお答えください。ボタンをクリックしてもOKです。',
    // Processing
    connecting:       'Claude APIに接続中…',
    pausedHint:       '⏸ 追加情報を待っています...',
    retryBtn:         '🔄 やり直す',
    cancelBtn:        'キャンセルする',
    cancelled:        'キャンセルしました。',
    errGeneric:       'エラーが発生しました。もう一度お試しください。',
    errNetwork:       '通信エラーが発生しました。ネットワークを確認してもう一度お試しください。',
    errTimeout:       '応答がタイムアウトしました。もう一度お試しください。',
    errRateLimit:     'リクエストが集中しています（レート制限）。少し待ってからやり直してください。',
    errCancelled:     'キャンセルされました。',
    capWarnHead:      '⚠ 一部のデータ取得が上限に達し、候補が抜けている可能性があります：',
    capTQ:            n => `・Tilequery が上限(${n}回)に到達（設定で引き上げ可）`,
    capSB:            n => `・Search Box が上限(${n}回)に到達（設定で引き上げ可）`,
    capISO:           n => `・Isochrone が上限(${n}回)に到達（設定で引き上げ可）`,
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
      settingsBtn: '⚙️ 設定',
      l1confirm:   'L1-1（確認文の先出し）',
      l1:          'L1-2（クエリ解析）',
      l1_3:        'L1-3（広域の絞り込み・地名の解釈）',
      l2_1:        'L2-1（通常クエリの関連性・カテゴリ）',
      l2_2:        'L2-2（Targetの関連性）',
      l3:          'L3（絞り込みの目印提案）',
      l1cWhy:      'ユーザーの依頼を一文で復唱して確認するだけの軽量処理。解析(L1-2)と並行して真っ先に出すので、速さ優先で Haiku 推奨。',
      l1Why:       '自然文→構造化スキーマの最重要工程。目印(proximity)と対象(target)の切り分け、「AとBの間」等の解釈に推論力が要る → Sonnet推奨。',
      l1_3Why:     'proximityが広すぎる時（「鎌倉市」→駅/エリア列挙）や、口語的な地名の解釈（「青山」→南青山/北青山の「もしかして」）を世界知識で担う。実在検証はJSが行うので実在地名を精度良く挙げる力が要る → Sonnet推奨。',
      l2_1Why:     'カテゴリの分野判断（ラーメン屋＝「レストラン>和食」を残す等）にニュアンスが要る → Sonnet推奨。',
      l2_2Why:     '店名の機微から意図一致を4段階判定（definitely/probably/…） → Sonnet推奨。',
      l3Why:       '近傍の目印から区別しやすいものを選ぶ軽量・定型タスク → Haikuで十分・高速。',
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
      decLabel:    '言い切り度',
      scoreNote:   '※ スコアの変更は次の検索から反映されます',
      tabBasic:    '基本',
      tabScore:    'スコア',
      tabJudge:    '判定方式',
      judgeTitle:  '判定方式',
      judgeHint:   '（ハード=候補から除外 / ソフト=スコア加点）',
      sameBuildingRow: '同じビル（same_building）',
      floorsRow:   '階数（floors）',
      hardOpt:     'ハード（除外）',
      softOpt:     'ソフト（加点）',
      judgeNote:   '※ ハードは条件を満たさない候補を除外、ソフトは満たすほど加点します。判定不能（建物データ無し等）の候補は除外しません。変更は次の検索から反映されます。',
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
    mapHide:       '🗺 Map OFF',
    mapShow:       '🗺 Map ON',
    staticMapCap:  'Showing up to top 5',
    staticMapAlt:  'Result map (top 5)',
    staticMapLoading: 'Loading map…',
    staticMapError:   'Could not load the map',
    thinking:      'Thinking',
    examplesLabel: 'Examples',
    mapReady:      'Map ready',
    mapLoading:    'Loading map…',
    welcome: 'Hi, I\'m Geonator! Where would you like to search?',
    roleUser:      'Caller',
    roleAssistant: 'AI Agent',
    roleL0:        'Geonator',
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
    pickNumberHint:   'Please reply with a number (e.g. 1) or a word like "first"/"middle"/"last" — or just click a button.',
    connecting:       'Connecting to Claude…',
    pausedHint:       '⏸ Waiting for your input…',
    retryBtn:         '🔄 Retry',
    cancelBtn:        'Cancel',
    cancelled:        'Cancelled.',
    errGeneric:       'Something went wrong. Please try again.',
    errNetwork:       'Network error. Check your connection and try again.',
    errTimeout:       'The request timed out. Please try again.',
    errRateLimit:     'Too many requests (rate limit). Please wait a moment and retry.',
    errCancelled:     'Cancelled.',
    capWarnHead:      '⚠ Some data hit its per-query limit; a few candidates may be missing:',
    capTQ:            n => `・Tilequery hit its limit (${n}); raise it in settings`,
    capSB:            n => `・Search Box hit its limit (${n}); raise it in settings`,
    capISO:           n => `・Isochrone hit its limit (${n}); raise it in settings`,
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
      settingsBtn: '⚙️ Settings',
      l1confirm:   'L1-1 (early confirmation)',
      l1:          'L1-2 (query parsing)',
      l1_3:        'L1-3 (broad-area narrowing · place interpretation)',
      l2_1:        'L2-1 (general-query relevance · category)',
      l2_2:        'L2-2 (target relevance)',
      l3:          'L3 (refinement landmark suggestions)',
      l1cWhy:      'Just restates the user request in one line, in parallel with parsing (L1-2), shown first — so speed matters. Haiku recommended.',
      l1Why:       'The heaviest reasoning step: free text → structured schema (proximity vs target, "between A and B", etc.). Sonnet recommended.',
      l1_3Why:     'Handles broad proximities (e.g. "Kamakura City" → list stations/areas) and colloquial place interpretation (e.g. "Aoyama" → "did you mean Minami-Aoyama/Kita-Aoyama") from world knowledge. JS grounds them via Search Box, so accurate real place names matter. Sonnet recommended.',
      l2_1Why:     'Judging category domains needs nuance (keep "restaurant>Japanese" for a ramen shop). Sonnet recommended.',
      l2_2Why:     'Rates intent match from subtle name cues (4 levels: definitely/probably/…). Sonnet recommended.',
      l3Why:       'Lightweight, templated: pick distinguishing nearby landmarks. Haiku is enough and fast.',
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
      decLabel:    'Decisiveness',
      scoreNote:   '※ Scoring changes apply from the next search',
      tabBasic:    'Basic',
      tabScore:    'Score',
      tabJudge:    'Match mode',
      judgeTitle:  'Match mode',
      judgeHint:   '(hard = exclude candidates / soft = score bonus)',
      sameBuildingRow: 'Same building (same_building)',
      floorsRow:   'Floor count (floors)',
      hardOpt:     'Hard (exclude)',
      softOpt:     'Soft (bonus)',
      judgeNote:   '※ Hard excludes candidates that fail the criterion; soft adds a score bonus the closer they match. Candidates that can\'t be judged (no building data, etc.) are not excluded. Applies from the next search.',
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
