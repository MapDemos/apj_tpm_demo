/**
 * Configuration for geonator_lite (headless POI search tool).
 *
 * Forked from geonator/config.js — stripped of settings tied to features that
 * geonator_lite does not implement (L0 conversation layer, choice/confirmation UI,
 * multi-turn refine, tier/confidence labels, grid-based Tilequery sampling,
 * per-role model selection). See IMPLEMENTATION_SPEC.md §2 for the full list.
 *
 * API Keys:
 * - Mapbox Token: https://account.mapbox.com/access-tokens/
 * - Claude API Proxy: Lambda endpoint (pass-through to Anthropic) — same infra as geonator (spec §9).
 */

const CONFIG = {

  APP_VERSION: '2026-08-01.1',

  // ============================================
  // API KEYS (same infra as geonator — spec §9)
  // ============================================

  MAPBOX_ACCESS_TOKEN: 'pk.eyJ1IjoiMTBkYTAzMnkiLCJhIjoiY21wYzUxZmc3MDRzaDJxczczb25qbW9reSJ9.xU6N9Srt9xw2U2HZbHubSw',

  CLAUDE_API_PROXY: 'https://okqfpyxf4oe6htegrlcgrwdssa0yoxcr.lambda-url.us-east-1.on.aws/',

  // ============================================
  // CLAUDE SETTINGS
  // ============================================

  // Single model field (spec §7.2) — used for both L1 and L2 calls. No per-role
  // model selection (geonator's L0/L1/L1_3/L2_1/L2_2/L3 split is not implemented).
  MODEL: 'claude-haiku-4-5-20251001',

  // ============================================
  // MAPBOX API ENDPOINTS
  // ============================================

  SEARCH_BOX_API:   'https://api.mapbox.com/search/searchbox/v1/forward',
  CATEGORY_SEARCH_API: 'https://api.mapbox.com/search/searchbox/v1/category', // + /{canonical_id} (max limit=25)
  TILEQUERY_API:    'https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery',

  // ============================================
  // SEARCH PARAMETERS (spec §5 — single-shot Tilequery, no grid)
  // ============================================

  TILEQUERY_LIMIT: 50, // Tilequery API max (spec §5.1)

  // Single-shot Tilequery radius (meters). Spec §5.2: "radius has no documented
  // upper bound, so use the practically-largest value" — but real-world latency at
  // this radius has NOT been measured yet (no network access during implementation).
  // 50000m is a starting point per the spec's own example; MUST be tuned against
  // real API latency before shipping (see final report / spec §10).
  TILEQUERY_RADIUS_M: 50000,

  useCategorySearch: true, // Search Box poi_category resolution (category-taxonomy.js) — same as geonator

  // ============================================
  // JS-DRIVEN PIPELINE SETTINGS
  // ============================================

  DEFAULT_LEVEL: 'very_close', // distance level when user gives no distance expression (distance-table.js)
  useIsochrone:  true,         // false → turf.circle approximation instead of Isochrone API calls
  MAX_CONDITIONS: 3,           // max conditions kept from L1 output (extras silently dropped — no UI to notify)
  CANDIDATE_LIMIT: 150,        // max candidates collected per query (post reach-filter, pre-scoring)

  // Near-extent defaults (when proximity.within is not specified) — same values as geonator.
  NEAR_POI_M:             400,
  NEAR_STATION_M:         600,
  NEAR_LOCALITY_M:        800,

  // API timeouts/retries
  API_TIMEOUT_MS:        8000,
  L1_TIMEOUT_MS:         20000,
  SLOW_MODEL_TIMEOUT_MS: 20000,
  API_MAX_RETRY:         1,
  L1_MAX_RETRY:          1,
  L1_MAX_TOKENS:         6000,

  // API safety caps per query (reset each searchPOI() call). Grid removal means the
  // real call count is far below these ceilings in practice (spec §5.3).
  TQ_MAX_PER_QUERY:  200,
  SB_MAX_PER_QUERY:  100,
  ISO_MAX_PER_QUERY: 100,

  // ============================================
  // SCORING (spec §7.1/§7.2) — no tier/confidence labels, just score → rank.
  // ============================================
  SCORE_WEIGHT_RELEVANCE: 0.20,
  SCORE_WEIGHT_CONDITION: 0.70,
  SCORE_WEIGHT_ANCHOR:    1.00,

  SCORE_REL_DEFINITELY: 1.0,
  SCORE_REL_PROBABLY:   0.7,
  SCORE_REL_UNKNOWN:    0.4,

  // Precision-over-recall (see project memory): results scoring below this are dropped
  // entirely rather than shown as low-confidence padding. 0 disables filtering.
  SCORE_MIN_THRESHOLD: 0.3,

  // If the top score(s) are a clear statistical outlier from the rest (modified Z-score
  // via median+MAD — robust to small/skewed samples, unlike mean/stdev which the outlier
  // itself would distort), show only the standout result(s) instead of the full list.
  OUTLIER_MIN_N: 4,        // need at least this many (post-threshold) candidates for MAD to be meaningful
  OUTLIER_Z_THRESHOLD: 3.5, // Iglewicz & Hoaglin's standard modified-Z-score cutoff
  OUTLIER_MAD_ZERO_GAP: 0.05, // fallback absolute-gap threshold when MAD=0 (a big tied cluster + a standout — z-score is undefined there, not "no outlier")

  DEBUG: true,
};
