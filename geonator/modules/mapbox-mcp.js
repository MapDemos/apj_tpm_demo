/**
 * Mapbox MCP Client
 *
 * Custom MCP-style server that:
 *  1. Wraps Mapbox Search Box API and Tilequery API
 *  2. Uses SpatialUtils (Turf.js) for geometric enrichment
 *  3. Exposes tools to Claude via listTools() / executeTool()
 *  4. Returns Minified JSON (no whitespace) to minimize token usage
 *
 * Based on spec §4: カスタムMapbox MCPサーバー仕様
 *
 * Modeled after RurubuMCPClient from the reference project.
 * Requires: spatial-utils.js, config.js already loaded.
 */

class MapboxMCPClient {

  /**
   * @param {object} config - CONFIG object from config.js
   * @param {object|null} app - Optional reference to LocationFinderApp
   */
  constructor(config, app = null) {
    this.config          = config;
    this.app             = app;
    this.token           = config.MAPBOX_ACCESS_TOKEN;
    this.spatialUtils    = new SpatialUtils();
    this._lastRouteData  = null; // set by _getRoutePOIs, read by index.js for map drawing
    this._sbRequests     = 0;   // Search Box API request count (reset by index.js on chat clear)
    this._tqRequests     = 0;   // Tilequery API request count (actual fetches only)
    this._tqCacheHits    = 0;   // Tilequery cache hits
    this._tqCache        = new Map(); // url → parsed JSON (cleared on chat reset)
    this._poiGridCache   = new Map();
  }

  /**
   * Initialize the client.
   * Mapbox APIs require no static data pre-load, so this is a no-op.
   * Kept for structural parity with RurubuMCPClient.
   */
  async initialize() {
    if (this.config.DEBUG) console.log('[MapboxMCP] Initialized');
    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  // MCP Interface
  // ═══════════════════════════════════════════════════════════════

  /**
   * Return all tool definitions in Anthropic tool_use schema format.
   * Called by LocationFinderApp to build the tools array for Claude.
   *
   * @returns {object[]} Array of tool definition objects
   */
  listTools() {
    return [

      {
        name: 'get_midpoint_area',
        description: '2地点間の中点座標とBBOXを計算する。2駅・2地点の間のエリアを探索範囲として絞る際に使用。',
        input_schema: {
          type: 'object',
          properties: {
            placeA: { type: 'string' },
            placeB: { type: 'string' },
          },
          required: ['placeA', 'placeB'],
        },
      },

      {
        name: 'search_nearby_poi',
        description: 'POI検索。poi/bothクエリはSearch Box APIとTilequery poi_label(streets-v8)を並行実行してマージ。placeクエリはSearch Boxのみ。0件時はバス停タイルセットにフォールバック。queriesはQuery Expansion配列で渡すこと。sourceフィールドで使用APIを確認可能。',
        input_schema: {
          type: 'object',
          properties: {
            queries:       { type: 'array', items: { type: 'string' }, description: 'Query Expansion済みクエリ配列' },
            proximity:     { type: 'array', items: { type: 'number' }, description: '[lng,lat]' },
            radius_meters: { type: 'number', description: '検索半径（m）。proximityと組み合わせて使用。MCPがbboxを自動計算する。get_midpoint_areaのbbox結果を使う場合はbboxを直接渡すこと。' },
            bbox:          { type: 'array', items: { type: 'number' }, description: '[minX,minY,maxX,maxY]。get_midpoint_area結果等を直接渡す場合のみ使用。通常はradius_metersを使うこと。' },
            query_intent:  {
              type: 'string',
              enum: ['specific', 'category_building', 'category_busstop', 'intersection', 'signal'],
              description: 'クエリの種別。specific=固有名・通常POI、category_building=マンション/アパート/ビルのカテゴリ検索、category_busstop=バス停、intersection=交差点（Tilequeryのみ）、signal=信号機（Tilequeryのみ）',
            },
          },
          required: ['queries'],
        },
      },

      {
        name: 'scan_street_features',
        description: 'Tilequery (streets-v8) で道路・駅出入口をスキャン。同名道路は自動dedup。POI検索にはsearch_nearby_poiを使うこと。target選択: 道路名・交差点・道路種別確認→road / 駅出入口番号・出口名特定→transit(radius=300〜500推奨) / 両方必要→both(デフォルト)。Tilequeryの上限は50件のため不要なレイヤーを除外して枠を有効活用すること。',
        input_schema: {
          type: 'object',
          properties: {
            lat:    { type: 'number' },
            lng:    { type: 'number' },
            radius: { type: 'number', description: '検索半径(m)' },
            target: { type: 'string', enum: ['road', 'transit', 'both'] },
          },
          required: ['lat', 'lng', 'radius'],
        },
      },

      {
        name: 'get_route_pois',
        description: '【補助情報として使用】A→Bルートを取得し候補の経路沿い度を判定する。主検索はget_midpoint_area+search_nearby_poiで行うこと（ルートは複数存在するため本ツールだけで絞り込まない）。matching_poisは優先度を上げるがexcluded_poisも候補から除外しない。A・B両方明示されている場合のみ使用。profile: driving/walking',
        input_schema: {
          type: 'object',
          properties: {
            from_lat:       { type: 'number' },
            from_lng:       { type: 'number' },
            to_lat:         { type: 'number' },
            to_lng:         { type: 'number' },
            profile:        { type: 'string', enum: ['driving', 'walking'] },
            poi_candidates: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name:      { type: 'string' },
                  latitude:  { type: 'number' },
                  longitude: { type: 'number' },
                },
                required: ['name', 'latitude', 'longitude'],
              },
            },
            buffer_meters: { type: 'number', description: 'バッファ幅(m)。デフォルト30' },
          },
          required: ['from_lat', 'from_lng', 'to_lat', 'to_lng', 'profile', 'poi_candidates'],
        },
      },

      // ── Tool: compute_area_from_landmark_bearing ─────────────
      {
        name: 'compute_area_from_landmark_bearing',
        description:
          '「スカイツリーが左手に見える」などランドマークの相対方位（左/右）から、ユーザーが存在しうるエリアのbboxを計算する。\n' +
          'ランドマーク周囲を3×3グリッド（8セル）に分割し、各セルで「そこにいてランドマークが指定方向に見える進行方向」を返す。\n' +
          '手順: ①search_nearby_poiでランドマーク座標取得 → ②本ツール実行 → ③地理的文脈（川沿い=南北移動等）でimplied_travel_directionを照合して最適セルを選択 → ④そのbboxをsearch_nearby_poiに渡す。\n' +
          'travel_bearingが分かれば渡すと絞り込み精度が上がる（0=北,90=東,180=南,270=西）。',
        input_schema: {
          type: 'object',
          properties: {
            landmark_lat:   { type: 'number', description: 'ランドマークの緯度' },
            landmark_lng:   { type: 'number', description: 'ランドマークの経度' },
            side:           { type: 'string', enum: ['left', 'right'], description: 'ランドマークが見える方向' },
            grid_size_km:   { type: 'number', description: '1セルの一辺(km)。デフォルト0.5' },
            travel_bearing: { type: 'number', description: '進行方向の方位角（任意）' },
          },
          required: ['landmark_lat', 'landmark_lng', 'side'],
        },
      },

      // ── Tool: scan_natural_features ─────────────────────────
      {
        name: 'scan_natural_features',
        description:
          '【使用API】Mapbox Tilequery API（water/waterway/landuse/natural_labelレイヤー）\n' +
          '川・海・湖・公園・森など自然物・地物を周辺から取得する。\n' +
          '「川の近くにいる」「公園の前」「森の中」「隅田川沿い」などで使用。\n' +
          '手順: ①search_nearby_poiで自然物名付近POIを取得→その座標でscan_natural_features(radius=1000〜2000)実行→natural_label.coordinatesを取得。\n' +
          'フォールバック: 他のランドマーク座標を起点にradius=5000で広範囲スキャン。\n' +
          '取得したcoordinatesをproximityに使ってsearch_nearby_poiを実行。\n' +
          '返却フィールド:\n' +
          '  water/waterway: {layer, dist}\n' +
          '  natural_label:  {layer, name, class, dist}  ← 隅田川・相模湾等の名称\n' +
          '  landuse:        {layer, class, dist}         ← park/forest等',
        input_schema: {
          type: 'object',
          properties: {
            lat:    { type: 'number' },
            lng:    { type: 'number' },
            radius: { type: 'number', description: '検索半径(m)。通常200〜500。' },
          },
          required: ['lat', 'lng', 'radius'],
        },
      },

      // ── Tool: check_travel_time ──────────────────────────────
      {
        name: 'check_travel_time',
        description:
          '【使用API】Mapbox Directions API（durationのみ取得・軽量版）\n' +
          '2点間の移動時間（秒・分）を取得する。「〜から歩いてn分」「〜から車でn分くらいのところ」という時間ベースの位置条件を検証する際に使用。\n' +
          '候補が複数ある場合は全候補に対して実行し、ユーザーのn分と一致（n×0.5〜n×1.5の範囲）するものを優先。duration_textを根拠としてオペレーターに提示。\n' +
          '返却: {duration_seconds, duration_minutes, duration_text("約X分"), profile}\n' +
          'get_route_poisとの違い: こちらは候補が正しい時間圏内にあるかの検証専用（POI絞り込みはしない）',
        input_schema: {
          type: 'object',
          properties: {
            from_lat: { type: 'number', description: '出発地の緯度' },
            from_lng: { type: 'number', description: '出発地の経度' },
            to_lat:   { type: 'number', description: '目的地（候補）の緯度' },
            to_lng:   { type: 'number', description: '目的地（候補）の経度' },
            profile:  { type: 'string', enum: ['driving', 'walking'], description: '徒歩→walking / 車→driving' },
          },
          required: ['from_lat', 'from_lng', 'to_lat', 'to_lng', 'profile'],
        },
      },

      // ── Tool: get_facing_road ──────────────────────────────
      {
        name: 'get_facing_road',
        description: 'POI座標から面している道路種別(class)を判定。10m→30m→50mで自動拡張し最大道路をprimary_roadに返す。「〜沿い」「大きな道路沿い」の検証に使用。返却: {found,primary_road:{name,class},road_classes}',
        input_schema: {
          type: 'object',
          properties: {
            lat: { type: 'number' },
            lng: { type: 'number' },
          },
          required: ['lat', 'lng'],
        },
      },

      // ── Tool: find_intersections ───────────────────────────
      {
        name: 'find_intersections',
        description: 'ユーザーが交差点名を目印として言及した場合に使用。周辺の名前付き交差点を取得し座標を返す。取得した座標をproximityや絞り込みの起点として使用できる。',
        input_schema: {
          type: 'object',
          properties: {
            lat:         { type: 'number' },
            lng:         { type: 'number' },
            radius:      { type: 'number', description: '検索半径(m)' },
            name_filter: { type: 'string',  description: '交差点名の部分一致フィルタ（省略可）' },
          },
          required: ['lat', 'lng', 'radius'],
        },
      },

      // ── Tool: find_traffic_signals ─────────────────────────
      {
        name: 'find_traffic_signals',
        description: 'ユーザーが信号機を目印として言及した場合に使用。周辺の信号機の座標を返す（名称なし）。信号の有無確認や、信号を空間的な起点として使用できる。',
        input_schema: {
          type: 'object',
          properties: {
            lat:    { type: 'number' },
            lng:    { type: 'number' },
            radius: { type: 'number', description: '検索半径(m)' },
          },
          required: ['lat', 'lng', 'radius'],
        },
      },
    ];
  }

  /**
   * Execute a named tool and return the result as a Minified JSON string.
   *
   * @param {string} toolName - One of: get_midpoint_area, search_nearby_poi, scan_street_features
   * @param {object} args     - Tool arguments matching the input_schema
   * @returns {Promise<string>} Minified JSON string
   */
  async executeTool(toolName, args) {
    try {
      switch (toolName) {
        case 'get_midpoint_area':
          return await this._getMidpointArea(args.placeA, args.placeB);
        case 'search_nearby_poi': {
          const queries = Array.isArray(args.queries)
            ? args.queries
            : (args.queries ? [args.queries] : []);
          return await this._searchNearbyPOI(queries, args.proximity || null, args.bbox || null, args.query_intent || null, args.radius_meters || null);
        }
        case 'scan_street_features':
          return await this._scanStreetFeatures(args.lat, args.lng, args.radius, args.target || 'both');
        case 'compute_area_from_landmark_bearing':
          return this._computeAreaFromLandmarkBearing(
            args.landmark_lat, args.landmark_lng,
            args.side, args.grid_size_km ?? 0.5,
            args.travel_bearing
          );
        case 'scan_natural_features':
          return await this._scanNaturalFeatures(args.lat, args.lng, args.radius);
        case 'check_travel_time':
          return await this._checkTravelTime(args.from_lat, args.from_lng, args.to_lat, args.to_lng, args.profile);
        case 'get_facing_road':
          return await this._getFacingRoad(args.lat, args.lng);
        case 'find_intersections':
          return await this._findIntersections(args.lat, args.lng, args.radius, args.name_filter || null);
        case 'find_traffic_signals':
          return await this._findTrafficSignals(args.lat, args.lng, args.radius);
        case 'get_route_pois':
          return await this._getRoutePOIs(
            args.from_lat, args.from_lng, args.to_lat, args.to_lng,
            args.profile, args.poi_candidates, args.buffer_meters
          );
        default:
          return JSON.stringify({ error: `Unknown tool: ${toolName}` });
      }
    } catch (err) {
      if (this.config.DEBUG) console.error(`[MapboxMCP] executeTool(${toolName}) error:`, err);
      return JSON.stringify({ error: err.message, tool: toolName });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Fetch with 429 retry (exponential backoff)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Wrapper around fetch() that retries on HTTP 429 (rate limit).
   * Delays: 1s → 2s → 4s
   */
  async _fetchWithRetry(url, maxRetries = 3) {
    const delays = [1000, 2000, 4000];
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetch(url);
      if (res.status !== 429) return res;
      if (attempt < maxRetries) {
        const ms = delays[attempt] ?? 4000;
        if (this.config.DEBUG)
          console.warn(`[MapboxMCP] 429 rate limit → ${ms}ms 待機してリトライ (${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, ms));
      }
    }
    if (this.config.DEBUG) console.error('[MapboxMCP] 429 rate limit: リトライ上限に達しました');
    // Return a fake Response-like object so callers can check .ok / .status
    return { ok: false, status: 429, statusText: 'Rate Limited' };
  }

  // ═══════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════
  // Tilequery grid-snap cache
  // ═══════════════════════════════════════════════════════════════

  /**
   * Snap lat/lng to a uniform grid of cellSizeM × cellSizeM meters.
   * Nearby coordinates that fall in the same cell share a single Tilequery fetch.
   * cellSizeM = radius / 4 keeps max positional error ≤ 18% of radius.
   */
  _snapCoord(lat, lng, cellSizeM) {
    const dLat = cellSizeM / 110540;
    const dLng = cellSizeM / (111320 * Math.cos(lat * Math.PI / 180));
    return {
      lat: Math.round(lat / dLat) * dLat,
      lng: Math.round(lng / dLng) * dLng,
    };
  }

  /**
   * Snap the lat/lng in a Tilequery URL to a grid (cellSize = radius/4, max 50m).
   * This gives a stable cache key for nearby calls.
   * Max positional error ≈ 18% of radius (diagonal of half-cell).
   */
  _snapTilequeryUrl(url) {
    // Match: /tilequery/LNG,LAT.json?...&radius=R&...
    const m = url.match(/\/tilequery\/([\d.+-]+),([\d.+-]+)\.json[^&]*[?&]radius=(\d+)/);
    if (!m) return url;
    const lng = parseFloat(m[1]), lat = parseFloat(m[2]), radius = parseInt(m[3]);
    const cellSizeM = Math.max(Math.min(radius / 4, 50), 5);
    const { lat: sLat, lng: sLng } = this._snapCoord(lat, lng, cellSizeM);
    return url.replace(`/${lng},${lat}.json`, `/${+sLng.toFixed(6)},${+sLat.toFixed(6)}.json`);
  }

  /**
   * Fetch a Tilequery URL with in-memory cache.
   * Coordinates are snapped to a grid before caching so nearby calls share results.
   * _tqRequests counts only real API calls; _tqCacheHits counts saved calls.
   */
  async _fetchTilequeryWithCache(url) {
    const snappedUrl = this._snapTilequeryUrl(url);
    const cached = this._tqCache.get(snappedUrl);
    if (cached) {
      this._tqCacheHits++;
      if (this.config.DEBUG)
        console.log(`[TQ cache HIT #${this._tqCacheHits}] saves=${this._tqCacheHits} actual=${this._tqRequests}`);
      return { ok: true, json: async () => cached };
    }
    this._tqRequests++;
    const res = await this._fetchWithRetry(snappedUrl);
    if (!res.ok) return res;
    const data = await res.json();
    this._tqCache.set(snappedUrl, data);
    return { ok: true, json: async () => data };
  }

  // Search expansion helpers
  // ═══════════════════════════════════════════════════════════════

  /**
   * Cap a bbox so neither half-width nor half-height exceeds maxHalfM meters.
   * Applied to all Search Box and Tilequery grid calls to prevent oversized searches.
   */
  _capBBox(bbox, maxHalfM = 500) {
    const [minX, minY, maxX, maxY] = bbox;
    const cx   = (minX + maxX) / 2;
    const cy   = (minY + maxY) / 2;
    const dLng = maxHalfM / (111320 * Math.cos(cy * Math.PI / 180));
    const dLat = maxHalfM / 110540;
    const hw   = Math.min((maxX - minX) / 2, dLng);
    const hh   = Math.min((maxY - minY) / 2, dLat);
    return [cx - hw, cy - hh, cx + hw, cy + hh];
  }

  /** Expand a bbox by `factor` around its center. */
  _expandBBox(bbox, factor) {
    const [minX, minY, maxX, maxY] = bbox;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const hw = (maxX - minX) / 2 * factor;
    const hh = (maxY - minY) / 2 * factor;
    return [cx - hw, cy - hh, cx + hw, cy + hh];
  }

  /**
   * Derive approximate radius (meters) from a bbox.
   * Uses half the shorter side so the derived radius stays tight.
   */
  _bboxToRadius(bbox) {
    if (!bbox || bbox.length < 4) return null;
    const [minX, minY, maxX, maxY] = bbox;
    const lat = (minY + maxY) / 2;
    const dx  = Math.abs(maxX - minX) * 111320 * Math.cos(lat * Math.PI / 180);
    const dy  = Math.abs(maxY - minY) * 110540;
    // Use circumscribed circle (half-diagonal) so all bbox corners are covered.
    // Inscribed circle (min/2) missed POIs near bbox edges.
    return Math.max(Math.sqrt(dx * dx + dy * dy) / 2, 30);
  }

  // ═══════════════════════════════════════════════════════════════
  // Token optimization helpers
  // ═══════════════════════════════════════════════════════════════

  /**
   * JSON.stringify with null/undefined/empty-array stripping.
   * Reduces token consumption by removing fields Claude doesn't need.
   */
  _minify(data) {
    return JSON.stringify(data, (_key, val) => {
      if (val === null || val === undefined) return undefined;
      if (val === '') return undefined;                        // empty string
      if (Array.isArray(val) && val.length === 0) return undefined; // empty array
      return val;
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // Private: Search Box API
  // ═══════════════════════════════════════════════════════════════

  /**
   * Single Search Box forward request.
   * Returns filtered, flattened feature array.
   *
   * @param {string}      q         - Search query
   * @param {string}      types     - Comma-separated types (e.g. 'poi' or 'place,district,locality')
   * @param {number[]|null} proximity - [lng, lat]
   * @param {number[]|null} bbox     - [minX, minY, maxX, maxY]
   * @returns {Promise<object[]>}
   */
  async _searchBoxRequest(q, types, proximity, bbox) {
    let url =
      `${this.config.SEARCH_BOX_API}` +
      `?q=${encodeURIComponent(q)}` +
      `&access_token=${this.token}` +
      `&language=ja` +
      `&country=jp` +
      `&types=${types}` +
      `&limit=30`;

    if (proximity && proximity.length >= 2) {
      url += `&proximity=${proximity[0]},${proximity[1]}`;
    }
    if (bbox && bbox.length >= 4) {
      url += `&bbox=${this._capBBox(bbox).join(',')}`;
    }

    try {
      this._sbRequests++;
      const res  = await this._fetchWithRetry(url);
      if (!res.ok) return [];
      const data = await res.json();

      return (data.features || []).map(f => {
        const p = f.properties || {};
        const c = p.coordinates || {};
        const ft = p.feature_type || null;
        // bbox is meaningful for locality type only; address/poi bbox is essentially a point
        const bbox = (ft === 'locality') ? (p.bbox || null) : null;
        return {
          name:         p.name         || null,
          full_address: p.full_address || null,
          longitude:    c.longitude,
          latitude:     c.latitude,
          poi_category: p.poi_category || null,
          brand:        p.brand        || null,
          distance:     p.distance     ?? null,
          feature_type: ft,
          bbox:         bbox,
        };
      }).filter(f => f.longitude != null && f.latitude != null);

    } catch (err) {
      if (this.config.DEBUG) console.warn('[MapboxMCP] _searchBoxRequest error:', err.message);
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Tool impl: search_nearby_poi
  // ─────────────────────────────────────────────────────────────

  // ═══════════════════════════════════════════════════════════════
  // Mapbox Streets v8 road layer class definitions
  // Source: https://docs.mapbox.com/data/tilesets/reference/mapbox-streets-v8/#road
  // ═══════════════════════════════════════════════════════════════

  // ── カテゴリ1: 道路系 ── priority順（小さいほど幹線）
  static ROAD_CLASS_RANK = {
    motorway:        1,   // 高速道路
    motorway_link:   1,   // 高速道路ランプ・接続路
    trunk:           2,   // 幹線道路（高規格国道等）
    trunk_link:      2,   // 幹線道路ランプ・接続路
    primary:         3,   // 主要幹線（国道・都道府県道）
    primary_link:    3,   // 主要幹線接続路
    secondary:       4,   // 幹線道路
    secondary_link:  4,   // 幹線道路接続路
    tertiary:        5,   // 一般道（集落間・市街地補助）
    tertiary_link:   5,   // 一般道接続路
    street:          6,   // 市街地道路（汎用クラス）
    street_limited:  6,   // 制限付き市街地道路（一方通行等）
    pedestrian:      7,   // 歩行者専用道・広場
    construction:    8,   // 工事中の道路
    track:           9,   // 農道・林道
    service:         9,   // サービス道路（駐車場内通路・私道等）
    path:            10,  // 歩道・サイクルパス・スキーコース
  };

  // ── カテゴリ2: 線路・海路・その他系 ── 道路ではないため除外
  static NON_ROAD_CLASSES = new Set([
    'major_rail',    // 幹線鉄道・通勤鉄道・高速鉄道
    'minor_rail',    // 路面電車・ライトレール
    'service_rail',  // 操車場・サービス線路
    'ferry',         // フェリー航路
    'aerialway',     // ロープウェイ・ゴンドラ
    'golf',          // ゴルフコース中心線
  ]);

  // ── カテゴリ3: ポイントデータ系 ── 交差点・信号・ジャンクション等
  static POINT_DATA_CLASSES = new Set([
    'junction',        // 道路ジャンクション
    'roundabout',      // ラウンドアバウト（環状交差点）
    'mini_roundabout', // 小型ラウンドアバウト
    'turning_circle',  // 転回スペース（行き止まり終端）
    'turning_loop',    // 転回ループ（島あり）
    'traffic_signals', // 信号機
    'level_crossing',  // 踏切
    'intersection',    // 交差点（日本限定データ）
  ]);

  /**
   * Classify a query string to determine which Search Box types to request.
   * Returns 'place' | 'poi' | 'both'.
   * Conservative: only classify when clear indicators exist; default to 'both'.
   */
  static classifyQueryType(query) {
    // Clear place indicators: administrative suffixes
    if (/[都道府県][市区町村]|[市区]$|[町村]$|丁目|番地|番町/.test(query)) return 'place';

    // Clear POI indicators: facility/business suffixes
    if (/駅$|空港$|港$|病院$|クリニック$|学校$|大学$|図書館$|神社$|寺$|寺院$|ホテル$|旅館$|銀行$|警察署$|消防署$|郵便局$/.test(query)) return 'poi';

    // Ambiguous: run both
    return 'both';
  }

  /**
   * Check if an item name contains at least one of the query terms.
   * Used to filter supplementary Tilequery poi_label results.
   * (Search Box results skip this filter — they're already ML-ranked.)
   */
  /** Strip invisible Unicode characters (zero-width spaces etc.) used by Mapbox for Japanese word-breaking */
  static _cleanName(name) {
    return name ? name.replace(/[​‌‍﻿]/g, '') : name;
  }

  _matchesAnyQuery(name, queries) {
    if (!name || !queries?.length) return false;
    const cleanName = MapboxMCPClient._cleanName(name);
    const nameLower = cleanName.toLowerCase();
    const matched = queries.some(q => q && nameLower.includes(MapboxMCPClient._cleanName(q).toLowerCase()));
    if (!matched && this.config.DEBUG) {
      console.log(`[TQ filter] EXCLUDED: "${cleanName}" (queries: [${queries.slice(0,3).join(', ')}...])`);
    }
    return matched;
  }

  // ── Helper: class → category 文字列 ──
  static getRoadCategory(cls) {
    if (!cls) return null;
    if (MapboxMCPClient.ROAD_CLASS_RANK[cls] != null)  return '道路系';
    if (MapboxMCPClient.NON_ROAD_CLASSES.has(cls))     return '線路・海路・その他';
    if (MapboxMCPClient.POINT_DATA_CLASSES.has(cls))   return 'ポイント（交差点・信号等）';
    return 'その他';
  }

  // ── Bus stop keywords — triggers bus stop tileset search (no other API)
  static BUS_STOP_KEYWORDS = ['バス停', 'バス停留所', '停留所', 'bus stop', 'bus_stop'];

  _isBusStopQuery(queries) {
    return queries.some(q =>
      MapboxMCPClient.BUS_STOP_KEYWORDS.some(kw => q.toLowerCase().includes(kw.toLowerCase()))
    );
  }

  // ── Building-type keywords that are poorly indexed in Search Box
  // but appear reliably in streets-v8 poi_label
  // streets-v8 poi_label has better coverage than Search Box for these building types
  static BUILDING_KEYWORDS = [
    'マンション', 'アパート', 'ビル', '邸', 'タワー', 'レジデンス',
    'ハイツ', 'コーポ', 'テラス', '荘', '館', 'プレイス', 'コート',
    'ガーデン', 'ヴィラ', 'パレス', 'ハウス',
  ];

  /**
   * Check if any query string contains building-type keywords.
   * @param {string[]} queries
   * @returns {boolean}
   */
  _isBuildingQuery(queries) {
    return queries.some(q =>
      MapboxMCPClient.BUILDING_KEYWORDS.some(kw => q.includes(kw))
    );
  }

  /**
   * 【主】Search Box API ツインリクエスト × queries配列を並行実行。
   * Search Box API (poi/both クエリ) と Tilequery poi_label (streets-v8) を並行実行し、
   * 座標ベースのキーで重複排除してマージする。
   *
   * 建物系クエリ（マンション/アパート/ビル/ホテル等）+ proximity あり:
   *   → Tilequery poi_label のみ（streets-v8 の方がカバレッジが良いため）
   * それ以外の poi/both クエリ:
   *   → Search Box + Tilequery poi_label を並行実行
   * place クエリ:
   *   → Search Box のみ（streets-v8 に place データなし）
   */
  async _searchNearbyPOI(queries, proximity, bbox, queryIntent = null, radiusMeters = null) {
    const MAX_EXPANSIONS = 3;
    const EXPAND_FACTOR  = 1.2;

    // ── 信号・交差点クエリ: Tilequeryのみ（Search Box不可） ──
    // bboxが渡されている場合（localityのbbox等）はそのbboxの外接円半径を使い全域をカバーする
    if (queryIntent === 'intersection' && proximity?.length >= 2) {
      const [lng, lat] = proximity;
      const r = bbox?.length >= 4
        ? Math.min(Math.ceil(this._bboxToRadius(bbox)), 400)
        : Math.min(radiusMeters ?? 150, 400);
      const nameFilter = queries?.[0] || null;
      return await this._findIntersections(lat, lng, r, nameFilter);
    }
    if (queryIntent === 'signal' && proximity?.length >= 2) {
      const [lng, lat] = proximity;
      const r = bbox?.length >= 4
        ? Math.min(Math.ceil(this._bboxToRadius(bbox)), 400)
        : Math.min(radiusMeters ?? 150, 400);
      return await this._findTrafficSignals(lat, lng, r);
    }

    // radius_meters → bbox 変換（Claudeの代わりにMCPが計算）
    if (radiusMeters != null && proximity?.length >= 2 && !bbox) {
      const [lng, lat] = proximity;
      const r      = Math.min(radiusMeters, 400); // 400m上限
      const dLng   = r / (111320 * Math.cos(lat * Math.PI / 180));
      const dLat   = r / 110540;
      bbox = [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
    }

    // Coordinate-based dedup key: merges same-location results across both APIs
    const dedupKey = item => {
      const lng = item.longitude ?? 0;
      const lat = item.latitude  ?? 0;
      return `${item.name}|${Math.round(lng * 1000)}|${Math.round(lat * 1000)}`;
    };

    const seen = new Map();

    const _notBlocked = (name) => {
      if (!name || typeof POI_BLOCKLIST_FLAT === 'undefined') return true;
      const n = name.toLowerCase();
      return !POI_BLOCKLIST_FLAT.some(b => n.startsWith(b.toLowerCase()));
    };

    const isBusStop = queryIntent === 'category_busstop' || (!queryIntent && this._isBusStopQuery(queries));
    const isBuilding = queryIntent === 'category_building' || (!queryIntent && !isBusStop && this._isBuildingQuery(queries));

    // ── Bus stop: use bus stop tileset only when explicitly mentioned ──
    if (isBusStop && proximity?.length >= 2) {
      const [lng, lat] = proximity;
      const radius = bbox ? Math.round(this._bboxToRadius(bbox)) : 500;
      if (this.config.DEBUG) console.log(`[MapboxMCP] バス停クエリ → バス停タイルセットのみ (r=${radius}m)`);
      const busStops = await this._busStopFallback(lat, lng, radius);
      busStops.forEach(item => { if (!seen.has(item.name)) seen.set(item.name, item); });
      const items = [...seen.values()].slice(0, 150);
      return this._minify({ source: 'バス停タイルセット (10da032y.busstop_gov_0608)', count: items.length, items, _debug: { sb_count: 0, tq_count: items.length, sb_items: [], tq_items: items.slice(0,30).map(i=>({name:i.name,distance:i.distance})) } });
    }

    // ── Building priority: Grid Tilequery ONLY (マンション/アパート/ビル/ホテル) ──
    // streets-v8 poi_label has better building coverage than Search Box.
    // Grid search covers bbox with overlapping 100m circles.
    if (isBuilding && proximity?.length >= 2) {
      const [lng, lat] = proximity;
      // If no bbox, create the default ±300m so expansion loop works correctly
      const DEG_LNG0 = 1 / (111320 * Math.cos(lat * Math.PI / 180));
      const DEG_LAT0 = 1 / 110540;
      const defM = 300;
      let currentBbox = bbox
        ? this._capBBox([...bbox])
        : [lng - defM*DEG_LNG0, lat - defM*DEG_LAT0, lng + defM*DEG_LNG0, lat + defM*DEG_LAT0];
      if (this.config.DEBUG)
        console.log(`[MapboxMCP] 建物系 → グリッドTilequery のみ (初期bbox幅=${Math.round((currentBbox[2]-currentBbox[0])*111320)}m)`);

      for (let exp = 0; exp <= MAX_EXPANSIONS; exp++) {
        const tqItems = await this._gridTilequeryPOI(lat, lng, currentBbox, 200);
        tqItems.forEach(item => {
          if (!_notBlocked(item.name)) return;
          if (!seen.has(dedupKey(item))) seen.set(dedupKey(item), item);
        });
        if (seen.size > 0 || exp === MAX_EXPANSIONS) break;
        currentBbox = this._capBBox(this._expandBBox(currentBbox, EXPAND_FACTOR));
        if (this.config.DEBUG) {
          const w = Math.round((currentBbox[2] - currentBbox[0]) * 111320);
          console.log(`[MapboxMCP] 建物0件 → bbox ${w}m幅に拡張`);
        }
      }

      // ── Building fallback: Search Box when Tilequery returns 0 ──
      if (seen.size === 0) {
        if (this.config.DEBUG) console.log('[MapboxMCP] 建物: Tilequery 0件 → Search Box フォールバック');
        const sbRequests = queries.flatMap(q => {
          const qt = MapboxMCPClient.classifyQueryType(q);
          if (qt === 'place') return [this._searchBoxRequest(q, 'place,district,locality', proximity, currentBbox)];
          if (qt === 'poi')   return [this._searchBoxRequest(q, 'poi',                     proximity, currentBbox)];
          return [
            this._searchBoxRequest(q, 'poi',                     proximity, currentBbox),
            this._searchBoxRequest(q, 'place,district,locality', proximity, currentBbox),
          ];
        });
        const sbResults = await Promise.all(sbRequests);
        sbResults.flat().forEach(item => {
          const key = dedupKey(item);
          if (!seen.has(key)) seen.set(key, item);
        });
      }

      const items = [...seen.values()]
        .sort((a, b) => (a.distance ?? 9999) - (b.distance ?? 9999))
        .slice(0, 150);
      const src = items.length
        ? (seen.size > 0 && items[0].full_address !== undefined
            ? 'Search Box (building fallback)' : 'Tilequery poi_label grid (buildings)')
        : 'no results';
      return this._minify({ source: src, count: items.length, items, _debug: { sb_count: 0, tq_count: items.length, sb_items: [], tq_items: items.slice(0,30).map(i=>({name:i.name,distance:i.distance})) } });
    }

    let currentBbox = bbox ? this._capBBox([...bbox]) : null;

    // Determine if any query should trigger Tilequery (poi or both = has POI intent)
    const hasPOIQuery = queries.some(q => MapboxMCPClient.classifyQueryType(q) !== 'place');

    let sbCount = 0, tqCount = 0;
    const sbItems = [], tqItems = [];

    for (let exp = 0; exp <= MAX_EXPANSIONS; exp++) {

      // ── Search Box requests (type-classified per query) ──
      const sbRequests = queries.flatMap(q => {
        const qt = MapboxMCPClient.classifyQueryType(q);
        if (qt === 'place') return [this._searchBoxRequest(q, 'place,district,locality', proximity, currentBbox)];
        if (qt === 'poi')   return [this._searchBoxRequest(q, 'poi',                     proximity, currentBbox)];
        return [  // 'both'
          this._searchBoxRequest(q, 'poi',                     proximity, currentBbox),
          this._searchBoxRequest(q, 'place,district,locality', proximity, currentBbox),
        ];
      });

      // ── Tilequery poi_label (streets-v8) — grid search for poi/both queries ──
      // Use grid (same as building path) so edge-of-bbox facilities are covered.
      const tqPromise = (hasPOIQuery && proximity?.length >= 2)
        ? this._gridTilequeryPOI(proximity[1], proximity[0], currentBbox, 200)
        : Promise.resolve([]);

      // ── Run both in parallel ──
      const [sbResultArrays, tqResults] = await Promise.all([
        Promise.all(sbRequests),
        tqPromise,
      ]);

      // ── Merge with coordinate-based dedup ──

      sbResultArrays.flat().forEach(item => {
        const key = dedupKey(item);
        if (!seen.has(key)) { seen.set(key, item); sbItems.push(item); sbCount++; }
      });
      tqResults.forEach(item => {
        if (!this._matchesAnyQuery(item.name, queries)) return;
        const key = dedupKey(item);
        if (!seen.has(key)) { seen.set(key, item); tqItems.push(item); tqCount++; }
      });

      if (seen.size > 0 || exp === MAX_EXPANSIONS) break;

      if (currentBbox) {
        currentBbox = this._capBBox(this._expandBBox(currentBbox, EXPAND_FACTOR));
        if (this.config.DEBUG) {
          const w = Math.round((currentBbox[2] - currentBbox[0]) * 111320);
          console.log(`[MapboxMCP] 0件 → bbox ${w}m幅に拡張`);
        }
      }
    }

    // ── Final fallback: bus stop tileset (non-bus-stop queries only) ──
    if (seen.size === 0 && proximity?.length >= 2 && !this._isBusStopQuery(queries)) {
      if (this.config.DEBUG) console.log('[MapboxMCP] 0件 → バス停フォールバック');
      const [lng, lat] = proximity;
      const busStops = await this._busStopFallback(lat, lng, 500);
      busStops.forEach(item => {
        if (!seen.has(item.name)) seen.set(item.name, item);
      });
    }

    const items = [...seen.values()]
      .sort((a, b) => (a.distance ?? 9999) - (b.distance ?? 9999))
      .slice(0, 150);
    const tqActuallyRan = hasPOIQuery && proximity?.length >= 2;
    const source = items.length
      ? (tqActuallyRan ? 'Search Box + Tilequery poi_label (parallel)' : 'Search Box API')
      : 'no results';

    return this._minify({
      source,
      count: items.length,
      items,
      _debug: {
        sb_count: sbCount,
        tq_count: tqCount,
        sb_items: sbItems.slice(0, 30).map(i => ({ name: i.name, distance: i.distance })),
        tq_items: tqItems.slice(0, 30).map(i => ({ name: i.name, distance: i.distance })),
      },
    });
  }

  /**
   * Grid Tilequery for buildings: evenly-spaced grid points within bbox,
   * each with radius=100m circles overlapping by ~50%. Covers the full area
   * like Search Box bbox. Results are deduped by coordinate before returning.
   *
   * @param {number}       centerLat
   * @param {number}       centerLng
   * @param {number[]|null} bbox     - [minLng, minLat, maxLng, maxLat]
   * @param {number}        radius   - per-point radius in meters (default 100)
   */
  async _gridTilequeryPOI(centerLat, centerLng, bbox, radius = 200) {
    const bboxKey  = bbox?.map(v => Math.round(v * 10000)).join(',') ?? 'null';
    const gridKey  = `${Math.round(centerLat * 10000)},${Math.round(centerLng * 10000)},r${radius},${bboxKey}`;
    if (this._poiGridCache.has(gridKey)) {
      if (this.config.DEBUG) console.log(`[POI grid cache HIT] ${gridKey}`);
      return this._poiGridCache.get(gridKey);
    }
    const DEG_LNG = 1 / (111320 * Math.cos(centerLat * Math.PI / 180));
    const DEG_LAT = 1 / 110540;
    const spacingM = radius * 1.5; // 50% overlap between adjacent circles

    // Default bbox when none provided: ±300m square around center
    if (!bbox) {
      const defM = 300;
      bbox = [
        centerLng - defM * DEG_LNG,
        centerLat - defM * DEG_LAT,
        centerLng + defM * DEG_LNG,
        centerLat + defM * DEG_LAT,
      ];
    }

    let gridPoints;

    if (bbox) {
      const [minLng, minLat, maxLng, maxLat] = bbox;
      // Inset grid points by radius so circles align with bbox edges (no overshoot)
      const radiusLng = radius * DEG_LNG;
      const radiusLat = radius * DEG_LAT;
      const gMinLng = minLng + radiusLng;
      const gMaxLng = maxLng - radiusLng;
      const gMinLat = minLat + radiusLat;
      const gMaxLat = maxLat - radiusLat;

      // Degenerate case: bbox smaller than 2*radius → single center point
      if (gMinLng >= gMaxLng || gMinLat >= gMaxLat) {
        gridPoints = [[(minLng + maxLng) / 2, (minLat + maxLat) / 2]];
      } else {
        const widthM  = (gMaxLng - gMinLng) / DEG_LNG;
        const heightM = (gMaxLat - gMinLat) / DEG_LAT;
        const nx = Math.max(1, Math.ceil(widthM  / spacingM) + 1);
        const ny = Math.max(1, Math.ceil(heightM / spacingM) + 1);

        gridPoints = [];
        for (let iy = 0; iy < ny; iy++) {
          for (let ix = 0; ix < nx; ix++) {
            gridPoints.push([
              nx === 1 ? (gMinLng + gMaxLng) / 2 : gMinLng + ix * (gMaxLng - gMinLng) / (nx - 1),
              ny === 1 ? (gMinLat + gMaxLat) / 2 : gMinLat + iy * (gMaxLat - gMinLat) / (ny - 1),
            ]);
          }
        }
      }
    } else {
      gridPoints = [[centerLng, centerLat]];
    }

    if (this.config.DEBUG)
      console.log(`[MapboxMCP] グリッドTilequery: ${gridPoints.length}点 × r=${radius}m`);

    const results = await Promise.all(
      gridPoints.map(([gLng, gLat]) => this._tilequeryBuildingSearch(gLat, gLng, radius))
    );

    // Dedup by name + coordinate
    const seen = new Map();
    results.flat().forEach(item => {
      const key = `${item.name}|${Math.round((item.longitude ?? 0) * 1000)}|${Math.round((item.latitude ?? 0) * 1000)}`;
      if (!seen.has(key)) seen.set(key, item);
    });

    // Recalculate distance from the original center (not from each grid point).
    // Each Tilequery returns tilequery.distance relative to its own grid point,
    // so mixed distances would be incomparable. Replace with uniform proximity-based distance.
    const centerPt = turf.point([centerLng, centerLat]);
    const gridResult = [...seen.values()].map(item => ({
      ...item,
      distance: item.longitude != null && item.latitude != null
        ? Math.round(turf.distance(centerPt, turf.point([item.longitude, item.latitude]), { units: 'meters' }))
        : item.distance,
    })).sort((a, b) => (a.distance ?? 9999) - (b.distance ?? 9999));

    this._poiGridCache.set(gridKey, gridResult);
    return gridResult;
  }

  /**
   * Tilequery poi_label for building search.
   * Returns only { name, distance } to minimize token usage.
   * radius は通常より広め (800m) — 建物名は広範囲に散在するため。
   */
  async _tilequeryBuildingSearch(lat, lng, radius) {
    const url =
      `${this.config.TILEQUERY_API}/${lng},${lat}.json` +
      `?access_token=${this.token}&radius=${radius}&limit=${this.config.TILEQUERY_LIMIT}&dedupe=true&layers=poi_label`;
    try {
      const res  = await this._fetchTilequeryWithCache(url);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.features || [])
        .filter(f => f.properties?.name)
        .map(f => ({
          name:      MapboxMCPClient._cleanName(f.properties.name),
          longitude: f.geometry?.coordinates?.[0],
          latitude:  f.geometry?.coordinates?.[1],
          distance:  Math.round(f.properties?.tilequery?.distance || 0),
        }))
        .filter(f => f.longitude != null && f.latitude != null);
    } catch (_) { return []; }
  }



  /**
   * Tilequery poi_label fallback: 全POIを半径内で取得し Search Box 互換形式に変換。
   */
  async _tilequeryPOIFallback(lat, lng, radius) {
    const url =
      `${this.config.TILEQUERY_API}/${lng},${lat}.json` +
      `?access_token=${this.token}` +
      `&radius=${radius}` +
      `&limit=${this.config.TILEQUERY_LIMIT}` +
      `&dedupe=true` +
      `&layers=poi_label`;
    try {
      const res  = await this._fetchTilequeryWithCache(url);
      if (!res.ok) return [];
      const data = await res.json();
      const results = (data.features || [])
        .filter(f => f.properties?.name)
        .map(f => ({
          name:      MapboxMCPClient._cleanName(f.properties.name),
          longitude: f.geometry?.coordinates?.[0],
          latitude:  f.geometry?.coordinates?.[1],
          distance:  Math.round(f.properties?.tilequery?.distance || 0),
        }))
        .filter(f => f.longitude != null && f.latitude != null);
      if (this.config.DEBUG) {
        console.log(`[TQ poi_label] center=[${(+lng).toFixed(5)},${(+lat).toFixed(5)}] r=${radius}m → ${results.length}件`);
        results.forEach(r => console.log(`  • "${r.name}" dist=${r.distance}m`));
      }
      return results;
    } catch (_) { return []; }
  }

  /**
   * Fallback 2: Bus stop tileset (10da032y.busstop_gov_0608)
   * Full national bus stop coverage. Returns name + operator only.
   */
  async _busStopFallback(lat, lng, radius) {
    const url =
      `https://api.mapbox.com/v4/10da032y.busstop_gov_0608/tilequery/${lng},${lat}.json` +
      `?access_token=${this.token}&radius=${radius}&limit=${this.config.TILEQUERY_LIMIT}&dedupe=true`;
    try {
      const res  = await this._fetchTilequeryWithCache(url);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.features || [])
        .filter(f => f.properties?.name)
        .map(f => ({
          name:      MapboxMCPClient._cleanName(f.properties.name),
          operator:  f.properties.operator || null,
          longitude: f.geometry?.coordinates?.[0],
          latitude:  f.geometry?.coordinates?.[1],
          distance:  Math.round(f.properties?.tilequery?.distance || 0),
        }))
        .filter(f => f.longitude != null && f.latitude != null);
    } catch (_) { return []; }
  }

  // ─────────────────────────────────────────────────────────────
  // Tool impl: get_midpoint_area
  // ─────────────────────────────────────────────────────────────

  /**
   * placeA / placeB それぞれをSearch BoxでPOI検索（駅優先）し、
   * 座標を取得してSpatialUtils.calculateMidpointBBOXに渡す。(spec §4-C)
   */
  async _getMidpointArea(placeA, placeB) {
    const findCoord = async (name) => {
      const items = await this._searchBoxRequest(name, 'poi', null, null);
      // Prefer station/transit POIs
      const station = items.find(i =>
        (i.poi_category || []).some(c =>
          /station|transit|駅|railway|metro|rail/i.test(c)
        )
      );
      const best = station || items[0];
      return best ? [best.longitude, best.latitude] : null;
    };

    const [coordA, coordB] = await Promise.all([
      findCoord(placeA),
      findCoord(placeB),
    ]);

    if (!coordA) return JSON.stringify({ error: `"${placeA}" が見つかりませんでした` });
    if (!coordB) return JSON.stringify({ error: `"${placeB}" が見つかりませんでした` });

    const { midpoint, bbox: rawBbox } = this.spatialUtils.calculateMidpointBBOX(coordA, coordB);
    const bbox = this._capBBox(rawBbox);  // enforce ±500m max

    return this._minify({
      placeA:   { name: placeA,  coordinates: coordA },
      placeB:   { name: placeB,  coordinates: coordB },
      midpoint,
      bbox,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Tool impl: get_route_pois
  // ─────────────────────────────────────────────────────────────

  /**
   * Get route from A→B via Directions API, buffer it with Turf.js,
   * and check which POI candidates fall within the corridor.
   * Route geometry is stored in this._lastRouteData for map visualization
   * (NOT returned to Claude to save tokens).
   */
  async _getRoutePOIs(fromLat, fromLng, toLat, toLng, profile, poiCandidates, bufferMeters) {
    const prof = profile === 'walking' ? 'walking' : 'driving';
    const buf  = bufferMeters ?? 30;

    const url =
      `https://api.mapbox.com/directions/v5/mapbox/${prof}/` +
      `${fromLng},${fromLat};${toLng},${toLat}` +
      `?access_token=${this.token}&geometries=geojson&overview=full&steps=false&alternatives=true`;

    try {
      const res  = await this._fetchTilequeryWithCache(url);
      if (!res.ok) return JSON.stringify({ error: `Directions API HTTP ${res.status}` });
      const data = await res.json();

      if (data.code !== 'Ok' || !data.routes?.length) {
        return JSON.stringify({ error: 'ルートが取得できませんでした', code: data.code });
      }

      const route = data.routes[0];

      const routes = data.routes; // primary + alternatives

      // Store all route geometries for map visualization (not sent to Claude)
      this._lastRouteData = {
        routesCoords: routes.map(r => r.geometry.coordinates),
        bufferMeters: buf,
      };

      // Pre-compute buffered corridors for each route
      const bufferedRoutes = routes.map(r =>
        turf.buffer(turf.lineString(r.geometry.coordinates), buf, { units: 'meters' })
      );

      // Check each POI against ALL routes
      const matching = [];
      const excluded = [];
      (poiCandidates || []).forEach(poi => {
        if (poi.longitude == null || poi.latitude == null) return;
        const pt = turf.point([poi.longitude, poi.latitude]);
        const inRoutes = bufferedRoutes
          .map((buf, i) => turf.booleanPointInPolygon(pt, buf) ? i : -1)
          .filter(i => i >= 0);

        if (inRoutes.length > 0) {
          matching.push({
            name:           poi.name,
            latitude:       poi.latitude,
            longitude:      poi.longitude,
            in_routes:      inRoutes,
            route_coverage: `${inRoutes.length}/${routes.length}`,
          });
        } else {
          excluded.push({ name: poi.name, latitude: poi.latitude, longitude: poi.longitude });
        }
      });

      // Sort matching POIs: most routes first (highest coverage = most reliable)
      matching.sort((a, b) => b.in_routes.length - a.in_routes.length);

      return this._minify({
        source:      'Mapbox Directions API',
        profile:     prof,
        route_count: routes.length,
        routes_info: routes.map((r, i) => ({
          index:       i,
          label:       i === 0 ? '主ルート' : `代替ルート${i}`,
          distance_m:  Math.round(r.distance),
          duration_s:  Math.round(r.duration),
        })),
        buffer_width_m:  buf,
        matching_count:  matching.length,
        matching_pois:   matching,
        excluded_pois:   excluded,
      });

    } catch (err) {
      if (this.config.DEBUG) console.error('[MapboxMCP] _getRoutePOIs error:', err);
      return JSON.stringify({ error: err.message });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Tool impl: compute_area_from_landmark_bearing
  // ─────────────────────────────────────────────────────────────

  /**
   * Divide the area around a landmark into a 3×3 grid (8 surrounding cells).
   * For each cell, calculate:
   *   - The bearing from that cell center to the landmark
   *   - The implied travel direction if the landmark appears on the given side
   *
   * Claude then selects the cell whose implied travel direction matches the
   * geographic context (e.g. "along the Sumida River" → N or S travel).
   */
  _computeAreaFromLandmarkBearing(landmarkLat, landmarkLng, side, gridSizeKm, travelBearing) {
    const gsM      = gridSizeKm * 1000; // grid size in meters
    const DEG_LAT  = 1 / 110540;
    const DEG_LNG  = 1 / (111320 * Math.cos(landmarkLat * Math.PI / 180));
    const halfDLat = (gsM / 2) * DEG_LAT;
    const halfDLng = (gsM / 2) * DEG_LNG;

    // Position labels for 3×3 grid (row: 1=north…-1=south, col: -1=west…1=east)
    const POS_LABELS = {
      '1,-1': '北西', '1,0': '北', '1,1': '北東',
      '0,-1': '西',               '0,1': '東',
      '-1,-1': '南西', '-1,0': '南', '-1,1': '南東',
    };

    const cells = [];
    for (let row = 1; row >= -1; row--) {
      for (let col = -1; col <= 1; col++) {
        if (row === 0 && col === 0) continue; // skip center

        const cellLat = landmarkLat + row * gsM * DEG_LAT;
        const cellLng = landmarkLng + col * gsM * DEG_LNG;

        // Bearing from this cell to the landmark
        const bearingToLandmark = turf.bearing(
          turf.point([cellLng, cellLat]),
          turf.point([landmarkLng, landmarkLat])
        );

        // Implied travel direction:
        //   left  → landmark is 90° clockwise from travel → travel = bearingToLandmark + 90
        //   right → landmark is 90° counter-clockwise → travel = bearingToLandmark - 90
        const rawTravel = side === 'left'
          ? bearingToLandmark + 90
          : bearingToLandmark - 90;
        const impliedTravel = ((rawTravel % 360) + 360) % 360;

        const bbox = [
          +(cellLng - halfDLng).toFixed(5),
          +(cellLat - halfDLat).toFixed(5),
          +(cellLng + halfDLng).toFixed(5),
          +(cellLat + halfDLat).toFixed(5),
        ];

        cells.push({
          position:                   POS_LABELS[`${row},${col}`],
          implied_travel_bearing:     Math.round(impliedTravel),
          implied_travel_direction:   this._bearingToCompass(impliedTravel),
          bbox,
        });
      }
    }

    // If travel_bearing provided, filter to cells within ±45°
    const candidates = travelBearing !== undefined
      ? cells.filter(c => {
          const diff = Math.abs(c.implied_travel_bearing - travelBearing);
          return Math.min(diff, 360 - diff) <= 45;
        })
      : cells;

    return this._minify({
      source:       'SpatialUtils (bearing calculation)',
      side,
      grid_size_km: gridSizeKm,
      note:         'implied_travel_directionはそのセルにいてランドマークが指定方向に見えるときの進行方向。地理的文脈と照合して最適なセルのbboxをsearch_nearby_poiに渡すこと。',
      cells:        candidates,
    });
  }

  /** Convert bearing degrees to Japanese compass direction */
  _bearingToCompass(b) {
    const dirs = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
    return dirs[Math.round(((b % 360) + 360) % 360 / 45) % 8];
  }

  // ─────────────────────────────────────────────────────────────
  // Tool impl: scan_natural_features
  // ─────────────────────────────────────────────────────────────

  /**
   * Tilequery: water/waterway/landuse/natural_label layers.
   * Returns minimal filtered fields per spec.
   */
  async _scanNaturalFeatures(lat, lng, radius) {
    const MAX_EXPANSIONS = 3;
    const EXPAND_FACTOR  = 1.2;
    let currentRadius    = radius;
    let items            = [];

    try {
      for (let exp = 0; exp <= MAX_EXPANSIONS; exp++) {
        const url =
          `${this.config.TILEQUERY_API}/${lng},${lat}.json` +
          `?access_token=${this.token}&radius=${Math.round(currentRadius)}&limit=${this.config.TILEQUERY_LIMIT}&dedupe=true` +
          `&layers=water,waterway,landuse,natural_label`;

        const res  = await this._fetchTilequeryWithCache(url);
        if (!res.ok) return JSON.stringify({ error: `Tilequery HTTP ${res.status}` });
        const data = await res.json();

        const raw = (data.features || []).map(f => {
          const p     = f.properties || {};
          const tq    = p.tilequery || {};
          const layer = tq.layer;
          const dist  = Math.round(tq.distance || 0);

          // Extract coordinates: Point→[lng,lat], Line/Polygon→first coord pair
          const geom = f.geometry;
          const coords = geom?.type === 'Point'
            ? geom.coordinates
            : geom?.coordinates?.[0] ?? null;

          switch (layer) {
            case 'water':
            case 'waterway':
              // coords = nearest point on the water body (useful as proximity anchor)
              return { layer, dist, coordinates: coords };
            case 'natural_label':
              // named features (隅田川, 相模湾 etc.) — coords is centroid
              return { layer, name: p.name || null, class: p.class || null, dist, coordinates: coords };
            case 'landuse':
              return { layer, class: p.class || null, dist, coordinates: coords };
            default:
              return null;
          }
        }).filter(Boolean);

        // Deduplicate natural_label by name
        const nlSeen = new Map();
        const deduped = [];
        raw.forEach(f => {
          if (f.layer === 'natural_label' && f.name) {
            if (!nlSeen.has(f.name)) nlSeen.set(f.name, f);
          } else {
            deduped.push(f);
          }
        });
        deduped.push(...nlSeen.values());
        deduped.sort((a, b) => a.dist - b.dist);
        items = deduped;

        if (items.length > 0 || exp === MAX_EXPANSIONS) break;
        currentRadius *= EXPAND_FACTOR;
        if (this.config.DEBUG) console.log(`[MapboxMCP] natural 0件 → radius ${Math.round(currentRadius)}mに拡張`);
      }

      return this._minify({
        source:      'Tilequery API (natural features)',
        layers:      'water,waterway,landuse,natural_label',
        radius_used: Math.round(currentRadius),
        count:       items.length,
        items,
      });

    } catch (err) {
      if (this.config.DEBUG) console.error('[MapboxMCP] _scanNaturalFeatures error:', err);
      return JSON.stringify({ error: err.message });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Tool impl: check_travel_time
  // ─────────────────────────────────────────────────────────────

  /**
   * Lightweight Directions API call that returns only duration.
   * Uses steps=false&overview=false to minimize response size.
   */
  async _checkTravelTime(fromLat, fromLng, toLat, toLng, profile) {
    const prof = profile === 'walking' ? 'walking' : 'driving';
    const url =
      `https://api.mapbox.com/directions/v5/mapbox/${prof}/` +
      `${fromLng},${fromLat};${toLng},${toLat}` +
      `?access_token=${this.token}&steps=false&overview=false&alternatives=false`;

    try {
      const res  = await this._fetchTilequeryWithCache(url);
      if (!res.ok) return JSON.stringify({ error: `Directions API ${res.status}` });
      const data = await res.json();

      if (data.code !== 'Ok' || !data.routes?.length) {
        return JSON.stringify({ error: 'ルートが取得できませんでした', code: data.code });
      }

      const secs    = data.routes[0].duration;           // seconds (float)
      const minutes = secs / 60;
      const rounded = Math.round(minutes);
      const text    = rounded < 1 ? '約1分未満' : `約${rounded}分`;

      return this._minify({
        source:           'Mapbox Directions API',
        profile:          prof,
        duration_seconds: Math.round(secs),
        duration_minutes: Math.round(minutes * 10) / 10,  // 1 decimal
        duration_text:    text,
      });

    } catch (err) {
      if (this.config.DEBUG) console.error('[MapboxMCP] _checkTravelTime error:', err);
      return JSON.stringify({ error: err.message });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Tool impl: get_facing_road
  // ─────────────────────────────────────────────────────────────

  /**
   * Determine the road class a POI faces by progressively expanding radius.
   * Tries 10m → 30m → 50m until road features are found.
   * Returns roads sorted by class priority (largest first).
   */
  async _getFacingRoad(lat, lng) {
    // Use static ROAD_CLASS_RANK (excludes rails, ferries, point data)

    const radii = [10, 30, 50];
    let roads = [];
    let usedRadius = 0;

    for (const radius of radii) {
      const url =
        `${this.config.TILEQUERY_API}/${lng},${lat}.json` +
        `?access_token=${this.token}` +
        `&radius=${radius}&limit=${this.config.TILEQUERY_LIMIT}&dedupe=true&layers=road`;
      try {
        const res  = await this._fetchTilequeryWithCache(url);
        if (!res.ok) continue;
        const data = await res.json();

        roads = (data.features || [])
          .filter(f => {
            const g = f.properties?.tilequery?.geometry;
            return !g || g === 'point' || g === 'linestring';
          })
          .map(f => ({
            dist:  Math.round(f.properties?.tilequery?.distance || 0),
            name:  f.properties?.name  || null,
            class: f.properties?.class || null,
            type:  f.properties?.type  || null,
            ref:   f.properties?.ref   || null,
          }))
          // Exclude non-road classes (rails, ferries, aerialways) and point data
          .filter(f => f.class
            && !MapboxMCPClient.NON_ROAD_CLASSES.has(f.class)
            && !MapboxMCPClient.POINT_DATA_CLASSES.has(f.class)
            && MapboxMCPClient.ROAD_CLASS_RANK[f.class] != null
          );

        if (roads.length > 0) { usedRadius = radius; break; }
      } catch (_) { continue; }
    }

    if (roads.length === 0) {
      return this._minify({ found: false, radius_tried: 50 });
    }

    // Sort by road class priority, then by distance (closest first)
    roads.sort((a, b) => {
      const ra = MapboxMCPClient.ROAD_CLASS_RANK[a.class] ?? 99;
      const rb = MapboxMCPClient.ROAD_CLASS_RANK[b.class] ?? 99;
      return ra !== rb ? ra - rb : a.dist - b.dist;
    });

    // Deduplicate by name (keep closest per name)
    const seen = new Map();
    roads.forEach(r => {
      const key = r.name ?? `unnamed_${r.class}_${r.dist}`;
      if (!seen.has(key)) seen.set(key, r);
    });
    const unique = [...seen.values()];

    return this._minify({
      found:        true,
      radius_used:  usedRadius,
      primary_road: unique[0],
      all_roads:    unique,
      road_classes: unique.map(r => r.class).join(', '),
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Tool impl: find_intersections
  // ─────────────────────────────────────────────────────────────

  async _findIntersections(lat, lng, radius, nameFilter = null) {
    // グリッド方式: 小半径(100m)で複数点から検索し道路線分による50件枠の圧迫を回避
    const GRID_RADIUS = 100;
    const DEG_LNG = 1 / (111320 * Math.cos(lat * Math.PI / 180));
    const DEG_LAT = 1 / 110540;
    const spacingM = GRID_RADIUS * 1.5;

    // searchラジウスからグリッド点を生成
    const gridPoints = [];
    const steps = Math.max(1, Math.ceil(radius / spacingM));
    for (let iy = -steps; iy <= steps; iy++) {
      for (let ix = -steps; ix <= steps; ix++) {
        const gLat = lat + iy * spacingM * DEG_LAT;
        const gLng = lng + ix * spacingM * DEG_LNG;
        // 元のsearch半径内の点だけ使う
        const d = Math.sqrt((ix * spacingM) ** 2 + (iy * spacingM) ** 2);
        if (d <= radius) gridPoints.push([gLng, gLat]);
      }
    }

    try {
      const results = await Promise.all(gridPoints.map(async ([gLng, gLat]) => {
        const url =
          `${this.config.TILEQUERY_API}/${gLng},${gLat}.json` +
          `?access_token=${this.token}&radius=${GRID_RADIUS}&limit=${this.config.TILEQUERY_LIMIT}&dedupe=true&layers=road`;
        const res = await this._fetchTilequeryWithCache(url);
        if (!res.ok) return [];
        const data = await res.json();
        return (data.features || [])
          .filter(f => f.properties?.class === 'intersection' && f.properties?.name)
          .map(f => ({
            name:      f.properties.name,
            latitude:  f.geometry?.coordinates?.[1],
            longitude: f.geometry?.coordinates?.[0],
          }))
          .filter(f => f.latitude != null && f.longitude != null);
      }));

      // dedup by name+coord, recalculate distance from original center
      const center = turf.point([lng, lat]);
      const seen = new Map();
      results.flat().forEach(item => {
        const key = `${item.name}|${Math.round(item.longitude * 1000)}|${Math.round(item.latitude * 1000)}`;
        if (!seen.has(key)) seen.set(key, item);
      });

      let items = [...seen.values()].map(item => ({
        ...item,
        distance: Math.round(turf.distance(center, turf.point([item.longitude, item.latitude]), { units: 'meters' })),
      }));

      if (nameFilter) {
        const filter = nameFilter.toLowerCase();
        items = items.filter(f => f.name.toLowerCase().includes(filter));
      }

      items.sort((a, b) => a.distance - b.distance);

      return this._minify({
        source: 'Tilequery API (road layer, class=intersection, grid)',
        count:  items.length,
        items,
      });
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Tool impl: find_traffic_signals
  // ─────────────────────────────────────────────────────────────

  async _findTrafficSignals(lat, lng, radius) {
    // グリッド方式: 道路線分による50件枠圧迫を回避
    const GRID_RADIUS = 100;
    const DEG_LNG = 1 / (111320 * Math.cos(lat * Math.PI / 180));
    const DEG_LAT = 1 / 110540;
    const spacingM = GRID_RADIUS * 1.5;

    const gridPoints = [];
    const steps = Math.max(1, Math.ceil(radius / spacingM));
    for (let iy = -steps; iy <= steps; iy++) {
      for (let ix = -steps; ix <= steps; ix++) {
        const d = Math.sqrt((ix * spacingM) ** 2 + (iy * spacingM) ** 2);
        if (d <= radius) gridPoints.push([lng + ix * spacingM * DEG_LNG, lat + iy * spacingM * DEG_LAT]);
      }
    }

    try {
      const results = await Promise.all(gridPoints.map(async ([gLng, gLat]) => {
        const url =
          `${this.config.TILEQUERY_API}/${gLng},${gLat}.json` +
          `?access_token=${this.token}&radius=${GRID_RADIUS}&limit=${this.config.TILEQUERY_LIMIT}&dedupe=true&layers=road`;
        const res = await this._fetchTilequeryWithCache(url);
        if (!res.ok) return [];
        const data = await res.json();
        return (data.features || [])
          .filter(f => f.properties?.class === 'traffic_signals')
          .map(f => ({
            latitude:  f.geometry?.coordinates?.[1],
            longitude: f.geometry?.coordinates?.[0],
          }))
          .filter(f => f.latitude != null && f.longitude != null);
      }));

      const center = turf.point([lng, lat]);
      const seen = new Map();
      results.flat().forEach(item => {
        const key = `${Math.round(item.longitude * 1000)}|${Math.round(item.latitude * 1000)}`;
        if (!seen.has(key)) seen.set(key, item);
      });

      const items = [...seen.values()].map(item => ({
        ...item,
        distance: Math.round(turf.distance(center, turf.point([item.longitude, item.latitude]), { units: 'meters' })),
      })).sort((a, b) => a.distance - b.distance);

      return this._minify({
        source: 'Tilequery API (road layer, class=traffic_signals, grid)',
        count:  items.length,
        items,
      });
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Tool impl: scan_street_features
  // ─────────────────────────────────────────────────────────────

  /**
   * Tilequeryでstreets-v8を対象に道路・駅出入口を取得する。(spec §4-B-2)
   * target に応じてリクエストするレイヤーを絞り込み、50件枠を有効活用する。
   * geometry typeは point/linestring のみ（polygonを除外）。
   *
   * @param {number} lat
   * @param {number} lng
   * @param {number} radius
   * @param {'road'|'transit'|'both'} target
   */
  async _scanStreetFeatures(lat, lng, radius, target = 'both') {
    const layerMap = {
      road:    'road',
      transit: 'transit_stop_label',
      both:    'road,transit_stop_label',
    };
    const layers = layerMap[target] || 'road,transit_stop_label';

    const MAX_EXPANSIONS = 3;
    const EXPAND_FACTOR  = 1.2;
    let   currentRadius  = radius;
    let   capped         = [];

    try {
      for (let exp = 0; exp <= MAX_EXPANSIONS; exp++) {
        const url =
          `${this.config.TILEQUERY_API}/${lng},${lat}.json` +
          `?access_token=${this.token}` +
          `&radius=${Math.round(currentRadius)}` +
          `&limit=${this.config.TILEQUERY_LIMIT}` +
          `&dedupe=true` +
          `&layers=${layers}`;

        const res  = await this._fetchTilequeryWithCache(url);
        if (!res.ok) return JSON.stringify({ error: `Tilequery HTTP ${res.status}` });
        const data = await res.json();

        const rawFeatures = (data.features || [])
          .filter(f => {
            const g = f.properties?.tilequery?.geometry;
            return !g || g === 'point' || g === 'linestring';
          })
          .map(f => this._filterTilequeryFeature(f))
          .filter(Boolean);

        // Deduplicate named road features
        const roadSeen = new Map();
        const items = [];
        rawFeatures.forEach(f => {
          if (f.layer === 'road' && f.name) {
            const prev = roadSeen.get(f.name);
            if (!prev || f.dist < prev.dist) roadSeen.set(f.name, f);
          } else {
            items.push(f);
          }
        });
        items.push(...roadSeen.values());
        items.sort((a, b) => (a.dist ?? 0) - (b.dist ?? 0));
        capped = items.slice(0, 25);

        if (capped.length > 0 || exp === MAX_EXPANSIONS) break;
        currentRadius *= EXPAND_FACTOR;
        if (this.config.DEBUG) console.log(`[MapboxMCP] scan 0件 → radius ${Math.round(currentRadius)}mに拡張`);
      }

      return this._minify({
        source:      'Tilequery API (streets-v8)',
        layers,
        radius_used: Math.round(currentRadius),
        count:       capped.length,
        items:       capped,
      });

    } catch (err) {
      if (this.config.DEBUG) console.error('[MapboxMCP] _scanStreetFeatures error:', err);
      return JSON.stringify({ error: err.message });
    }
  }

  /**
   * Extract only the spec-required fields per layer. (spec §4-B-2)
   * Returns null for unknown/unneeded layers.
   *
   * @param {object} feature - GeoJSON feature from Tilequery response
   * @returns {object|null}
   */
  _filterTilequeryFeature(feature) {
    const p     = feature.properties || {};
    const tq    = p.tilequery || {};
    const layer = tq.layer;
    const dist  = Math.round(tq.distance || 0);

    switch (layer) {

      case 'road': {
        const cls = p.class || null;
        return {
          layer,
          category: MapboxMCPClient.getRoadCategory(cls),
          dist,
          name:  p.name  || null,
          type:  p.type  || null,
          ref:   p.ref   || null,
          class: cls,
        };
      }

      case 'transit_stop_label':
        return {
          layer:     'transit',     // shortened from 'transit_stop_label'
          dist,
          name:      p.name       || null,
          stop_type: p.stop_type  || null,  // entrance / stop
          mode:      p.mode       || null,  // metro / rail ...
          coords:    feature.geometry?.coordinates || null, // shortened from 'coordinates'
        };

      default:
        return null;
    }
  }
}
