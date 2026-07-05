/**
 * Configuration for Emergency Location Finder AI Agent
 *
 * API Keys:
 * - Mapbox Token: https://account.mapbox.com/access-tokens/
 * - Claude API Proxy: Lambda endpoint (pass-through to Anthropic)
 */

const CONFIG = {

  // ============================================
  // API KEYS
  // ============================================

  MAPBOX_ACCESS_TOKEN: 'pk.eyJ1IjoiMTBkYTAzMnkiLCJhIjoiY21xenh6aHhoMDYxczJ0c2JqNHRiY3V5MiJ9.5l2MhlYwz0vqKNZ9bPcDyQ',

  CLAUDE_API_PROXY: 'https://okqfpyxf4oe6htegrlcgrwdssa0yoxcr.lambda-url.us-east-1.on.aws/',

  // ============================================
  // CLAUDE SETTINGS
  // ============================================

  CLAUDE_MODEL:    'claude-sonnet-4-6',
  MAX_TOKENS:      16000,
  TEMPERATURE:     0,
  MAX_TOOL_TURNS:  20,   // max agentic loop iterations

  // Per-role models (JS-driven arch). Changeable from the ⚙️ settings modal.
  L1_MODEL:        'claude-sonnet-4-6',        // query parsing (needs stronger reasoning)
  L2_MODEL:        'claude-haiku-4-5-20251001', // candidate filter (cheap/fast, high volume)

  // ============================================
  // MAP SETTINGS
  // ============================================

  DEFAULT_MAP_CENTER: [139.7671, 35.6812],  // Tokyo
  DEFAULT_MAP_ZOOM:   11,
  MAP_STYLE:          'mapbox://styles/10da032y/cmp1u9qjm000e01r6c7y514hh',

  // ============================================
  // MAPBOX API ENDPOINTS
  // ============================================

  SEARCH_BOX_API:  'https://api.mapbox.com/search/searchbox/v1/forward',
  TILEQUERY_API:   'https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery',

  // ============================================
  // SEARCH PARAMETERS
  // ============================================

  TILEQUERY_LIMIT: 50,   // Tilequery results limit (dedupe enabled)

  // ============================================
  // APPLICATION SETTINGS
  // ============================================

  // ============================================
  // HINT SYSTEM (deprecated — agentic loop removed)
  // ============================================

  MAX_HINT_TURNS:   20, // deprecated
  HINT_EXTRA_TURNS:  5, // deprecated

  // ============================================
  // JS-DRIVEN ARCHITECTURE (systemdesign v2.0)
  // ============================================

  DEFAULT_LEVEL:       'very_close', // distance level when user gives no distance expression
  MAX_CLARIFY_TURNS:   3,            // max clarification loops before best-effort (HH)
  API_TIMEOUT_MS:      8000,         // per-API-call timeout in ms (GG)
  API_MAX_RETRY:       1,            // retries on timeout (GG)
  L1_MAX_RETRY:        1,            // L1 JSON invalid → retry count (II)
  CANDIDATE_LIMIT:     150,          // max candidates collected per query
  BBOX_MAX_HALF_M:     2000,         // max half-width of primary search bbox in meters (§6-3)

  // ============================================
  // SCORING / TIERING (統計レビュー 2026-07-05)
  // 絶対ゲート＋マージン方式。range(max-min)はサンプル数nと外れ値に交絡するため廃止。
  // zスコア/パーセンタイルはn≤3で破綻するため主軸にしない。
  // ※ 下記は暫定値。人手ラベル付き検証セット(#5)でgrid searchして較正すること。
  // ============================================
  GOLD_MIN_SCORE: 0.5,   // gold候補が満たすべき絶対スコア下限（score=relMult×condScore）。
                         //   related(≤0.35)は構造的にgold不可＝relevanceゲートを内包。
                         //   exactはcondScore≥0.5（参照距離の半分以内）が必要。
  GOLD_MARGIN:    0.15,  // 単独goldを認める「1位−2位」の差。n非依存・min側外れ値に不感。
                         //   これ未満は同程度(match)扱いでgoldを出さない（どんぐり検知）。

  DEBUG: true,
};
