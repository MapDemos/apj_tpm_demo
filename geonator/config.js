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
  L1_MODEL:        'claude-haiku-4-5-20251001', // query parsing（構造化・軽量でHaiku既定）
  // L2 is split into two independent checks (both changeable in settings):
  //   L2-1 = 通常クエリのcategory妥当性チェック（poi_category/class を見る・軽量→Haiku既定）
  //   L2-2 = Targetの関連性チェック（名前ベースのニュアンス判定→Sonnet既定）
  L2_1_MODEL:      'claude-sonnet-4-6',         // category validity（分野判断にニュアンスが要る→Sonnet既定。Haikuは飲食下位分類等を誤除外しがち）
  L2_2_MODEL:      'claude-sonnet-4-6',         // target relevance（名前ニュアンス→Sonnet既定）
  L3_MODEL:        'claude-haiku-4-5-20251001', // 絞り込み提案（近傍ランドマークから目印提案→Haiku既定）
  // L2-1 strictness: カテゴリ情報が無い(null)候補を残すか。true=含める、
  // false=含めない(既定・厳密・カテゴリで裏取りできない候補を落とす)。設定画面で切替可。
  L2_1_KEEP_NULL_CATEGORY: false,

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
  MAX_CONDITIONS:      3,            // conditionの最大数（0-5、設定画面で変更可・超過分は切り捨て）
  BBOX_MAX_HALF_M:     2000,         // max half-width of primary search bbox in meters (§6-3)
  // API safety caps per query (reset each query / on page refresh). Prevents runaway usage.
  TQ_MAX_PER_QUERY:    2000,         // Tilequery
  SB_MAX_PER_QUERY:    100,          // Search Box
  ISO_MAX_PER_QUERY:   100,          // Isochrone

  // ============================================
  // SCORING / TIERING (統計レビュー 2026-07-05 / 3要素化 2026-07-06)
  // score = (w_rel×relScore + w_cond×condScore + w_anchor×anchorScore) を利用可能な
  //   要素だけで正規化(重みの合計で割る)した重み付き和。
  //   relScore   = 意図一致度(4段階): 絶対そう1.0 / 多分そう / わからない（「違う」はrateで除外）
  //   condScore  = 条件(ローソン・バス停等)との近さ平均(0..1、非ヒットは0)
  //   anchorScore= proximityアンカー(例:西大島)からの近さ = 1 − 距離/アンカー参照半径
  // ティアは「絶対ゲート(GOLD_MIN_SCORE)＋マージン(1位-2位)」で決定。
  //   range(max-min)はnと外れ値に交絡、zスコア/パーセンタイルはn≤3で破綻のため不採用。
  // ※ 暫定既定値。設定画面のスライダー3本(関連性/条件距離/アンカー距離)＋言い切り度で調整、
  //   最終は検証セット(#5)で較正。重みは相対値で内部正規化するので合計1でなくてよい。
  // ============================================
  SCORE_WEIGHT_RELEVANCE: 0.30,  // 関連性(意図一致)の重み
  SCORE_WEIGHT_CONDITION: 0.50,  // 条件(ローソン・バス停等)からの距離の重み
  SCORE_WEIGHT_ANCHOR:    0.20,  // proximityアンカー(西大島等)からの距離の重み
  SCORE_DECISIVENESS:     1.0,   // 言い切り度(0=慎重…1=言い切り)。既定は言い切り(100%)。高いほど僅差でもgoldを立てる→GOLD_MARGINを縮める
  // 4段階relevanceのスコア(「違う」はrateで除外)。ネガティブ強め: わからないは控えめに低く。
  SCORE_REL_DEFINITELY:   1.0,   // 絶対そう
  SCORE_REL_PROBABLY:     0.7,   // 多分そう
  SCORE_REL_UNKNOWN:      0.4,   // わからない（既定・不確実は控えめ）
  GOLD_MIN_SCORE:         0.5,   // gold候補の絶対スコア下限（固定のゴミ足切り。全件低スコアなら単独fullでもgold不可）
  SCORE_WEIGHT_FLOORS:    0.4,   // target階数(floors)一致の重み。FLOORS_MODE='soft'時のみ加算（|指定−実階|で減衰）

  // 判定方式（ハード=採点前に除外 / ソフト=加点）。デフォルトは両方ハード。
  SAME_BUILDING_MODE:     'hard', // 'hard'（同ビル以外を除外）| 'soft'（同ビルを加点条件として採点）
  FLOORS_MODE:            'hard', // 'hard'（階数条件外を除外）| 'soft'（階数一致をファジー加点）
  FLOORS_HARD_TOL:        0,      // FLOORS_MODE='hard'かつvalue指定時の許容（±階）。0=完全一致（「10階建て」は10階のみ）。丸め誤差を許すなら1に

  DEBUG: true,
};
