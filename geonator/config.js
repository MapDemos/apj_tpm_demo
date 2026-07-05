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
  // score = w_prox×condScore + w_rel×relScore の重み付き和。
  //   condScore = 条件との近さ(0..1、非ヒットは0で算入)
  //   relScore  = 意図一致度: exact=1.0 / related=SCORE_RELATED
  //   w_prox    = SCORE_WEIGHT_PROXIMITY, w_rel = 1 - w_prox
  // ティアは「絶対ゲート(GOLD_MIN_SCORE)＋マージン(1位-2位)」で決定。
  //   range(max-min)はnと外れ値に交絡、zスコア/パーセンタイルはn≤3で破綻のため不採用。
  // ※ 下記は暫定既定値。設定画面のスライダー/プリセットで調整、最終は検証セット(#5)で較正。
  //   スライダー2本 = SCORE_WEIGHT_PROXIMITY（意図⟷近さ）と SCORE_DECISIVENESS（言い切り度）。
  // ============================================
  SCORE_WEIGHT_PROXIMITY: 0.65,  // バランス: 近さの重み(0=意図重視 … 1=近さ重視)。既定は近さ寄り＝relevance関与ダウン
  SCORE_RELATED:          0.6,   // relatedの意図スコア(exact=1.0固定)。重み付き和なのでrelatedでも近ければgold到達可
  SCORE_DECISIVENESS:     0.4,   // 言い切り度(0=慎重…1=言い切り)。高いほど僅差でもgoldを立てる→GOLD_MARGINを縮める
  GOLD_MIN_SCORE:         0.5,   // gold候補の絶対スコア下限（固定のゴミ足切り。全件低スコアなら単独fullでもgold不可）

  DEBUG: true,
};
