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
  MAX_TOKENS:      4096,
  TEMPERATURE:     0.7,
  MAX_TOOL_TURNS:  20,   // max agentic loop iterations

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
  // HINT SYSTEM
  // ============================================

  MAX_HINT_TURNS:  8,   // tool turns before asking user for hints
  HINT_EXTRA_TURNS: 5,  // extra turns allowed after hint received

  DEBUG: true,
};
