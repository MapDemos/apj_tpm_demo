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
    this._isoRequests    = 0;   // Isochrone API request count (actual fetches only)
    this._isoCacheHits   = 0;   // Isochrone cache hits (within-run isoCache)
    this._siRequests     = 0;   // Static Images API request count（地図OFF時の静的地図。index.js が加算）
    this._capHit         = { tq: 0, sb: 0, iso: 0 }; // 上限到達でスキップした回数（ユーザー通知用）
    this._tqCache        = new Map(); // url → parsed JSON (cleared on chat reset)
    this._poiGridCache      = new Map();
    this._searchResultCache = new Map();
    this._resultBuffer         = new Map(); // id → full item (lat/lng lookup)
    this._resultIdCounter      = 0;        // auto-increment across all searches
    this._primarySearchIds     = new Set(); // IDs from primary_search (cleared at step1_main)
    this._lastIsochroneData = null; // visualization用
    this._evalPolygons      = []; // Step2 evaluation reach polygons (circle/isochrone) for map drawing
    this._gridCircles       = []; // Tilequery grid points {lng,lat,radius}（実際に問い合わせた点）
    this._gridCirclesSkipped = []; // 穴skip等で問い合わせなかったグリッド点 {lng,lat,radius}
    this._gridPointsCache   = new Map(); // gridKey → {points,skipped,radius}（cache HIT時もグリッド可視化するため）
  }

  /** Reset per-query API request counters (called at each new query; caps are per-query). */
  resetRequestCounts() {
    this._sbRequests = 0;
    this._tqRequests = 0;
    this._tqCacheHits = 0;
    this._isoRequests = 0;
    this._isoCacheHits = 0;
    this._siRequests = 0;
    this._capHit = { tq: 0, sb: 0, iso: 0 };
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
        description: '【二次検索補助】AとBの中点座標と矩形bboxを計算する。「AとBの間」のエリアを二次検索の範囲として使う際に使用。ルート沿いかどうかの判定はget_route_poisで別途行うこと。',
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
              enum: ['specific', 'category_building', 'category_busstop', 'category_busstop_location', 'intersection', 'signal'],
              description: 'クエリの種別。specific=固有名・通常POI、category_building=マンション/アパート/ビル、category_busstop=バス停名あり（バス停タイルセット・代表点）、category_busstop_location=バス停カテゴリ・位置関係のみ（transit_stop_label mode=bus・個別ポイント）、intersection=交差点、signal=信号機',
            },
            purpose: {
              type: 'string',
              enum: ['primary_search', 'step1'],
              description: 'primary_search=一次検索（proximity確定用）→結果にlat/lngなし。step1=二次検索以降→結果にlat/lngあり。デフォルト: step1',
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

      // ── Tool: resolve_result ──────────────────────────────────
      {
        name: 'resolve_result',
        description: 'search_nearby_poiで返されたidから緯度経度を取得する。一次検索で選んだ候補のproximity座標取得、またはStep1で取得した候補の座標一括取得に使用。',
        input_schema: {
          type: 'object',
          properties: {
            ids: { type: 'array', items: { type: 'number' }, description: '取得するid配列' },
          },
          required: ['ids'],
        },
      },

      // ── Tool: evaluate_distance ───────────────────────────────
      {
        name: 'evaluate_distance',
        description:
          '距離・近接条件の評価。ユーザーの言葉から proximity_level を選ぶだけでよい。内部実装（circle/isochrone/buildingID）はMCPが選択する。\n' +
          'proximity_level の選択基準:\n' +
          '  same_building = 同じビルの中\n' +
          '  adjacent      = 隣・目の前・すぐ隣（~50m）\n' +
          '  very_close    = すぐ近く・出てすぐ（~250m歩き）\n' +
          '  nearby        = 近く・付近・そば（~700m歩き）\n' +
          '  somewhat_nearby = 少し歩く（~1.4km歩き）\n' +
          '  far           = かなり歩く（距離が曖昧すぎて判定不可・全候補通過・実質フィルタなし）\n' +
          '※ far は evaluate_distance を呼ばず他の条件で評価するのが推奨。呼ばれた場合は全候補を通過させる。',
        input_schema: {
          type: 'object',
          properties: {
            proximity_level: {
              type: 'string',
              enum: ['same_building', 'adjacent', 'very_close', 'nearby', 'somewhat_nearby', 'far'],
              description: '距離レベル',
            },
            anchor_lat: { type: 'number', description: 'アンカー地点の緯度' },
            anchor_lng: { type: 'number', description: 'アンカー地点の経度' },
            candidates: {
              type: 'array',
              description: '判定する候補POIリスト',
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
            direction: {
              type: 'string',
              enum: ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'],
              description: '方向制約（オプション）。「北に」→ north 等。',
            },
            profile: {
              type: 'string',
              enum: ['walking', 'driving'],
              description: 'デフォルト: walking。ユーザーが車と明示した場合のみ driving。',
            },
          },
          required: ['proximity_level', 'anchor_lat', 'anchor_lng', 'candidates'],
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


      // ── Tool: compute_bbox_from_points ────────────────────
      {
        name: 'compute_bbox_from_points',
        description:
          '複数の座標からbboxを計算する。駅の出口が指定されていない場合に全出口座標を渡してbboxを求め、' +
          '二次検索の範囲として使用する。最小パディング150mで小さすぎるbboxを防ぐ。\n' +
          '使い方: scan_street_features(target="transit")で全出口を取得 → 出口座標をpointsに渡す → bboxで二次検索',
        input_schema: {
          type: 'object',
          properties: {
            points: {
              type: 'array',
              description: '座標リスト',
              items: {
                type: 'object',
                properties: {
                  latitude:  { type: 'number' },
                  longitude: { type: 'number' },
                },
                required: ['latitude', 'longitude'],
              },
            },
            min_padding_meters: {
              type: 'number',
              description: '最小パディング(m)。デフォルト150m。点が集中していても最低この半径を確保。',
            },
          },
          required: ['points'],
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
          return await this._searchNearbyPOI(queries, args.proximity || null, args.bbox || null, args.query_intent || null, args.radius_meters || null, args.purpose === 'primary_search');
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
        case 'compute_bbox_from_points':
          return this._computeBboxFromPoints(args.points || [], args.min_padding_meters ?? 150);
        case 'get_facing_road':
          return await this._getFacingRoad(args.lat, args.lng);
        case 'evaluate_distance':
          return await this._evaluateDistance(
            args.proximity_level, args.anchor_lat, args.anchor_lng,
            args.candidates || [], args.direction || null, args.profile || 'walking'
          );
        case 'find_intersections':
          return await this._findIntersections(args.lat, args.lng, args.radius, args.name_filter || null);
        case 'find_traffic_signals':
          return await this._findTrafficSignals(args.lat, args.lng, args.radius);
        case 'resolve_result':
          return this._resolveResult(args.ids || []);
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
    if (this.app?._cancelled) return { ok: true, json: async () => ({ features: [] }) }; // キャンセル中は新規発行しない
    // Safety cap: once the per-query Tilequery budget is hit, skip real requests.
    if (this._tqRequests >= (this.config.TQ_MAX_PER_QUERY ?? 2000)) {
      this._capHit.tq++;
      if (this.config.DEBUG) console.warn('[MapboxMCP] Tilequery cap reached — skipping request');
      return { ok: true, json: async () => ({ features: [] }) };
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
      // Use the actual (already upstream-bounded) search bbox — do NOT re-cap to ±500m,
      // which was smaller than e.g. an 8-min-walk condition area and excluded outer-ring
      // POIs (a ドミノピザ at ~550m from center was dropped from condition search).
      url += `&bbox=${this._capBBox(bbox, this.config.BBOX_MAX_HALF_M || 2000).join(',')}`;
    }

    if (this.app?._cancelled) return []; // キャンセル中は新規発行しない
    // Safety cap: skip Search Box requests once the per-query budget is hit.
    if (this._sbRequests >= (this.config.SB_MAX_PER_QUERY ?? 100)) {
      this._capHit.sb++;
      if (this.config.DEBUG) console.warn('[MapboxMCP] Search Box cap reached — skipping request');
      return [];
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
        const fullName = p.full_address || p.name || '';
        // bbox is meaningful for area types (place/locality/district); point types have none useful
        const bbox = ['place', 'locality', 'district'].includes(ft) ? (p.bbox || null) : null;
        // Prefecture (都道府県) parsed from the name — used to detect true homonyms
        // (Search Box context.region is often null for JP addresses).
        const prefMatch = fullName.match(/([^\s〒0-9-]+?[都道府県])/);
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
          prefecture:   prefMatch ? prefMatch[1] : null,
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

  /**
   * Normalize a name for dedup / matching:
   * - NFKC（全角英数→半角、半角カナ→全角カナ・濁点結合）
   * - ひらがな→カタカナ（すし→スシ、ﾌｧﾐﾏ→ファミマ→そのまま）
   * - 空白・中点・ハイフン・括弧を除去、小文字化。長音(ー)は保持。
   * 注: 漢字↔かな（寿司↔すし）は統一しない → それはQE(queries展開)で担保。
   */
  static _normalizeName(name) {
    if (!name) return '';
    let s = (MapboxMCPClient._cleanName(name) || '').normalize('NFKC');
    // ひらがな → カタカナ
    s = s.replace(/[ぁ-ゖ]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60));
    // 空白・中点・各種ハイフン・括弧類を除去（長音ー(U+30FC)は残す）
    s = s.replace(/[\s・‐-―−()\[\]「」【】\-]/g, '');
    return s.toLowerCase();
  }

  _matchesAnyQuery(name, queries) {
    if (!name || !queries?.length) return false;
    // Normalized matching so 表記揺れ（全半角/かなカナ/スペース）を吸収する。
    const nn = MapboxMCPClient._normalizeName(name);
    return queries.some(q => q && nn.includes(MapboxMCPClient._normalizeName(q)));
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

  // ── streets-v8 poi_label `class` の有効値（全21種・公式）──
  // POI_CATEGORY_CLASS で使う class 名はこの集合に含まれていること（タイポ防止）。
  static POI_LABEL_CLASSES = new Set([
    'arts_and_entertainment', 'building', 'commercial_services', 'education',
    'food_and_drink', 'food_and_drink_stores', 'general', 'historic', 'industrial',
    'landmark', 'lodging', 'medical', 'motorist', 'park_like', 'place_like',
    'public_facilities', 'religion', 'sport_and_leisure', 'store_like', 'visitor_amenities',
  ]);

  // ── Category words → streets-v8 poi_label class ──
  // For category POI targets (ホテル/カフェ等), many members don't contain the
  // category word in their name (東横イン, ドーミーイン…). Keeping poi_label hits
  // by class recovers them; L2 then rates relevance. Keys are matched by substring
  // against the normalized query, so both "ホテル" and "ビジネスホテル" hit lodging.
  // 慎重に1:1に近いカテゴリのみ登録する（food_and_drink 等は飲食全般で広すぎるので、
  // 精度優先で今は入れない。必要になったら都度追加）。
  static POI_CATEGORY_CLASS = [
    { words: ['ホテル', '宿', '旅館', 'ホステル', '民宿', 'ゲストハウス', 'ロッジ', '宿泊'], classes: ['lodging'] },
  ];

  /**
   * If any query is a known category word, return the poi_label class(es) that
   * category maps to (so we can keep tilequery hits by class, not just name).
   * @param {string[]} queries
   * @returns {string[]|null}
   */
  _queryPoiClasses(queries) {
    if (!queries?.length) return null;
    const norm = queries.map(q => MapboxMCPClient._normalizeName(q));
    for (const { words, classes } of MapboxMCPClient.POI_CATEGORY_CLASS) {
      if (words.some(w => norm.some(n => n.includes(MapboxMCPClient._normalizeName(w))))) return classes;
    }
    return null;
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
  _resolveResult(ids) {
    // resolve済みのIDは一次検索の削除対象から除外する（駅等のproximity確定済みIDを保護）
    ids.forEach(id => this._primarySearchIds.delete(id));

    const items = ids.map(id => {
      const item = this._resultBuffer.get(id);
      if (!item) return null;
      return {
        id,
        name:         item.name,
        latitude:     item.latitude,
        longitude:    item.longitude,
        full_address: item.full_address || null,
        feature_type: item.feature_type || null,
        bbox:         item.bbox         || null,
      };
    }).filter(Boolean);
    return this._minify({ count: items.length, items });
  }

  _assignIds(items, isPrimary = false) {
    return items.map(item => {
      const id = this._resultIdCounter++;
      this._resultBuffer.set(id, item);
      if (isPrimary) this._primarySearchIds.add(id);
      return { ...item, _rid: id };
    });
  }

  async _searchNearbyPOI(queries, proximity, bbox, queryIntent = null, radiusMeters = null, isPrimary = false, sharedGrid = null, noFallback = false) {
    // sharedGrid: pre-fetched poi_label items (buildPoiLabelGrid) reused across the
    // target + all poi conditions so we don't run one grid per query. When present,
    // the building/general paths partition it locally instead of fetching their own.
    // ── 信号・交差点クエリ: Tilequeryのみ（Search Box不可） ──
    // bboxが渡されている場合（localityのbbox等）はそのbboxの外接円半径を使い全域をカバーする
    // Condition search radius cap: cover the full condition bbox (§7-4 dual-bbox),
    // bounded to CONDITION_SEARCH_MAX_R to keep grid cost sane.
    const CONDITION_SEARCH_MAX_R = 1000;
    if (queryIntent === 'intersection' && proximity?.length >= 2) {
      const [lng, lat] = proximity;
      const r = bbox?.length >= 4
        ? Math.min(Math.ceil(this._bboxToRadius(bbox)), CONDITION_SEARCH_MAX_R)
        : Math.min(radiusMeters ?? 150, CONDITION_SEARCH_MAX_R);
      const nameFilter = queries?.[0] || null;
      return await this._findIntersections(lat, lng, r, nameFilter);
    }
    if (queryIntent === 'signal' && proximity?.length >= 2) {
      const [lng, lat] = proximity;
      const r = bbox?.length >= 4
        ? Math.min(Math.ceil(this._bboxToRadius(bbox)), CONDITION_SEARCH_MAX_R)
        : Math.min(radiusMeters ?? 150, CONDITION_SEARCH_MAX_R);
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

    const bboxForCache = bbox || null;
    const bboxSnapped = bboxForCache
      ? bboxForCache.map(v => Math.round(v * 1000)).join(',')
      : 'null';
    const searchCacheKey = `${queryIntent ?? 'auto'}|${queries.slice(0,2).join(',')}|${bboxSnapped}`;
    if (this._searchResultCache.has(searchCacheKey)) {
      if (this.config.DEBUG) console.log(`[SearchCache HIT] ${searchCacheKey}`);
      return this._searchResultCache.get(searchCacheKey);
    }

    // Coordinate-based dedup key: merges same-location results across both APIs
    const dedupKey = item => {
      const lng = item.longitude ?? 0;
      const lat = item.latitude  ?? 0;
      // Normalized name so 表記揺れ (鮨・魚菜きと vs 鮨 魚菜きと) at same spot merge.
      return `${MapboxMCPClient._normalizeName(item.name)}|${Math.round(lng * 1000)}|${Math.round(lat * 1000)}`;
    };

    const seen = new Map();

    const _notBlocked = (name) => {
      if (!name || typeof POI_BLOCKLIST_FLAT === 'undefined') return true;
      const n = name.toLowerCase();
      return !POI_BLOCKLIST_FLAT.some(b => n.startsWith(b.toLowerCase()));
    };

    const isBusStop = queryIntent === 'category_busstop' || (!queryIntent && this._isBusStopQuery(queries));
    // Building category is split into 3 intents (マンション/アパート/ビル); all share the same grid search.
    const BUILDING_INTENTS = ['category_building', 'category_mansion', 'category_apartment'];
    const isBuilding = BUILDING_INTENTS.includes(queryIntent) || (!queryIntent && !isBusStop && this._isBuildingQuery(queries));

    // bboxのみ渡された場合（proximityなし）は中心点をfallback proximityとして使用
    const effectiveProximity = proximity?.length >= 2
      ? proximity
      : (bbox?.length >= 4 ? [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2] : null);

    // ── 駅出口: transit_stop_label (stop_type=entrance) を出口名でフィルタ ──
    // 「B1出口」→ 実データはtransit_stop_labelにname="B1"。一般POI検索では拾えない。
    if (queryIntent === 'transit_entrance' && effectiveProximity) {
      const [lng, lat] = effectiveProximity;
      const entrances = await this.tilequeryTransitEntrances(lat, lng, 500);
      // 「B1出口」→「B1」、「3番出口」→「3」（出口/口/番を除去）
      let q = (queries[0] || '').replace(/(出口|口)\s*$/, '').replace(/番\s*$/, '').trim();
      const norm = s => MapboxMCPClient._normalizeName(s);
      const nq = norm(q);
      let filtered;
      if (!nq) {
        filtered = entrances; // 出口名指定なし → 全出口
      } else {
        filtered = entrances.filter(e => e.name && norm(e.name) === nq);              // 完全一致優先
        if (!filtered.length) filtered = entrances.filter(e => e.name && norm(e.name).includes(nq)); // なければ部分一致
      }
      const items = filtered.map(e => ({ name: e.name, latitude: e.lat, longitude: e.lng }));
      return this._minify({ source: 'transit_stop_label (entrance)', count: items.length, items });
    }

    // ── バス停ロケーション（名前なし・位置関係）: transit_stop_label mode=bus ──
    if (queryIntent === 'category_busstop_location' && effectiveProximity) {
      const [lng, lat] = effectiveProximity;
      const r = bbox?.length >= 4
        ? Math.min(Math.ceil(this._bboxToRadius(bbox)), 1000)  // §7-4: cover condition bbox
        : Math.min(radiusMeters ?? 200, 1000);
      return await this._busStopLocationSearch(lat, lng, r);
    }

    // ── Bus stop: use bus stop tileset only when explicitly mentioned ──
    if (isBusStop && effectiveProximity) {
      const [lng, lat] = effectiveProximity;
      // バス停名の検索は単発tilequery（グリッドなし）。半径は500m固定（bbox依存で広げない）。
      const radius = 500;
      if (this.config.DEBUG) console.log(`[MapboxMCP] バス停クエリ → バス停タイルセットのみ (r=${radius}m)`);
      const busStops = await this._busStopFallback(lat, lng, radius);
      busStops.forEach(item => { if (!seen.has(item.name)) seen.set(item.name, item); });
      const items = this._assignIds([...seen.values()].slice(0, 150), isPrimary);
      const result = this._minify({ source: 'バス停タイルセット (10da032y.busstop_gov_0608)', count: items.length, items, _debug: { sb_count: 0, tq_count: items.length, sb_items: [], tq_items: items.slice(0,30).map(i=>({name:i.name,distance:i.distance})) } });
      this._searchResultCache.set(searchCacheKey, result);
      return result;
    }

    // ── Building priority: Grid Tilequery (主) ＋ Search Box (並行補完) (マンション/アパート/ビル) ──
    // streets-v8 poi_label は建物の網羅性が高いのでグリッドTilequeryを主とし、poi_labelが取りこぼす
    // 名前付き建物を Search Box が並行で補完する（下記 bSbRequests・0件フォールバックではなく常に並行）。
    // Grid search covers bbox with overlapping circles (radius=65)。
    if (isBuilding && effectiveProximity) {
      const [lng, lat] = effectiveProximity;
      // If no bbox, create the default ±300m so expansion loop works correctly
      const DEG_LNG0 = 1 / (111320 * Math.cos(lat * Math.PI / 180));
      const DEG_LAT0 = 1 / 110540;
      const defM = 300;
      // JS-driven arch passes pre-computed bbox — use as-is (no cap).
      // Legacy agentic path may pass oversized bbox; _capBBox can be re-added there if needed.
      let currentBbox = bbox
        ? [...bbox]
        : [lng - defM*DEG_LNG0, lat - defM*DEG_LAT0, lng + defM*DEG_LNG0, lat + defM*DEG_LAT0];
      if (this.config.DEBUG)
        console.log(`[MapboxMCP] 建物系 → グリッドTilequery＋Search Box並行 (初期bbox幅=${Math.round((currentBbox[2]-currentBbox[0])*111320)}m)`);

      // Buildings query poi_label. Reuse the shared grid (filtered to this bbox) when
      // provided; else fetch our own dense grid. radius=65 keeps each grid point under
      // Tilequery's 50-cap so dense areas don't drop buildings like マンション.
      const tqItems = sharedGrid
        ? this._filterItemsToBbox(sharedGrid, currentBbox)
        : await this._gridTilequeryPOI(lat, lng, currentBbox, 65);
      // Building-category targets: keep only poi_label class=building (reliably drops
      // restaurants/shops/medical/etc. without name-guessing). Items with no class
      // (e.g. Search Box results) are kept.
      const buildingOnly = tqItems.filter(item => !item.cls || item.cls === 'building');
      if (this.config.DEBUG)
        console.log(`[MapboxMCP] 建物クラスフィルタ: ${tqItems.length}件 → ${buildingOnly.length}件 (class=building)`);
      const bTqItems = [], bSbItems = [];
      buildingOnly.forEach(item => {
        if (!_notBlocked(item.name)) return;
        const k = dedupKey(item);
        if (!seen.has(k)) { seen.set(k, item); bTqItems.push(item); }
      });

      // ── Search Box in PARALLEL as a supplement (not just a 0-hit fallback):
      //    poi_label misses some named buildings; Search Box catches them. ──
      const bSbRequests = queries.flatMap(q => {
        const qt = MapboxMCPClient.classifyQueryType(q);
        if (qt === 'place') return [this._searchBoxRequest(q, 'place,district,locality', proximity, currentBbox)];
        if (qt === 'poi')   return [this._searchBoxRequest(q, 'poi',                     proximity, currentBbox)];
        return [
          this._searchBoxRequest(q, 'poi',                     proximity, currentBbox),
          this._searchBoxRequest(q, 'place,district,locality', proximity, currentBbox),
        ];
      });
      const bSbResults = await Promise.all(bSbRequests);
      bSbResults.flat().forEach(item => {
        if (!_notBlocked(item.name)) return;
        const key = dedupKey(item);
        if (!seen.has(key)) { seen.set(key, item); bSbItems.push(item); }
      });

      const rawCount = seen.size; // pre-slice merged count → overflow signal
      // reach前に最寄150で切らない（到達圏の外側リングを取りこぼす／真の件数が見えずoverflow誘導が
      // 出ない不具合の原因だった）。距離順のまま全件返し、query-engine が到達圏フィルタ後に
      // CANDIDATE_LIMIT で丸める＋overflow判定する。
      const items = this._assignIds([...seen.values()]
        .sort((a, b) => (a.distance ?? 9999) - (b.distance ?? 9999)), isPrimary);
      const result = this._minify({
        source: 'Tilequery poi_label grid (buildings) + Search Box',
        count: items.length, items,
        _debug: {
          raw_count: rawCount,
          sb_count: bSbItems.length,
          tq_count: bTqItems.length,
          tq_dropped_count: tqItems.length - buildingOnly.length,
          sb_items:   bSbItems.slice(0, 50).map(i => ({ name: i.name, distance: i.distance })),
          tq_items:   bTqItems.slice(0, 50).map(i => ({ name: i.name, distance: i.distance, cls: i.cls })),
          tq_dropped: tqItems.filter(it => it.cls && it.cls !== 'building').slice(0, 50).map(i => ({ name: i.name, distance: i.distance, cls: i.cls })),
        },
      });
      this._searchResultCache.set(searchCacheKey, result);
      return result;
    }

    // JS-driven arch provides pre-validated bbox — use as-is.
    let currentBbox = bbox ? [...bbox] : null;

    // Determine if any query should trigger Tilequery (poi or both = has POI intent)
    const hasPOIQuery = queries.some(q => MapboxMCPClient.classifyQueryType(q) !== 'place');

    let sbCount = 0, tqCount = 0;
    const sbItems = [], tqItems = [], tqDropped = [];
    // Category classes for this query (e.g. ホテル → ['lodging']). When set, keep
    // tilequery poi_label hits by class even if the name lacks the category word.
    const wantClasses = this._queryPoiClasses(queries);

    // ── Search Box requests (type-classified per query) ──
    const sbRequests = queries.flatMap(q => {
      const qt = MapboxMCPClient.classifyQueryType(q);
      if (qt === 'place') return [this._searchBoxRequest(q, 'place,district,locality', effectiveProximity, currentBbox)];
      if (qt === 'poi')   return [this._searchBoxRequest(q, 'poi',                     effectiveProximity, currentBbox)];
      return [  // 'both'
        this._searchBoxRequest(q, 'poi',                     effectiveProximity, currentBbox),
        this._searchBoxRequest(q, 'place,district,locality', effectiveProximity, currentBbox),
      ];
    });

    // ── Tilequery poi_label (streets-v8) — grid search for poi/both queries ──
    // Skip the grid over very large areas (e.g. 鎌倉市全体): it would need
    // thousands of points. Search Box alone handles wide-area named POI well.
    // radius=65 (same as the building path): Tilequery caps at 50 results/point, so
    // in dense areas a larger radius lets high-density categories (buildings/shops)
    // fill every point's 50 slots and crowd out rarer categories (lodging etc.).
    // A tight radius keeps each point's poi_label count under the cap = no gaps.
    const bigArea = currentBbox && this._bboxToRadius(currentBbox) > 1500;
    const tqPromise = sharedGrid
      ? Promise.resolve(this._filterItemsToBbox(sharedGrid, currentBbox))
      : ((hasPOIQuery && effectiveProximity && !bigArea)
          ? this._gridTilequeryPOI(effectiveProximity[1], effectiveProximity[0], currentBbox, 65)
          : Promise.resolve([]));
    if (bigArea && this.config.DEBUG) console.log('[MapboxMCP] 広域のためグリッド省略、Search Boxのみ');

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
      // Keep if the name matches a query OR the poi_label class/maki matches the
      // query's category (recovers category members not named after the category).
      const nameMatch  = this._matchesAnyQuery(item.name, queries);
      const classMatch = wantClasses && (wantClasses.includes(item.cls) || wantClasses.includes(item.maki));
      if (!nameMatch && !classMatch) { tqDropped.push(item); return; }
      const key = dedupKey(item);
      if (!seen.has(key)) { seen.set(key, item); tqItems.push(item); tqCount++; }
    });

    // ── Final fallback: bus stop tileset (non-bus-stop queries only) ──
    // Disabled for condition collection (noFallback): a specific condition like ドミノピザ
    // with 0 hits must return 0 — NOT nearby bus stops, which would become bogus condition
    // items (e.g. 新丸子駅西口 matched as "ドミノピザ").
    if (!noFallback && seen.size === 0 && effectiveProximity && !this._isBusStopQuery(queries)) {
      if (this.config.DEBUG) console.log('[MapboxMCP] 0件 → バス停フォールバック');
      const [lng, lat] = effectiveProximity;
      const busStops = await this._busStopFallback(lat, lng, 500);
      busStops.forEach(item => {
        if (!seen.has(item.name)) seen.set(item.name, item);
      });
    }

    const rawCount = seen.size; // merged count → overflow signal（真の件数）
    // reach前に最寄150で切らない（外側リング取りこぼし＋overflow誘導不発の原因）。距離順で全件返し、
    // query-engine が到達圏フィルタ後に CANDIDATE_LIMIT で丸める＋overflow判定する。
    const items = this._assignIds([...seen.values()]
      .sort((a, b) => (a.distance ?? 9999) - (b.distance ?? 9999)), isPrimary);
    const tqActuallyRan = hasPOIQuery && proximity?.length >= 2;
    const source = items.length
      ? (tqActuallyRan ? 'Search Box + Tilequery poi_label (parallel)' : 'Search Box API')
      : 'no results';

    const result = this._minify({
      source,
      count: items.length,
      items,
      _debug: {
        raw_count: rawCount,
        sb_count: sbCount,
        tq_count: tqCount,
        tq_dropped_count: tqDropped.length,
        want_classes: wantClasses || null,
        sb_items:      sbItems.slice(0, 50).map(i => ({ name: i.name, distance: i.distance })),
        tq_items:      tqItems.slice(0, 50).map(i => ({ name: i.name, distance: i.distance, cls: i.cls })),
        tq_dropped:    tqDropped.slice(0, 50).map(i => ({ name: i.name, distance: i.distance, cls: i.cls })),
      },
    });
    this._searchResultCache.set(searchCacheKey, result);
    return result;
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
  async _gridTilequeryPOI(centerLat, centerLng, bbox, radius = 200, holePolygon = null, keepPolygons = null) {
    const bboxKey  = bbox?.map(v => Math.round(v * 10000)).join(',') ?? 'null';
    // hole/keep はグリッド点の取捨に影響する→cacheキーに署名を入れて別扱いにする（誤HIT防止）。
    const polySig  = (holePolygon ? 'h' + turf.bbox(holePolygon).map(v => Math.round(v * 1000)).join('_') : '') +
                     (keepPolygons?.length ? 'k' + keepPolygons.length + '_' + keepPolygons.map(p => turf.bbox(p).map(v => Math.round(v * 1000)).join('.')).join('|') : '');
    const gridKey  = `${Math.round(centerLat * 10000)},${Math.round(centerLng * 10000)},r${radius},${bboxKey}${polySig ? ',' + polySig : ''}`;
    if (this._poiGridCache.has(gridKey)) {
      if (this.config.DEBUG) console.log(`[POI grid cache HIT] ${gridKey}`);
      const cp = this._gridPointsCache.get(gridKey);
      if (cp) { // cache HIT でもグリッドを可視化
        this._recordGridCircles(cp.points, cp.radius);
        this._recordGridCircles(cp.skipped, cp.radius, true);
      }
      return this._poiGridCache.get(gridKey);
    }
    const DEG_LNG = 1 / (111320 * Math.cos(centerLat * Math.PI / 180));
    const DEG_LAT = 1 / 110540;
    // spacing ≤ radius×√2 for full corner coverage. Tilequery caps at 50 results
    // per point, so radius must be small enough to stay under the cap in dense
    // areas (otherwise nearest-50 truncation leaves gaps and drops buildings).
    const spacingM = radius * 1.3;

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

      // bbox が 2*radius より小さい場合：以前は「中心1点」に縮退させていたが、その1点は
      // radius(=65m) しか届かず、到達圏内でも radius 外(66〜80m)の建物を取りこぼす＋密集地で
      // 50件truncation。結果、条件の有無で条件bboxが広がると多点化して収集が変わる不整合の主因。
      // → 小bboxでも bbox 全体を覆う最小グリッド（各軸最低2点・spacing≤radius で重なり被覆）を張る。
      if (gMinLng >= gMaxLng || gMinLat >= gMaxLat) {
        const wM = (maxLng - minLng) / DEG_LNG, hM = (maxLat - minLat) / DEG_LAT;
        const nnx = Math.max(2, Math.ceil(wM / radius) + 1);
        const nny = Math.max(2, Math.ceil(hM / radius) + 1);
        gridPoints = [];
        for (let iy = 0; iy < nny; iy++) {
          for (let ix = 0; ix < nnx; ix++) {
            gridPoints.push([
              minLng + ix * (maxLng - minLng) / (nnx - 1),
              minLat + iy * (maxLat - minLat) / (nny - 1),
            ]);
          }
        }
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

    // 穴（内側isochrone内）のグリッド点はskip（proximity.within=「n分以上」のドーナツ収集のコスト削減）
    let skippedPoints = [];
    if (holePolygon) {
      const before = gridPoints.length;
      const kept = [];
      for (const p of gridPoints) {
        if (turf.booleanPointInPolygon(turf.point([p[0], p[1]]), holePolygon)) skippedPoints.push(p);
        else kept.push(p);
      }
      gridPoints = kept;
      if (this.config.DEBUG) console.log(`[MapboxMCP] 穴skip: ${before}→${gridPoints.length}点（skip ${skippedPoints.length}点）`);
    }

    // keepPolygons（proximity.within の到達圏＝各出口のisochrone等）が指定されたら、到達圏の
    // 外にあるグリッド点は問い合わせない＝bbox矩形全体でなく「到達圏の合計」だけを収集する。
    // 各点の円(半径radius)が到達圏に届く可能性を残すため、到達圏を radius ぶん buffer して内外判定。
    if (keepPolygons?.length) {
      const before = gridPoints.length;
      let buffered;
      try {
        buffered = keepPolygons.map(p => turf.buffer(p, radius, { units: 'meters' })).filter(Boolean);
      } catch (_) { buffered = keepPolygons; }
      const kept = [];
      for (const p of gridPoints) {
        const pt = turf.point([p[0], p[1]]);
        if (buffered.some(poly => turf.booleanPointInPolygon(pt, poly))) kept.push(p);
        else skippedPoints.push(p);
      }
      gridPoints = kept;
      if (this.config.DEBUG) console.log(`[MapboxMCP] 到達圏外skip: ${before}→${gridPoints.length}点`);
    }

    if (this.config.DEBUG)
      console.log(`[MapboxMCP] グリッドTilequery: ${gridPoints.length}点 × r=${radius}m`);

    // グリッド点＋半径を記録（デバッグ地図で可視化・cache用にも保存）。skipped=問い合わせなかった点。
    this._gridPointsCache.set(gridKey, { points: gridPoints, skipped: skippedPoints, radius });
    this._recordGridCircles(gridPoints, radius);
    this._recordGridCircles(skippedPoints, radius, true);

    const results = await Promise.all(
      gridPoints.map(([gLng, gLat]) => this._tilequeryBuildingSearch(gLat, gLng, radius))
    );

    // Dedup by name + coordinate
    const seen = new Map();
    results.flat().forEach(item => {
      const key = `${MapboxMCPClient._normalizeName(item.name)}|${Math.round((item.longitude ?? 0) * 1000)}|${Math.round((item.latitude ?? 0) * 1000)}`;
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

  /** Record grid points (with per-point radius) for debug map visualization.
   *  skipped=true → 問い合わせなかった点（穴skip等）を別配列に。 */
  _recordGridCircles(points, radius, skipped = false) {
    if (!points?.length) return;
    const arr = skipped ? (this._gridCirclesSkipped ||= []) : (this._gridCircles ||= []);
    arr.push(...points.map(([lng, lat]) => ({ lng, lat, radius })));
  }

  /**
   * Build ONE shared poi_label grid over a bbox (center = bbox center ≈ proximity),
   * reused by the target and every poi condition instead of each running its own grid.
   * All poi consumers (マンション/アパート/ビル/一般POI/poi条件) query poi_label, so a
   * single dense (radius=65) pass captures buildings + lodging + branded POIs together;
   * callers partition it locally by class/name. Cached via _gridTilequeryPOI.
   * @param {number[]} bbox  - [minLng, minLat, maxLng, maxLat] (usually condBbox = widest)
   * @param {number}   radius
   * @returns {Promise<Array>} deduped poi_label items { name, longitude, latitude, distance, cls, maki }
   */
  async buildPoiLabelGrid(bbox, radius = 65, holePolygon = null, keepPolygons = null) {
    if (!bbox || bbox.length < 4) return [];
    const centerLng = (bbox[0] + bbox[2]) / 2;
    const centerLat = (bbox[1] + bbox[3]) / 2;
    return this._gridTilequeryPOI(centerLat, centerLng, bbox, radius, holePolygon, keepPolygons);
  }

  /** Keep only items whose coordinate falls inside bbox (for partitioning a shared grid). */
  _filterItemsToBbox(items, bbox) {
    if (!bbox || bbox.length < 4) return items || [];
    const [minX, minY, maxX, maxY] = bbox;
    return (items || []).filter(it => {
      const lng = it.longitude ?? it.lng, lat = it.latitude ?? it.lat;
      return lng != null && lat != null && lng >= minX && lng <= maxX && lat >= minY && lat <= maxY;
    });
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
          cls:       f.properties?.class || null,   // streets-v8 poi_label class
          maki:      f.properties?.maki  || null,   // streets-v8 poi_label maki icon
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
  // Tool impl: category_busstop_location
  // streets-v8 transit_stop_label (mode=bus) で個別バス停ポイントを取得
  // ─────────────────────────────────────────────────────────────

  async _busStopLocationSearch(lat, lng, radius) {
    // グリッド方式: 半径500mで1点あたり50件枠に収まる（新宿駅でも<50件と実測）＝点数を大幅削減
    const GRID_RADIUS = 500;
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
    this._recordGridCircles(gridPoints, GRID_RADIUS); // デバッグ地図で可視化

    try {
      const results = await Promise.all(gridPoints.map(async ([gLng, gLat]) => {
        const url =
          `${this.config.TILEQUERY_API}/${gLng},${gLat}.json` +
          `?access_token=${this.token}&radius=${GRID_RADIUS}&limit=${this.config.TILEQUERY_LIMIT}&dedupe=true&layers=transit_stop_label&geometry=point`;
        const res = await this._fetchTilequeryWithCache(url);
        if (!res.ok) return [];
        const data = await res.json();
        return (data.features || [])
          .filter(f => f.properties?.mode === 'bus' && f.properties?.stop_type === 'stop')
          .map(f => ({
            name:      MapboxMCPClient._cleanName(f.properties.name) || null,
            latitude:  f.geometry?.coordinates?.[1],
            longitude: f.geometry?.coordinates?.[0],
          }))
          .filter(f => f.latitude != null && f.longitude != null);
      }));

      const center = turf.point([lng, lat]);
      const seen = new Map();
      results.flat().forEach(item => {
        const key = `${Math.round((item.longitude ?? 0) * 1000)}|${Math.round((item.latitude ?? 0) * 1000)}`;
        if (!seen.has(key)) seen.set(key, item);
      });

      const items = [...seen.values()].map(item => ({
        ...item,
        distance: Math.round(turf.distance(center, turf.point([item.longitude, item.latitude]), { units: 'meters' })),
      })).sort((a, b) => a.distance - b.distance);

      return this._minify({
        source: 'Tilequery API (transit_stop_label, mode=bus)',
        count:  items.length,
        items,
      });
    } catch (err) {
      if (this.config.DEBUG) console.error('[MapboxMCP] _busStopLocationSearch error:', err);
      return JSON.stringify({ error: err.message });
    }
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
      const res  = await this._fetchWithRetry(url);
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
    try {
      const url =
        `${this.config.TILEQUERY_API}/${lng},${lat}.json` +
        `?access_token=${this.token}&radius=${Math.round(radius)}&limit=${this.config.TILEQUERY_LIMIT}&dedupe=true` +
        `&layers=water,waterway,landuse,natural_label`;

      const res  = await this._fetchTilequeryWithCache(url);
      if (!res.ok) return JSON.stringify({ error: `Tilequery HTTP ${res.status}` });
      const data = await res.json();

      const raw = (data.features || []).map(f => {
        const p     = f.properties || {};
        const tq    = p.tilequery || {};
        const layer = tq.layer;
        const dist  = Math.round(tq.distance || 0);

        const geom = f.geometry;
        const coords = geom?.type === 'Point'
          ? geom.coordinates
          : geom?.coordinates?.[0] ?? null;

        switch (layer) {
          case 'water':
          case 'waterway':
            return { layer, dist, coordinates: coords };
          case 'natural_label':
            return { layer, name: p.name || null, class: p.class || null, dist, coordinates: coords };
          case 'landuse':
            return { layer, class: p.class || null, dist, coordinates: coords };
          default:
            return null;
        }
      }).filter(Boolean);

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

      return this._minify({
        source:      'Tilequery API (natural features)',
        layers:      'water,waterway,landuse,natural_label',
        radius_used: Math.round(radius),
        count:       deduped.length,
        items:       deduped,
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

      const secs    = data.routes[0].duration;
      const meters  = data.routes[0].distance;
      const minutes = secs / 60;
      const rounded = Math.round(minutes);
      const timeText = rounded < 1 ? '約1分未満' : `約${rounded}分`;
      const distText = meters < 1000 ? `約${Math.round(meters)}m` : `約${(meters / 1000).toFixed(1)}km`;

      return this._minify({
        source:           'Mapbox Directions API',
        profile:          prof,
        duration_seconds: Math.round(secs),
        duration_minutes: Math.round(minutes * 10) / 10,
        duration_text:    timeText,
        distance_meters:  Math.round(meters),
        distance_text:    distText,
      });

    } catch (err) {
      if (this.config.DEBUG) console.error('[MapboxMCP] _checkTravelTime error:', err);
      return JSON.stringify({ error: err.message });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────
  // Tool impl: check_same_building
  // ─────────────────────────────────────────────────────────────

  async _getBuildingId(lat, lng) {
    const url =
      `${this.config.TILEQUERY_API}/${lng},${lat}.json` +
      `?access_token=${this.token}&radius=10&limit=10&layers=building`;
    try {
      const res  = await this._fetchTilequeryWithCache(url);
      if (!res.ok) return null;
      const data = await res.json();
      // 点を「含む」建物を優先（tilequery.distance 昇順＝distance0=内包）。find(先頭)だと
      // 密集地で近傍の別ビルを拾い、same_building判定が誤マッチする原因になっていた。
      const buildings = (data.features || [])
        .filter(f => f.properties?.tilequery?.layer === 'building')
        .sort((a, b) => (a.properties.tilequery?.distance ?? 9) - (b.properties.tilequery?.distance ?? 9));
      return buildings[0]?.id ?? null;
    } catch (_) { return null; }
  }

  /**
   * Floor count of the building at a point, from streets-v8 building layer height
   * (≈ floors × 3m → ÷3). Same Tilequery URL as _getBuildingId, so the response is
   * cache-shared (no extra request). null when no building / no height data.
   */
  async _getBuildingFloors(lat, lng) {
    const url =
      `${this.config.TILEQUERY_API}/${lng},${lat}.json` +
      `?access_token=${this.token}&radius=10&limit=10&layers=building`;
    try {
      const res  = await this._fetchTilequeryWithCache(url);
      if (!res.ok) return null;
      const data = await res.json();
      // Pick the CLOSEST building that actually has a height (not just the first feature —
      // in dense areas a small heightless building can be returned before the tower the
      // point sits in). height ≈ floors × 3m → ÷3.
      const buildings = (data.features || [])
        .filter(f => f.properties?.tilequery?.layer === 'building'
                  && typeof f.properties?.height === 'number' && f.properties.height > 0)
        .sort((a, b) => (a.properties.tilequery?.distance ?? 9) - (b.properties.tilequery?.distance ?? 9));
      if (!buildings.length) return null;
      return Math.max(1, Math.round(buildings[0].properties.height / 3));
    } catch (_) { return null; }
  }

  async _checkSameBuilding(anchorLat, anchorLng, candidates) {
    const anchorId = await this._getBuildingId(anchorLat, anchorLng);

    if (!anchorId) {
      return this._minify({
        source:                'Tilequery API (building layer)',
        anchor_building_found: false,
        message:               'アンカー地点の建物データが見つかりませんでした',
        same_building:         [],
        other_building:        candidates.map(c => ({ name: c.name })),
      });
    }

    const results = await Promise.all(candidates.map(async c => {
      const id = await this._getBuildingId(c.latitude, c.longitude);
      return { ...c, same_building: id !== null && id === anchorId };
    }));

    return this._minify({
      source:               'Tilequery API (building layer)',
      anchor_building_id:   anchorId,
      same_building_count:  results.filter(r => r.same_building).length,
      same_building:        results.filter(r => r.same_building).map(({ name, latitude, longitude }) => ({ name, latitude, longitude })),
      other_building:       results.filter(r => !r.same_building).map(({ name }) => ({ name })),
    });
  }

  /**
   * Absolute filter for same_building: keep only candidates in the same building
   * polygon as any anchor item. Fallback (graceful degradation):
   *  - no anchor building id resolvable → UNEVALUABLE → keep all (never exclude)
   *  - candidate building id null → UNEVALUABLE → keep
   *  - candidate id ≠ anchor id BUT within tightM (隣接屋外/同一敷地) → keep (rescue)
   *  - candidate id ≠ anchor id and far → EXCLUDE
   * @returns {Promise<{kept:Array, excluded:Array}>}
   */
  async filterSameBuilding(mains, items, tightM = 8) {
    const ll = o => [o.longitude ?? o.lng, o.latitude ?? o.lat];
    const itemList = items || [];
    const mainList = mains || [];
    // building id 取得は各点独立 → 並列化（結果は同一）。
    const anchorIds = new Set(
      (await Promise.all(itemList.map(it => {
        const p = ll(it);
        return (p[0] == null || p[1] == null) ? null : this._getBuildingId(p[1], p[0]);
      }))).filter(Boolean)
    );
    if (anchorIds.size === 0) return { kept: mainList, excluded: [] }; // 評価不能 → 全員残す
    const mids = await Promise.all(mainList.map(m => {
      const mp = ll(m);
      return (mp[0] == null || mp[1] == null) ? null : this._getBuildingId(mp[1], mp[0]);
    }));
    const kept = [], excluded = [];
    mainList.forEach((m, i) => {
      const mp = ll(m);
      if (mp[0] == null || mp[1] == null) { kept.push(m); return; } // 評価不能
      const mid = mids[i];
      if (mid == null) { kept.push(m); return; }                    // 評価不能 → 残す
      if (anchorIds.has(mid)) { kept.push(m); return; }              // 同一ビル
      // 別ビルだが tightM 以内（隣接屋外・同一敷地）→ 救済
      const near = itemList.some(it => {
        const ip = ll(it);
        return ip[0] != null && ip[1] != null &&
          turf.distance(turf.point(mp), turf.point(ip), { units: 'meters' }) <= tightM;
      });
      if (near) kept.push(m); else excluded.push(m);
    });
    return { kept, excluded };
  }

  // Tool impl: compute_bbox_from_points
  // ─────────────────────────────────────────────────────────────

  _computeBboxFromPoints(points, minPaddingM = 150) {
    if (!points?.length) return JSON.stringify({ error: 'points is empty' });

    const lngs = points.map(p => p.longitude);
    const lats  = points.map(p => p.latitude);

    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);

    const centerLng = (minLng + maxLng) / 2;
    const centerLat = (minLat + maxLat) / 2;

    // 最小パディングを適用（点が集中していても最低minPaddingMを確保）
    const padLng = minPaddingM / (111320 * Math.cos(centerLat * Math.PI / 180));
    const padLat = minPaddingM / 110540;

    const rawBbox = [
      Math.min(minLng, centerLng - padLng),
      Math.min(minLat, centerLat - padLat),
      Math.max(maxLng, centerLng + padLng),
      Math.max(maxLat, centerLat + padLat),
    ];

    const bbox = this._capBBox(rawBbox);

    return this._minify({
      source: 'compute_bbox_from_points',
      count:  points.length,
      bbox,
      center: [+centerLng.toFixed(6), +centerLat.toFixed(6)],
    });
  }

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
  // Tool impl: filter_by_isochrone
  // ─────────────────────────────────────────────────────────────

  async _evaluateDistance(proximityLevel, anchorLat, anchorLng, candidates, direction, profile = 'walking') {
    switch (proximityLevel) {
      case 'same_building':
        return await this._checkSameBuilding(anchorLat, anchorLng, candidates);
      case 'adjacent':
        return await this._filterByIsochrone(anchorLat, anchorLng, null, profile, candidates, direction, 50);
      case 'very_close':
        return await this._filterByIsochrone(anchorLat, anchorLng, 3, profile, candidates, direction, null);
      case 'nearby':
        return await this._filterByIsochrone(anchorLat, anchorLng, 10, profile, candidates, direction, null);
      case 'somewhat_nearby':
        return await this._filterByIsochrone(anchorLat, anchorLng, 20, profile, candidates, direction, null);
      case 'far':
        return this._minify({
          source:        'evaluate_distance (far - no constraint)',
          proximity_level: 'far',
          inside_count:  candidates.length,
          outside_count: 0,
          inside_items:  candidates.map(({ name, latitude, longitude }) => ({ name, latitude, longitude })),
          outside_items: [],
        });
      default:
        return JSON.stringify({ error: `Unknown proximity_level: ${proximityLevel}` });
    }
  }

  _clipIsochroneToDirection(polygon, anchorLng, anchorLat, direction) {
    const B = 1; // 約100km、十分大きい
    const n = anchorLat + B, s = anchorLat - B, e = anchorLng + B, w = anchorLng - B;
    const halfPlane = {
      north: [w, anchorLat, e, anchorLat, e, n, w, n],
      south: [w, s, e, s, e, anchorLat, w, anchorLat],
      east:  [anchorLng, s, e, s, e, n, anchorLng, n],
      west:  [w, s, anchorLng, s, anchorLng, n, w, n],
    };
    const makeBox = (x1, y1, x2, y2, x3, y3, x4, y4) =>
      turf.polygon([[[x1,y1],[x2,y2],[x3,y3],[x4,y4],[x1,y1]]]);

    // 斜め方向は2つの基本方向に分解してclip
    const cards = [];
    if (direction.includes('north')) cards.push('north');
    if (direction.includes('south')) cards.push('south');
    if (direction.includes('east'))  cards.push('east');
    if (direction.includes('west'))  cards.push('west');

    let clipped = polygon;
    for (const card of cards) {
      const [x1,y1,x2,y2,x3,y3,x4,y4] = halfPlane[card];
      const box = makeBox(x1,y1,x2,y2,x3,y3,x4,y4);
      const result = turf.intersect(clipped, box); // turf v6: intersect(poly1, poly2)
      if (result) clipped = result;
    }
    return clipped;
  }

  /**
   * proximity.within(isochrone) 用: 1点の等時間到達ポリゴン(GeoJSON)を返す。
   * ISOキャップ内でのみ実API発行。取得失敗/上限は null。
   */
  async getIsochronePolygon(lat, lng, minutes, profile = 'walking') {
    const prof = ['walking', 'cycling', 'driving'].includes(profile) ? profile : 'walking';
    if (this.app?._cancelled) return null;
    if (this._isoRequests >= (this.config.ISO_MAX_PER_QUERY ?? 100)) { this._capHit.iso++; return null; }
    try {
      const url =
        `https://api.mapbox.com/isochrone/v1/mapbox/${prof}/${lng},${lat}` +
        `?contours_minutes=${minutes}&polygons=true&access_token=${this.token}`;
      this._isoRequests++;
      const res = await this._fetchWithRetry(url);
      if (!res.ok) return null;
      const data = await res.json();
      return data.features?.[0] || null;
    } catch (_) { return null; }
  }

  /**
   * 複数アンカー点の等時間ポリゴンをまとめ、外接bboxと各ポリゴンを返す。
   * @returns {Promise<{ bbox: number[]|null, polygons: object[] }>}
   */
  async isochroneReach(points, minutes, profile = 'walking') {
    // 各点（駅の複数出口など）のisochroneを並列取得して union（出口ごとに1コール・cacheあり）。
    const polys = await Promise.all(
      (points || []).map(p => this.getIsochronePolygon(p.lat, p.lng, minutes, profile))
    );
    const polygons = polys.filter(Boolean);
    if (!polygons.length) return { bbox: null, polygons: [] };
    let bb = turf.bbox(polygons[0]);
    for (let i = 1; i < polygons.length; i++) {
      const b = turf.bbox(polygons[i]);
      bb = [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])];
    }
    return { bbox: bb, polygons };
  }

  /** proximity.within のハード足切り。polygons のいずれかに内包 かつ hole の外、を満たす点だけ残す。
   *  - n分以内: polygons=[iso], hole=null → iso内。
   *  - n分以上(m分以内): polygons=null(外側はbbox), hole=内側iso → 内側isoの外（bboxが外側上限）。 */
  filterInsidePolygons(items, polygons, hole = null) {
    const hasPoly = !!(polygons && polygons.length);
    if (!hasPoly && !hole) return { kept: items || [], excluded: [] };
    const kept = [], excluded = [];
    for (const it of (items || [])) {
      const lng = it.longitude ?? it.lng, lat = it.latitude ?? it.lat;
      let ok = (lng != null && lat != null);
      if (ok) {
        const pt = turf.point([lng, lat]);
        if (hasPoly) ok = polygons.some(poly => turf.booleanPointInPolygon(pt, poly));
        if (ok && hole) ok = !turf.booleanPointInPolygon(pt, hole);
      }
      (ok ? kept : excluded).push(it);
    }
    return { kept, excluded };
  }

  /** within の「n分以上(m分以内)」用の探索範囲を計算。
   *  戻り値 { bbox, hole, tooLarge }：bbox=収集範囲、hole=内側iso(この外を残す)、
   *  tooLarge=内側isoが既定bboxを覆うほど大きい（=範囲広すぎ→既定bboxで探索）。 */
  async computeWithinReach(point, spec, defaultBbox) {
    const { minMinutes, maxMinutes, profile = 'walking' } = spec || {};
    if (!point || minMinutes == null) return null;
    const inner = await this.getIsochronePolygon(point.lat, point.lng, minMinutes, profile);
    if (!inner) return null;
    if (maxMinutes != null) { // ドーナツ: 外側=iso(m)、内側=iso(n)で除外
      const outer = await this.getIsochronePolygon(point.lat, point.lng, maxMinutes, profile);
      if (!outer) return null;
      // outer polygon も返す：候補を「外側(m分)内 ∧ 内側(n分)外」＝リングに絞るため（bbox矩形だけだと隅が漏れる）
      return { bbox: turf.bbox(outer), hole: inner, outer, tooLarge: false };
    }
    // n分以上（上限なし）: 外側=内側iso外接bboxを拡張。内側isoが既定bboxを覆うなら広すぎ。
    const ib = turf.bbox(inner);
    const bw = defaultBbox ? Math.abs(defaultBbox[2] - defaultBbox[0]) : Infinity;
    if (defaultBbox && Math.abs(ib[2] - ib[0]) >= bw * 0.9) {
      return { bbox: defaultBbox, hole: null, tooLarge: true }; // 範囲広すぎ→proximity周辺
    }
    const cx = (ib[0] + ib[2]) / 2, cy = (ib[1] + ib[3]) / 2, f = 1.5;
    return { bbox: [cx - (cx - ib[0]) * f, cy - (cy - ib[1]) * f, cx + (ib[2] - cx) * f, cy + (ib[3] - cy) * f], hole: inner, tooLarge: false };
  }

  async _filterByIsochrone(anchorLat, anchorLng, minutes, profile, candidates, direction = null, radiusMeters = null) {
    const prof = profile === 'driving' ? 'driving' : 'walking';

    try {
      let polygon;

      if (radiusMeters != null) {
        // 直線距離モード: turf.circle（APIコールなし）
        polygon = turf.circle(turf.point([anchorLng, anchorLat]), radiusMeters / 1000, { units: 'kilometers', steps: 64 });
      } else {
        // isochroneモード: Mapbox Isochrone API
        if (this._isoRequests >= (this.config.ISO_MAX_PER_QUERY ?? 100)) {
          return JSON.stringify({ error: 'Isochrone cap reached' });
        }
        const url =
          `https://api.mapbox.com/isochrone/v1/mapbox/${prof}/${anchorLng},${anchorLat}` +
          `?contours_minutes=${minutes}&polygons=true&access_token=${this.token}`;
        this._isoRequests++; // actual isochrone API call
        const res = await this._fetchWithRetry(url);
        if (!res.ok) return JSON.stringify({ error: `Isochrone API ${res.status}` });
        const data = await res.json();
        polygon = data.features?.[0];
        if (!polygon) return JSON.stringify({ error: 'isochrone polygon not returned' });
      }

      if (direction) {
        polygon = this._clipIsochroneToDirection(polygon, anchorLng, anchorLat, direction);
      }

      this._lastIsochroneData = { polygon, anchorLat, anchorLng, minutes, radiusMeters, profile: prof, direction };

      const results = candidates.map(c => {
        const inside = c.longitude != null && c.latitude != null
          ? turf.booleanPointInPolygon(turf.point([c.longitude, c.latitude]), polygon)
          : false;
        return { ...c, inside };
      });

      const insideItems  = results.filter(r => r.inside).map(({ name, latitude, longitude }) => ({ name, latitude, longitude }));
      const outsideItems = results.filter(r => !r.inside).map(({ name }) => ({ name }));

      return this._minify({
        source:        radiusMeters != null ? `turf.circle (${radiusMeters}m)` : 'Mapbox Isochrone API',
        profile:       prof,
        minutes,
        inside_count:  insideItems.length,
        outside_count: outsideItems.length,
        inside_items:  insideItems,
        outside_items: outsideItems,
      });
    } catch (err) {
      if (this.config.DEBUG) console.error('[MapboxMCP] _filterByIsochrone error:', err);
      return JSON.stringify({ error: err.message });
    }
  }


  // ─────────────────────────────────────────────────────────────
  // Tool impl: find_intersections
  // ─────────────────────────────────────────────────────────────

  async _findIntersections(lat, lng, radius, nameFilter = null) {
    // グリッド方式: 半径500m＋geometry=point（交差点はpoint。道路線分を拾わないので50件枠に収まる／実測<50）
    const GRID_RADIUS = 500;
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
    this._recordGridCircles(gridPoints, GRID_RADIUS); // デバッグ地図で可視化

    try {
      const results = await Promise.all(gridPoints.map(async ([gLng, gLat]) => {
        const url =
          `${this.config.TILEQUERY_API}/${gLng},${gLat}.json` +
          `?access_token=${this.token}&radius=${GRID_RADIUS}&limit=${this.config.TILEQUERY_LIMIT}&dedupe=true&layers=road&geometry=point`;
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
    // グリッド方式: 半径500m＋geometry=point（信号はpoint。道路線分を拾わないので50件枠に収まる／実測<50）
    const GRID_RADIUS = 500;
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
    this._recordGridCircles(gridPoints, GRID_RADIUS); // デバッグ地図で可視化

    try {
      const results = await Promise.all(gridPoints.map(async ([gLng, gLat]) => {
        const url =
          `${this.config.TILEQUERY_API}/${gLng},${gLat}.json` +
          `?access_token=${this.token}&radius=${GRID_RADIUS}&limit=${this.config.TILEQUERY_LIMIT}&dedupe=true&layers=road&geometry=point`;
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

    try {
      const url =
        `${this.config.TILEQUERY_API}/${lng},${lat}.json` +
        `?access_token=${this.token}` +
        `&radius=${Math.round(radius)}` +
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
      const capped = items.slice(0, 25);

      return this._minify({
        source:      'Tilequery API (streets-v8)',
        layers,
        radius_used: Math.round(radius),
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

  // ═══════════════════════════════════════════════════════════════
  // JS-DRIVEN ARCHITECTURE PUBLIC API (systemdesign v2.0)
  // Called by QueryEngine — not part of the agentic tool loop.
  // ═══════════════════════════════════════════════════════════════

  /**
   * Search Box wrapper for QueryEngine.
   * Returns raw feature array (not minified JSON).
   * @param {string} query
   * @param {{ types?: string, proximity?: number[], bbox?: number[] }} opts
   * @returns {Promise<{ features: Array }>}
   */
  async searchBox(query, opts = {}) {
    const types     = opts.types     || 'poi,address,place,locality';
    const proximity = opts.proximity || null;
    const bbox      = opts.bbox      || null;
    const features  = await this._searchBoxRequest(query, types, proximity, bbox);
    // Wrap to look like a GeoJSON FeatureCollection-ish for QueryEngine
    return {
      features: (features || []).map(f => ({
        geometry:   { coordinates: [f.longitude, f.latitude] },
        properties: {
          name:         f.name,
          full_address: f.full_address,
          feature_type: f.feature_type,
          bbox:         f.bbox,
          prefecture:   f.prefecture || null,
          place_formatted: f.full_address,
        },
      })),
    };
  }

  /**
   * Is there a road near (lat,lng)? Uses streets-v8 road layer (class-aware).
   * @param {object} opts - { majorOnly?:bool (幹線のみ), name?:string (道路名一致) }
   * @returns {Promise<{matched:boolean, nearestM:number|null}>}
   */
  async roadNear(lat, lng, radiusM, opts = {}) {
    const r = Math.min(Math.max(Math.ceil(radiusM), 30), 500);
    const url = `${this.config.TILEQUERY_API}/${lng},${lat}.json` +
      `?access_token=${this.token}&radius=${r}&limit=${this.config.TILEQUERY_LIMIT}&dedupe=true&layers=road`;
    try {
      const res = await this._fetchTilequeryWithCache(url);
      if (!res.ok) return { matched: false, nearestM: null };
      const data = await res.json();
      const MAJOR = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link']);
      let best = null;
      for (const f of (data.features || [])) {
        const p = f.properties || {};
        const cls = p.class;
        if (!cls || MapboxMCPClient.NON_ROAD_CLASSES.has(cls)) continue;   // exclude rail/ferry
        if (MapboxMCPClient.ROAD_CLASS_RANK[cls] == null) continue;         // roads only
        if (opts.majorOnly && !MAJOR.has(cls)) continue;
        if (opts.name && !((p.name || '').includes(opts.name))) continue;
        const d = Math.round(p.tilequery?.distance ?? 9999);
        if (best === null || d < best) best = d;
      }
      return { matched: best !== null, nearestM: best };
    } catch { return { matched: false, nearestM: null }; }
  }

  /**
   * Is there a railway near (lat,lng)? Uses streets-v8 road layer, but keeps ONLY the
   * rail classes (the inverse of roadNear). JR/私鉄/ケーブル/路面電車の区別はせず、
   * class に 'rail' を含むもの（major_rail/minor_rail/service_rail）をすべて「線路」とみなす。
   * ロジックは roadNear と同一（有無＋最短距離のみ）。
   * @returns {Promise<{matched:boolean, nearestM:number|null}>}
   */
  async railNear(lat, lng, radiusM) {
    const r = Math.min(Math.max(Math.ceil(radiusM), 30), 500);
    const url = `${this.config.TILEQUERY_API}/${lng},${lat}.json` +
      `?access_token=${this.token}&radius=${r}&limit=${this.config.TILEQUERY_LIMIT}&dedupe=true&layers=road`;
    try {
      const res = await this._fetchTilequeryWithCache(url);
      if (!res.ok) return { matched: false, nearestM: null };
      const data = await res.json();
      let best = null;
      for (const f of (data.features || [])) {
        const cls = f.properties?.class;
        if (!cls || !/rail/.test(cls)) continue; // rail 系クラスのみ（~rail）
        const d = Math.round(f.properties?.tilequery?.distance ?? 9999);
        if (best === null || d < best) best = d;
      }
      return { matched: best !== null, nearestM: best };
    } catch { return { matched: false, nearestM: null }; }
  }

  /**
   * Is there water near (lat,lng)? Uses streets-v8 water/waterway layer.
   * (川/海/湖の区別はデータ上つかない — 有無と距離のみ。)
   * @returns {Promise<{matched:boolean, nearestM:number|null}>}
   */
  async waterNear(lat, lng, radiusM) {
    const r = Math.min(Math.max(Math.ceil(radiusM), 30), 1000);
    const url = `${this.config.TILEQUERY_API}/${lng},${lat}.json` +
      `?access_token=${this.token}&radius=${r}&limit=${this.config.TILEQUERY_LIMIT}&dedupe=true&layers=water,waterway`;
    try {
      const res = await this._fetchTilequeryWithCache(url);
      if (!res.ok) return { matched: false, nearestM: null };
      const data = await res.json();
      let best = null;
      for (const f of (data.features || [])) {
        const d = Math.round(f.properties?.tilequery?.distance ?? 9999);
        if (best === null || d < best) best = d;
      }
      return { matched: best !== null, nearestM: best };
    } catch { return { matched: false, nearestM: null }; }
  }

  /**
   * Fetch all transit entrances (stop_type=entrance) near a station coordinate.
   * Used by QueryEngine._resolveStation.
   * @param {number} lat
   * @param {number} lng
   * @param {number} radiusM
   * @returns {Promise<Array<{name:string,lat:number,lng:number}>>}
   */
  async tilequeryTransitEntrances(lat, lng, radiusM = 500) {
    const url =
      `${this.config.TILEQUERY_API}/${lng},${lat}.json` +
      `?access_token=${this.token}` +
      `&radius=${Math.min(radiusM, 500)}&limit=${this.config.TILEQUERY_LIMIT}` +
      `&dedupe=true&layers=transit_stop_label`;

    try {
      const res = await this._fetchTilequeryWithCache(url);
      if (!res.ok) return [];
      const data = await res.json();
      // 出入口だけ拾う（maki または stop_type のどちらで entrance と付いていてもOK）。
      // mode は見ない：出入口は鉄道/地下鉄(mode=rail/metro_rail)専用でバス停は entrance 型を
      // 持たないため、entrance 判定だけでバス停は自然に除外される（mode絞りは metro_rail を
      // 巻き込み事故で落とすので入れない）。
      return (data.features || [])
        .filter(f => {
          const p = f.properties || {};
          return p.maki === 'entrance' || p.stop_type === 'entrance';
        })
        .map(f => ({
          name: f.properties?.name || null,
          lat:  f.geometry.coordinates[1],
          lng:  f.geometry.coordinates[0],
        }));
    } catch {
      return [];
    }
  }

  /**
   * resolveBBox — unified bbox computation (C-3 / systemdesign §9-2).
   * Replaces: _computeBboxFromPoints, calculateMidpointBBOX, radius→bbox inline.
   *
   * @param {{ points?: Array<{lng,lat,radiusM?,bbox?}>, marginM?: number }} opts
   * @returns {number[]} [minX, minY, maxX, maxY]
   */
  resolveBBox({ points = [], marginM = 0 }) {
    // Collect all coordinates
    const lngs = [];
    const lats  = [];
    let singleRadius = 0;

    for (const p of points) {
      if (p.bbox) {
        lngs.push(p.bbox[0], p.bbox[2]);
        lats.push(p.bbox[1],  p.bbox[3]);
        continue;
      }
      lngs.push(p.lng);
      lats.push(p.lat);
      // Apply radiusM for ALL points (not just single-point case)
      if (p.radiusM) {
        const dLng = p.radiusM / (111320 * Math.cos(p.lat * Math.PI / 180));
        const dLat = p.radiusM / 110540;
        lngs.push(p.lng - dLng, p.lng + dLng);
        lats.push(p.lat - dLat,  p.lat + dLat);
      }
    }

    if (lngs.length === 0) return [0, 0, 0, 0];

    let minLng = Math.min(...lngs);
    let maxLng = Math.max(...lngs);
    let minLat  = Math.min(...lats);
    let maxLat  = Math.max(...lats);

    const centerLng = (minLng + maxLng) / 2;
    const centerLat  = (minLat + maxLat) / 2;

    // Apply minimum padding (150m) to avoid zero-size bbox
    const padM   = Math.max(marginM, 150);
    const padLng = padM / (111320 * Math.cos(centerLat * Math.PI / 180));
    const padLat  = padM / 110540;

    return [
      Math.min(minLng, centerLng - padLng),
      Math.min(minLat,  centerLat  - padLat),
      Math.max(maxLng, centerLng + padLng),
      Math.max(maxLat,  centerLat  + padLat),
    ];
  }

  /**
   * Expand bbox by an absolute margin in meters on all four sides.
   * Used for condition bbox (C-2 / §7-4).
   * @param {number[]} bbox
   * @param {number} marginM
   * @returns {number[]}
   */
  expandBBox(bbox, marginM) {
    const [minX, minY, maxX, maxY] = bbox;
    const cy     = (minY + maxY) / 2;
    const dLng   = marginM / (111320 * Math.cos(cy * Math.PI / 180));
    const dLat   = marginM / 110540;
    return [minX - dLng, minY - dLat, maxX + dLng, maxY + dLat];
  }

  /**
   * Collect target candidates within bbox.
   * Returns plain item array (not minified JSON string).
   * @param {object} target - QuerySchema.target
   * @param {number[]} bbox
   * @returns {Promise<Array>}
   */
  async collectTarget(target, bbox, sharedGrid = null) {
    const proximity = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
    // Query Expansion: general-POI targets carry synonyms (寿司屋→寿司/鮨/すし).
    const queries   = (target.queries?.length ? target.queries : [target.text]);
    const resultStr = await this._searchNearbyPOI(
      queries, proximity, bbox, target.query_intent, null, false, sharedGrid
    );
    // Stash raw collection debug (SB/TQ/dropped lists) for the debug report.
    try {
      const parsed = typeof resultStr === 'string' ? JSON.parse(resultStr) : resultStr;
      this._lastTargetDebug = parsed?._debug || null;
    } catch { this._lastTargetDebug = null; }
    return this._parseItemsFromResult(resultStr);
  }

  /**
   * Collect condition candidates within bbox.
   * Returns plain item array.
   * @param {object} condition - QuerySchema.conditions[]
   * @param {number[]} bbox
   * @returns {Promise<Array>}
   */
  async collectCondition(condition, bbox, sharedGrid = null) {
    const proximity = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];

    // The search PATH is driven by condition.type (JS-driven), NOT by L1's query_intent.
    const intent = this._condTypeToIntent(condition.type);

    // Generic category words ("交差点"/"信号"/"バス停" etc.) must NOT be used as a
    // name filter / search query — they would filter everything out. Only pass a
    // query when the text is a SPECIFIC name (e.g. "○○交差点", "ローソン").
    const GENERIC_WORDS = [
      '交差点', '信号', '信号機', 'バス停', 'バス停留所', '停留所',
      '川', '海', '運河', '橋', '道', '道路', '通り', '大通り', '駅出口', '出口',
    ];
    let text = condition.text || null;
    if (text && GENERIC_WORDS.includes(text.trim())) text = null;

    // Query Expansion for poi conditions only (ローソン stays [ローソン], but a
    // category like 寿司 would expand). Non-poi types use the single name/nothing.
    let queries;
    if (condition.type === 'poi' && condition.queries?.length) {
      queries = condition.queries.filter(q => !GENERIC_WORDS.includes(q.trim()));
    } else {
      queries = text ? [text] : [];
    }

    // Only poi conditions consume the shared poi_label grid; other types (bus stop /
    // transit / intersection / signal) take their own layer branches inside.
    // noFallback=true: a 0-hit condition must stay 0 (no bus-stop fallback → no bogus items).
    const resultStr = await this._searchNearbyPOI(
      queries, proximity, bbox, intent, null, false, condition.type === 'poi' ? sharedGrid : null, true
    );
    return this._parseItemsFromResult(resultStr);
  }

  _condTypeToIntent(type) {
    switch (type) {
      case 'category_busstop':    return 'category_busstop_location'; // individual bus-stop points
      case 'intersection':        return 'intersection';
      case 'signal':              return 'signal';
      case 'transit_entrance':    return 'transit_entrance'; // transit_stop_label entrance layer
      default:                    return 'specific'; // poi / road / water
    }
  }

  _parseItemsFromResult(resultStr) {
    try {
      const parsed = typeof resultStr === 'string' ? JSON.parse(resultStr) : resultStr;
      const items  = Array.isArray(parsed?.items) ? parsed.items : [];
      // Normalize: guarantee a unique `id` and lat/lng aliases for QueryEngine.
      // Search results carry `_rid` (from _assignIds); bus-stop/intersection results carry none.
      return items.map((it, i) => ({
        ...it,
        id:  it.id ?? it._rid ?? `${this._resultIdCounter++}`,
        lat: it.lat ?? it.latitude,
        lng: it.lng ?? it.longitude,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Build a reach polygon (circle for radius, isochrone for time) centered on an
   * anchor point. Isochrone polygons are cached by anchor+minutes+profile.
   * @param {[number, number]} anchorLngLat - [lng, lat]
   * @param {{ useIsochrone, radiusM, minutes, profile }} distParams
   * @param {Map} isoCache
   * @returns {Promise<object|null>} GeoJSON polygon feature, or null
   */
  async _reachPolygon([lng, lat], distParams, isoCache) {
    if (!distParams.useIsochrone) {
      const radiusKm = (distParams.radiusM ?? 250) / 1000;
      return turf.circle(turf.point([lng, lat]), radiusKm, { units: 'kilometers', steps: 32 });
    }
    const prof = distParams.profile || 'walking';
    const mins = distParams.minutes;
    const cacheKey = `${lat},${lng},${mins},${prof}`;
    const cached = isoCache.get(cacheKey);
    if (cached) { this._isoCacheHits++; return cached; }
    if (this._isoRequests >= (this.config.ISO_MAX_PER_QUERY ?? 100)) {
      this._capHit.iso++;
      if (this.config.DEBUG) console.warn('[MapboxMCP] Isochrone cap reached — skipping request');
      return null;
    }
    const url =
      `https://api.mapbox.com/isochrone/v1/mapbox/${prof}/${lng},${lat}` +
      `?contours_minutes=${mins}&polygons=true&access_token=${this.token}`;
    this._isoRequests++; // actual isochrone API call
    try {
      const res = await this._fetchWithRetry(url);
      if (!res.ok) return null;
      const data = await res.json();
      const polygon = data.features?.[0] || null;
      if (polygon) isoCache.set(cacheKey, polygon);
      return polygon;
    } catch {
      return null;
    }
  }

  /**
   * Evaluate ALL main candidates against a condition's items in one pass.
   * Reach polygons (circle/isochrone) are built on the FEWER-cardinality side, so
   * a single fixed reference (e.g. one 出口/交差点) yields one isochrone call
   * instead of one-per-candidate — and the reach is centered on that reference,
   * which is the correct semantics for "X分以内 from the anchor". This is one
   * uniform rule applied to every condition (no special-casing per query shape).
   *
   * @param {Array<{ id, lat, lng }>} mainCandidates
   * @param {Array<{ lat, lng }>} conditionItems
   * @param {{ useIsochrone, useBuildingId, radiusM, minutes, profile, pushback }} distParams
   * @param {Map} isoCache
   * @param {string|null} direction - 'north'|'south'|'east'|'west': require the
   *   condition item to be on that side of the main candidate. null = any.
   * @returns {Promise<Map<string, number|null>>} matched mainId → nearestM (meters)
   */
  async evaluateDistanceBatch(mainCandidates, conditionItems, distParams, isoCache = new Map(), direction = null) {
    const matches = new Map(); // mainId → nearestM
    if (!mainCandidates?.length || !conditionItems?.length || distParams.pushback) return matches;

    const ll = (o) => [o.longitude ?? o.lng, o.latitude ?? o.lat];
    // Directional half-plane: item must be on `direction` side of the main candidate.
    const dirOK = ([mLng, mLat], [iLng, iLat]) => {
      if (!direction) return true;
      switch (direction) {
        case 'north': return iLat > mLat;
        case 'south': return iLat < mLat;
        case 'east':  return iLng > mLng;
        case 'west':  return iLng < mLng;
        default:      return true;
      }
    };
    // Nearest straight-line distance (m) from a main to any direction-valid item.
    const nearestFor = (mp) => {
      let n = null;
      for (const c of conditionItems) {
        const ip = ll(c);
        if (ip[0] == null || ip[1] == null || !dirOK(mp, ip)) continue;
        const d = turf.distance(turf.point(mp), turf.point(ip), { units: 'meters' });
        if (n == null || d < n) n = d;
      }
      return n;
    };

    // same_building: building-id comparison (per main; no polygon)
    if (distParams.useBuildingId) {
      for (const main of mainCandidates) {
        const mp = ll(main);
        if (mp[0] == null || mp[1] == null) continue;
        const mainId = await this._getBuildingId(mp[1], mp[0]);
        if (!mainId) continue;
        for (const c of conditionItems) {
          const ip = ll(c);
          if (ip[0] == null || ip[1] == null || !dirOK(mp, ip)) continue;
          const cId = await this._getBuildingId(ip[1], ip[0]);
          if (cId && cId === mainId) { matches.set(String(main.id), 0); break; }
        }
      }
      return matches;
    }

    // Build reach polygons on the fewer-cardinality side. 各anchorのpolygon取得は独立
    // なので並列fetch。同一座標はbatch内でdedup（radiusはローカル即時／isochroneの重複API防止。
    // isoCacheは条件をまたいで有効＝_evaluateがcondごとに逐次呼ぶため従来の再利用も維持）。
    const flip    = conditionItems.length <= mainCandidates.length;
    const anchors = flip ? conditionItems : mainCandidates;

    const polyByKey = new Map(); // "lat,lng" → Promise<poly>（batch内dedup）
    const anchorPolys = await Promise.all(anchors.map(a => {
      const ap = ll(a);
      if (ap[0] == null || ap[1] == null) return null;
      const key = `${ap[1]},${ap[0]}`;
      if (!polyByKey.has(key)) polyByKey.set(key, this._reachPolygon(ap, distParams, isoCache));
      return polyByKey.get(key);
    }));

    for (let ai = 0; ai < anchors.length; ai++) {
      const a  = anchors[ai];
      const ap = ll(a);
      const poly = anchorPolys[ai];
      if (ap[0] == null || ap[1] == null || !poly) continue;
      this._evalPolygons.push(poly);

      if (flip) {
        // anchor = condition item; test each main candidate against it
        for (const main of mainCandidates) {
          const mp = ll(main);
          if (mp[0] == null || mp[1] == null || !dirOK(mp, ap)) continue;
          if (turf.booleanPointInPolygon(turf.point(mp), poly)) {
            const nm = nearestFor(mp);
            const prev = matches.get(String(main.id));
            if (!matches.has(String(main.id)) || (nm != null && (prev == null || nm < prev))) {
              matches.set(String(main.id), nm);
            }
          }
        }
      } else {
        // anchor = main candidate; test each condition item against it
        for (const c of conditionItems) {
          const ip = ll(c);
          if (ip[0] == null || ip[1] == null || !dirOK(ap, ip)) continue;
          if (turf.booleanPointInPolygon(turf.point(ip), poly)) {
            matches.set(String(a.id), nearestFor(ap));
            break;
          }
        }
      }
    }

    return matches;
  }
}
