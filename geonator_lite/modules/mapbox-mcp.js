/**
 * Mapbox client (geonator_lite) — Search Box API + Tilequery API wrapper.
 *
 * Forked from geonator/modules/mapbox-mcp.js. The single biggest change (spec §5):
 * the hex-grid multi-point Tilequery sampling machinery (`_gridTilequeryPOI`,
 * `buildPoiLabelGrid`, and all the grid-point bookkeeping/visualization fields) is
 * DELETED. Candidate collection over the poi_label/building layers is now always
 * ONE Tilequery call per target/condition, at `config.TILEQUERY_RADIUS_M` with
 * `limit=50` (spec §5.1) — Mapbox's documented radius-sort behavior for both point
 * and polygon layers means a single large-radius call already returns the nearest
 * 50 in order (spec §5.1 rationale).
 *
 * Also removed: the agentic "return minified JSON string" tool-call convention
 * (`_minify`, `_resultBuffer`/`_resolveResult`, string round-tripping through
 * `_parseItemsFromResult`). geonator_lite's pipeline is plain JS-to-JS, not an
 * LLM tool-calling loop, so collection functions just return arrays directly.
 *
 * Kept essentially as-is: Search Box request logic, category_tag resolution,
 * road/rail/intersection/signal/transit_entrance/busstop Tilequery helpers
 * (now single-shot instead of grid-based), name normalization/dedup helpers,
 * same-building / floors / isochrone / distance-evaluation spatial helpers.
 */

const REACH_SPEED_M_PER_MIN = { walking: 80, cycling: 250, driving: 500 };

// 交差点/信号/駅出口/バス停等、Tilequery専用レイヤーだけを引く検索で、名前フィルタとして
// 渡してはいけない一般語（GENERIC_WORDS自体を名前フィルタにすると実データに一致せず全滅する）。
const GENERIC_WORDS = [
  '交差点', '信号', '信号機', 'バス停', 'バス停留所', '停留所',
  '川', '海', '運河', '橋', '道', '道路', '通り', '大通り', '駅出口', '出口',
];

class MapboxMCPClient {
  constructor(config) {
    this.config = config;
    this.token  = config.MAPBOX_ACCESS_TOKEN;

    this._sbRequests  = 0; // Search Box API request count (this run)
    this._tqRequests  = 0; // Tilequery API request count (actual fetches only)
    this._tqCacheHits = 0;
    this._isoRequests = 0;
    this._isoCacheHits = 0;
    this._capHit = { tq: 0, sb: 0, iso: 0 };
    this._tqCache = new Map(); // url → parsed JSON (per-run cache)
    this._searchResultCache = new Map();
    this._resultIdCounter = 0;
    this._evalPolygons = []; // Step2 evaluation reach polygons (circle/isochrone), kept for demo-app visualization
    this._lastTargetDebug = null;
    // Optional user-set search bbox (requestBody.bbox, [minLng,minLat,maxLng,maxLat]) — set by
    // QueryEngine.run() before collection starts. Unlike the old auto-derived locality bbox
    // (removed — see collection comments below), this is opt-in and UI-controlled, so it
    // doesn't reintroduce the "huge/skewed admin-boundary bbox" or "fixed 800m near-radius
    // excludes real targets" bugs that motivated the original removal.
    this._bbox = null;

    // 詳細APIログ（config.DEBUG_LOG時のみ収集。ONOFF切替可能・meta.log.apiCallsとして公開）
    this._apiLog = config.DEBUG_LOG ? [] : null;
  }

  /** 詳細APIログへの1件追加。config.DEBUG_LOGがfalseの間は完全に無処理（オーバーヘッド無し）。 */
  _logApi(entry) {
    if (!this._apiLog) return;
    this._apiLog.push(entry);
  }

  // ═══════════════════════════════════════════════════════════════
  // Fetch with 429 retry (exponential backoff)
  // ═══════════════════════════════════════════════════════════════

  async _fetchWithRetry(url, maxRetries = 3) {
    const delays = [1000, 2000, 4000];
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetch(url);
      if (res.status !== 429) return res;
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, delays[attempt] ?? 4000));
      }
    }
    return { ok: false, status: 429, statusText: 'Rate Limited' };
  }

  /**
   * @param {string} url
   * @param {string} purpose 何のためのTilequery呼び出しか（ログ表示用の人間可読ラベル）。
   */
  async _fetchTilequeryWithCache(url, purpose = '(未分類)') {
    const tilesetMatch = url.match(/\/v4\/([^/]+)\/tilequery/);
    const layersMatch = url.match(/[?&]layers=([^&]+)/);
    const radiusMatch = url.match(/[?&]radius=([^&]+)/);
    const coordMatch = url.match(/\/tilequery\/([-\d.]+),([-\d.]+)\.json/);
    const base = {
      api: 'tilequery',
      purpose,
      tileset: tilesetMatch?.[1] || null,
      layers: layersMatch ? decodeURIComponent(layersMatch[1]) : '(全レイヤー)',
      radius: radiusMatch ? Number(radiusMatch[1]) : null,
      lng: coordMatch ? Number(coordMatch[1]) : null,
      lat: coordMatch ? Number(coordMatch[2]) : null,
    };

    const cached = this._tqCache.get(url);
    if (cached) {
      this._tqCacheHits++;
      this._logApi({ ...base, cacheHit: true, resultCount: (cached.features || []).length, names: (cached.features || []).map(f => f.properties?.name).filter(Boolean).slice(0, 50) });
      return { ok: true, json: async () => cached };
    }
    if (this._tqRequests >= (this.config.TQ_MAX_PER_QUERY ?? 200)) {
      this._capHit.tq++;
      this._logApi({ ...base, capped: true, resultCount: 0, names: [] });
      return { ok: true, json: async () => ({ features: [] }) };
    }
    this._tqRequests++;
    const res = await this._fetchWithRetry(url);
    if (!res.ok) {
      this._logApi({ ...base, error: `HTTP ${res.status ?? '(不明)'}`, resultCount: 0, names: [] });
      return res;
    }
    const data = await res.json();
    this._tqCache.set(url, data);
    this._logApi({ ...base, cacheHit: false, resultCount: (data.features || []).length, names: (data.features || []).map(f => f.properties?.name).filter(Boolean).slice(0, 50) });
    return { ok: true, json: async () => data };
  }

  // ═══════════════════════════════════════════════════════════════
  // bbox helpers
  // ═══════════════════════════════════════════════════════════════

  /** Max distance (m) from (lng,lat) to any of bbox's 4 corners. Used to cap Tilequery's
   * radius when a user-set search bbox is active — Tilequery only takes a point+radius,
   * not a bbox, so the smallest circle that still fully covers the box (as seen from the
   * given point) is the closest equivalent. */
  _bboxMaxCornerDistanceM(lng, lat, bbox) {
    if (!bbox || bbox.length < 4 || lng == null || lat == null) return null;
    const [minX, minY, maxX, maxY] = bbox;
    const cosLat = Math.cos(lat * Math.PI / 180);
    const dist = (x, y) => Math.hypot((x - lng) * 111320 * cosLat, (y - lat) * 110540);
    return Math.max(dist(minX, minY), dist(minX, maxY), dist(maxX, minY), dist(maxX, maxY));
  }

  resolveBBox({ points = [], marginM = 0 }) {
    const lngs = [], lats = [];
    for (const p of points) {
      if (p.bbox) { lngs.push(p.bbox[0], p.bbox[2]); lats.push(p.bbox[1], p.bbox[3]); continue; }
      lngs.push(p.lng); lats.push(p.lat);
      if (p.radiusM) {
        const dLng = p.radiusM / (111320 * Math.cos(p.lat * Math.PI / 180));
        const dLat = p.radiusM / 110540;
        lngs.push(p.lng - dLng, p.lng + dLng);
        lats.push(p.lat - dLat, p.lat + dLat);
      }
    }
    if (lngs.length === 0) return [0, 0, 0, 0];
    let minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    let minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const cLng = (minLng + maxLng) / 2, cLat = (minLat + maxLat) / 2;
    const padM = Math.max(marginM, 150);
    const padLng = padM / (111320 * Math.cos(cLat * Math.PI / 180));
    const padLat = padM / 110540;
    return [Math.min(minLng, cLng - padLng), Math.min(minLat, cLat - padLat), Math.max(maxLng, cLng + padLng), Math.max(maxLat, cLat + padLat)];
  }

  // ═══════════════════════════════════════════════════════════════
  // Search Box API
  // ═══════════════════════════════════════════════════════════════

  /** Search Box forward-search feature mapper (Category Search endpoint retired — see _collectPOI). */
  static _mapSearchBoxFeatures(data) {
    return (data.features || []).map(f => {
      const p = f.properties || {};
      const c = p.coordinates || {};
      const ft = p.feature_type || null;
      const fullName = p.full_address || p.name || '';
      const bboxOut = ['place', 'locality', 'district'].includes(ft) ? (p.bbox || null) : null;
      const prefMatch = fullName.match(/([^\s〒0-9-]+?[都道府県])/);
      return {
        name: p.name || null,
        full_address: p.full_address || null,
        longitude: c.longitude, latitude: c.latitude,
        poi_category: p.poi_category || null,
        brand: p.brand || null,
        distance: p.distance ?? null,
        feature_type: ft,
        bbox: bboxOut,
        prefecture: prefMatch ? prefMatch[1] : null,
      };
    }).filter(f => f.longitude != null && f.latitude != null);
  }

  /** Search Box forward `limit` for a given tgt/cond specificity ('unique'|'brand'|
   * 'generic'/unset). Unique landmarks realistically have ~1 real match, brands have many
   * branches, generic categories need the widest net — see config.js comment. */
  _searchBoxLimitFor(specificity) {
    switch (specificity) {
      case 'unique': return this.config.SEARCHBOX_LIMIT_UNIQUE ?? 5;
      case 'brand':  return this.config.SEARCHBOX_LIMIT_BRAND ?? 20;
      default:       return this.config.SEARCHBOX_LIMIT_GENERIC ?? 30;
    }
  }

  // `bbox` (this._bbox, [minLng,minLat,maxLng,maxLat]) is only ever set by an explicit,
  // UI-controlled requestBody.bbox (see QueryEngine.run) — never auto-derived from a
  // locality/anchor. It's off by default: `proximity` (soft bias) still does all the work
  // when no bbox is set, and L2 relevance + distance-based scoring downstream still decide
  // "close enough" either way. This is a deliberately different feature from the old
  // auto-derived locality bbox that was removed (huge/skewed admin-boundary bbox, fixed
  // 800m near-radius excluding real targets) — see class header comment.
  async _searchBoxRequest(q, types, proximity, poiCategory = null, limit = 30) {
    let url =
      `${this.config.SEARCH_BOX_API}?q=${encodeURIComponent(q)}&access_token=${this.token}` +
      `&language=ja&country=jp&types=${types}&limit=${limit}`;
    if (poiCategory) url += `&poi_category=${encodeURIComponent(poiCategory)}`;
    if (proximity && proximity.length >= 2) url += `&proximity=${proximity[0]},${proximity[1]}`;
    if (this._bbox) url += `&bbox=${this._bbox.join(',')}`;

    if (this._sbRequests >= (this.config.SB_MAX_PER_QUERY ?? 100)) {
      this._capHit.sb++;
      this._logApi({ api: 'search_box_forward', q, types, poiCategory, proximity, bbox: this._bbox, limit, capped: true, resultCount: 0, names: [] });
      return [];
    }
    try {
      this._sbRequests++;
      const res = await this._fetchWithRetry(url);
      if (!res.ok) {
        this._logApi({ api: 'search_box_forward', q, types, poiCategory, proximity, bbox: this._bbox, limit, error: `HTTP ${res.status ?? '(不明)'}`, resultCount: 0, names: [] });
        return [];
      }
      const data = await res.json();
      const items = MapboxMCPClient._mapSearchBoxFeatures(data);
      this._logApi({ api: 'search_box_forward', q, types, poiCategory, proximity, bbox: this._bbox, limit, resultCount: items.length, names: items.map(f => f.name).slice(0, 50) });
      return items;
    } catch (e) {
      this._logApi({ api: 'search_box_forward', q, types, poiCategory, proximity, bbox: this._bbox, limit, error: e?.message || String(e), resultCount: 0, names: [] });
      return [];
    }
  }

  /** Search Box wrapper for QueryEngine (raw feature-array shape). */
  async searchBox(query, opts = {}) {
    const types = opts.types || 'poi,address,place,locality';
    const features = await this._searchBoxRequest(query, types, opts.proximity || null, null, opts.limit ?? 30);
    return {
      features: features.map(f => ({
        geometry: { coordinates: [f.longitude, f.latitude] },
        properties: {
          name: f.name, full_address: f.full_address, feature_type: f.feature_type,
          bbox: f.bbox, prefecture: f.prefecture || null, place_formatted: f.full_address,
        },
      })),
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // Name normalization / classification helpers (unchanged from geonator)
  // ═══════════════════════════════════════════════════════════════

  static _cleanName(name) { return name ? name.replace(/[​‌‍﻿]/g, '') : name; }

  static _kanjiToArabicInAddress(s) {
    const D = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    const parse = (k) => {
      let total = 0, cur = 0, seen = false;
      for (const ch of k) {
        if (D[ch] != null) { cur = D[ch]; seen = true; }
        else if (ch === '十') { total += (cur || 1) * 10; cur = 0; seen = true; }
        else if (ch === '百') { total += (cur || 1) * 100; cur = 0; seen = true; }
        else return null;
      }
      return seen ? total + cur : null;
    };
    return s.replace(/[〇零一二三四五六七八九十百]+(?=丁目|丁|番地|番|号|条)/g, (m) => {
      const n = parse(m);
      return n == null ? m : String(n);
    });
  }

  static _normalizeName(name) {
    if (!name) return '';
    let s = (MapboxMCPClient._cleanName(name) || '').normalize('NFKC');
    s = s.replace(/[ぁ-ゖ]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60));
    s = MapboxMCPClient._kanjiToArabicInAddress(s);
    s = s.replace(/[\s・‐-―−()\[\]「」【】\-]/g, '');
    return s.toLowerCase();
  }

  static ROAD_CLASS_RANK = {
    motorway: 1, motorway_link: 1, trunk: 2, trunk_link: 2, primary: 3, primary_link: 3,
    secondary: 4, secondary_link: 4, tertiary: 5, tertiary_link: 5, street: 6, street_limited: 6,
    pedestrian: 7, construction: 8, track: 9, service: 9, path: 10,
  };
  static NON_ROAD_CLASSES = new Set(['major_rail', 'minor_rail', 'service_rail', 'ferry', 'aerialway', 'golf']);
  static POINT_DATA_CLASSES = new Set(['junction', 'roundabout', 'mini_roundabout', 'turning_circle', 'turning_loop', 'traffic_signals', 'level_crossing', 'intersection']);

  static getRoadCategory(cls) {
    if (!cls) return null;
    if (MapboxMCPClient.ROAD_CLASS_RANK[cls] != null) return '道路系';
    if (MapboxMCPClient.NON_ROAD_CLASSES.has(cls)) return '線路・海路・その他';
    if (MapboxMCPClient.POINT_DATA_CLASSES.has(cls)) return 'ポイント（交差点・信号等）';
    return 'その他';
  }

  static BUS_STOP_KEYWORDS = ['バス停', 'バス停留所', '停留所', 'bus stop', 'bus_stop'];
  _isBusStopQuery(queries) {
    return queries.some(q => MapboxMCPClient.BUS_STOP_KEYWORDS.some(kw => q.toLowerCase().includes(kw.toLowerCase())));
  }

  static BUILDING_KEYWORDS = ['マンション', 'アパート', 'ビル', '邸', 'タワー', 'レジデンス', 'ハイツ', 'コーポ', 'テラス', '荘', '館', 'プレイス', 'コート', 'ガーデン', 'ヴィラ', 'パレス', 'ハウス'];
  _isBuildingQuery(queries) {
    return queries.some(q => MapboxMCPClient.BUILDING_KEYWORDS.some(kw => q.includes(kw)));
  }


  // ── category_tag resolution (決定的・JS辞書のみ) ──
  static _CATEGORY_SUBNAME_MAP = null;
  static _buildCategorySubnameMap() {
    const map = new Map();
    if (typeof CATEGORY_TAXONOMY === 'undefined') return map;
    for (const id of CATEGORY_TAXONOMY) {
      const sub = id.includes('>') ? id.split('>')[1] : id;
      if (!map.has(sub)) map.set(sub, []);
      map.get(sub).push(id);
    }
    return map;
  }

  _resolveCategoryTag(queries) {
    if (!this.config.useCategorySearch || !queries?.length) return null;
    if (typeof CATEGORY_TAXONOMY === 'undefined') return null;
    if (!MapboxMCPClient._CATEGORY_SUBNAME_MAP) {
      MapboxMCPClient._CATEGORY_SUBNAME_MAP = MapboxMCPClient._buildCategorySubnameMap();
    }
    const subMap = MapboxMCPClient._CATEGORY_SUBNAME_MAP;
    const candidates = new Set();
    for (const qRaw of queries) {
      const q = (qRaw || '').trim();
      if (!q) continue;
      if (subMap.has(q)) subMap.get(q).forEach(id => candidates.add(id));
      if (typeof CATEGORY_SYNONYMS !== 'undefined') {
        for (const id in CATEGORY_SYNONYMS) {
          if (CATEGORY_SYNONYMS[id].some(syn => q.includes(syn))) candidates.add(id);
        }
      }
    }
    if (candidates.size !== 1) return null;
    const id = [...candidates][0];
    // Mapbox's poi_category param expects a single category keyword, not our internal
    // taxonomy's "親>子" grouping id — send only the child segment (e.g. "レストラン>丼もの" → "丼もの").
    const idx = id.indexOf('>');
    return idx === -1 ? id : id.slice(idx + 1);
  }

  // ═══════════════════════════════════════════════════════════════
  // Single-shot Tilequery helpers (spec §5 — no grid)
  // ═══════════════════════════════════════════════════════════════

  /** Bus stop tileset (10da032y.busstop_gov_0608) — the sole bus-stop data source now (streets-v8 transit_stop_label variant retired), used identically for target and condition category_busstop. */
  async _busStopFallback(lat, lng, radius) {
    const url = `https://api.mapbox.com/v4/10da032y.busstop_gov_0608/tilequery/${lng},${lat}.json` +
      `?access_token=${this.token}&radius=${Math.round(radius)}&limit=${this.config.TILEQUERY_LIMIT}&dedupe=true`;
    try {
      const res = await this._fetchTilequeryWithCache(url, 'バス停検索(10da032y.busstop_gov_0608)');
      if (!res.ok) return [];
      const data = await res.json();
      return (data.features || [])
        .filter(f => f.properties?.name)
        .map(f => ({
          name: MapboxMCPClient._cleanName(f.properties.name),
          operator: f.properties.operator || null,
          longitude: f.geometry?.coordinates?.[0], latitude: f.geometry?.coordinates?.[1],
          distance: Math.round(f.properties?.tilequery?.distance || 0),
        }))
        .filter(f => f.longitude != null && f.latitude != null);
    } catch { return []; }
  }

  /** Named intersections (streets-v8 road layer, class=intersection). Single-shot (spec §5). */
  async _findIntersections(lat, lng, radius, nameFilter = null) {
    const url = `${this.config.TILEQUERY_API}/${lng},${lat}.json` +
      `?access_token=${this.token}&radius=${Math.round(radius)}&limit=${this.config.TILEQUERY_LIMIT}&dedupe=true&layers=road&geometry=point`;
    try {
      const res = await this._fetchTilequeryWithCache(url, '交差点検索(road layer, class=intersection)');
      if (!res.ok) return [];
      const data = await res.json();
      const center = turf.point([lng, lat]);
      let items = (data.features || [])
        .filter(f => f.properties?.class === 'intersection' && f.properties?.name)
        .map(f => {
          const lo = f.geometry?.coordinates?.[0], la = f.geometry?.coordinates?.[1];
          return { name: f.properties.name, longitude: lo, latitude: la, distance: turf.distance(center, turf.point([lo, la]), { units: 'meters' }) };
        })
        .filter(f => f.longitude != null && f.latitude != null);
      if (nameFilter) {
        const filter = MapboxMCPClient._normalizeName(nameFilter);
        items = items.filter(f => MapboxMCPClient._normalizeName(f.name).includes(filter));
      }
      return items.map(f => ({ ...f, distance: Math.round(f.distance) })).sort((a, b) => a.distance - b.distance);
    } catch { return []; }
  }

  /** Traffic signals (streets-v8 road layer, class=traffic_signals). Single-shot (spec §5). */
  async _findTrafficSignals(lat, lng, radius) {
    const url = `${this.config.TILEQUERY_API}/${lng},${lat}.json` +
      `?access_token=${this.token}&radius=${Math.round(radius)}&limit=${this.config.TILEQUERY_LIMIT}&dedupe=true&layers=road&geometry=point`;
    try {
      const res = await this._fetchTilequeryWithCache(url, '信号検索(road layer, class=traffic_signals)');
      if (!res.ok) return [];
      const data = await res.json();
      const center = turf.point([lng, lat]);
      return (data.features || [])
        .filter(f => f.properties?.class === 'traffic_signals')
        .map(f => {
          const lo = f.geometry?.coordinates?.[0], la = f.geometry?.coordinates?.[1];
          return { longitude: lo, latitude: la, distance: Math.round(turf.distance(center, turf.point([lo, la]), { units: 'meters' })) };
        })
        .filter(f => f.longitude != null && f.latitude != null)
        .sort((a, b) => a.distance - b.distance);
    } catch { return []; }
  }

  /** All transit entrances (stop_type=entrance) near a station coordinate — local lookup, not a candidate search (kept small radius). */
  async tilequeryTransitEntrances(lat, lng, radiusM = 500) {
    const url = `${this.config.TILEQUERY_API}/${lng},${lat}.json` +
      `?access_token=${this.token}&radius=${Math.min(radiusM, 500)}&limit=${this.config.TILEQUERY_LIMIT}&dedupe=true&layers=transit_stop_label`;
    try {
      const res = await this._fetchTilequeryWithCache(url, '駅出口検索(transit_stop_label, stop_type=entrance)');
      if (!res.ok) return [];
      const data = await res.json();
      return (data.features || [])
        .filter(f => (f.properties?.maki === 'entrance' || f.properties?.stop_type === 'entrance'))
        .map(f => ({ name: f.properties?.name || null, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }));
    } catch { return []; }
  }

  /** Named buildings (streets-v8 poi_label, class=building) — used for category_mansion/category_apartment/category_building targets. Single-shot (spec §5). */
  async _findBuildings(lat, lng, radius) {
    const url = `${this.config.TILEQUERY_API}/${lng},${lat}.json` +
      `?access_token=${this.token}&radius=${Math.round(radius)}&limit=${this.config.TILEQUERY_LIMIT}&dedupe=true&layers=poi_label`;
    try {
      const res = await this._fetchTilequeryWithCache(url, '建物検索(poi_label, class=building)');
      if (!res.ok) return [];
      const data = await res.json();
      return (data.features || [])
        .filter(f => f.properties?.name && f.properties?.class === 'building')
        .map(f => ({
          name: MapboxMCPClient._cleanName(f.properties.name),
          longitude: f.geometry?.coordinates?.[0],
          latitude: f.geometry?.coordinates?.[1],
          distance: Math.round(f.properties?.tilequery?.distance || 0),
        }))
        .filter(f => f.longitude != null && f.latitude != null)
        .sort((a, b) => (a.distance ?? 9e9) - (b.distance ?? 9e9));
    } catch { return []; }
  }

  async roadNear(lat, lng, radiusM, opts = {}) {
    const r = Math.min(Math.max(Math.ceil(radiusM), 30), 500);
    const url = `${this.config.TILEQUERY_API}/${lng},${lat}.json?access_token=${this.token}&radius=${r}&limit=${this.config.TILEQUERY_LIMIT}&dedupe=true&layers=road`;
    try {
      const res = await this._fetchTilequeryWithCache(url, '道路近接判定(road条件の距離評価)');
      if (!res.ok) return { matched: false, nearestM: null };
      const data = await res.json();
      const MAJOR = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link']);
      let best = null;
      for (const f of (data.features || [])) {
        const p = f.properties || {}, cls = p.class;
        if (!cls || MapboxMCPClient.NON_ROAD_CLASSES.has(cls)) continue;
        if (MapboxMCPClient.ROAD_CLASS_RANK[cls] == null) continue;
        if (opts.majorOnly && !MAJOR.has(cls)) continue;
        if (opts.name && !((p.name || '').includes(opts.name))) continue;
        const d = Math.round(p.tilequery?.distance ?? 9999);
        if (best === null || d < best) best = d;
      }
      return { matched: best !== null, nearestM: best };
    } catch { return { matched: false, nearestM: null }; }
  }

  async railNear(lat, lng, radiusM) {
    const r = Math.min(Math.max(Math.ceil(radiusM), 30), 500);
    const url = `${this.config.TILEQUERY_API}/${lng},${lat}.json?access_token=${this.token}&radius=${r}&limit=${this.config.TILEQUERY_LIMIT}&dedupe=true&layers=road`;
    try {
      const res = await this._fetchTilequeryWithCache(url, '線路近接判定(rail条件の距離評価)');
      if (!res.ok) return { matched: false, nearestM: null };
      const data = await res.json();
      let best = null;
      for (const f of (data.features || [])) {
        const cls = f.properties?.class;
        if (!cls || !/rail/.test(cls)) continue;
        const d = Math.round(f.properties?.tilequery?.distance ?? 9999);
        if (best === null || d < best) best = d;
      }
      return { matched: best !== null, nearestM: best };
    } catch { return { matched: false, nearestM: null }; }
  }

  async waterNear(lat, lng, radiusM) {
    const r = Math.min(Math.max(Math.ceil(radiusM), 30), 1000);
    const url = `${this.config.TILEQUERY_API}/${lng},${lat}.json?access_token=${this.token}&radius=${r}&limit=${this.config.TILEQUERY_LIMIT}&dedupe=true&layers=water,waterway`;
    try {
      const res = await this._fetchTilequeryWithCache(url, '水域近接判定(water条件の距離評価)');
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

  // ═══════════════════════════════════════════════════════════════
  // Isochrone / reach (unchanged from geonator)
  // ═══════════════════════════════════════════════════════════════

  async getIsochronePolygon(lat, lng, minutes, profile = 'walking') {
    const prof = ['walking', 'cycling', 'driving'].includes(profile) ? profile : 'walking';
    if (this._isoRequests >= (this.config.ISO_MAX_PER_QUERY ?? 100)) {
      this._capHit.iso++;
      this._logApi({ api: 'isochrone', purpose: 'proximity.within到達圏計算', profile: prof, minutes, lat, lng, capped: true });
      return null;
    }
    try {
      const url = `https://api.mapbox.com/isochrone/v1/mapbox/${prof}/${lng},${lat}?contours_minutes=${minutes}&polygons=true&access_token=${this.token}`;
      this._isoRequests++;
      const res = await this._fetchWithRetry(url);
      if (!res.ok) {
        this._logApi({ api: 'isochrone', purpose: 'proximity.within到達圏計算', profile: prof, minutes, lat, lng, error: `HTTP ${res.status ?? '(不明)'}` });
        return null;
      }
      const data = await res.json();
      const polygon = data.features?.[0] || null;
      this._logApi({ api: 'isochrone', purpose: 'proximity.within到達圏計算', profile: prof, minutes, lat, lng, found: !!polygon });
      return polygon;
    } catch (e) {
      this._logApi({ api: 'isochrone', purpose: 'proximity.within到達圏計算', profile: prof, minutes, lat, lng, error: e?.message || String(e) });
      return null;
    }
  }

  async isochroneReach(points, minutes, profile = 'walking', useIsochrone = true) {
    let polygons;
    if (!useIsochrone) {
      const radiusKm = (minutes * (REACH_SPEED_M_PER_MIN[profile] || REACH_SPEED_M_PER_MIN.walking)) / 1000;
      polygons = (points || []).filter(p => p && p.lng != null && p.lat != null)
        .map(p => turf.circle(turf.point([p.lng, p.lat]), radiusKm, { units: 'kilometers', steps: 32 }));
    } else {
      const polys = await Promise.all((points || []).map(p => this.getIsochronePolygon(p.lat, p.lng, minutes, profile)));
      polygons = polys.filter(Boolean);
    }
    if (!polygons.length) return { bbox: null, polygons: [] };
    let bb = turf.bbox(polygons[0]);
    for (let i = 1; i < polygons.length; i++) {
      const b = turf.bbox(polygons[i]);
      bb = [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])];
    }
    return { bbox: bb, polygons };
  }

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

  async computeWithinReach(point, spec, defaultBbox, useIsochrone = true) {
    const { minMinutes, maxMinutes, profile = 'walking' } = spec || {};
    if (!point || minMinutes == null) return null;
    const circleFor = (minutes) => {
      const radiusKm = (minutes * (REACH_SPEED_M_PER_MIN[profile] || REACH_SPEED_M_PER_MIN.walking)) / 1000;
      return turf.circle(turf.point([point.lng, point.lat]), radiusKm, { units: 'kilometers', steps: 32 });
    };
    const inner = useIsochrone ? await this.getIsochronePolygon(point.lat, point.lng, minMinutes, profile) : circleFor(minMinutes);
    if (!inner) return null;
    if (maxMinutes != null) {
      const outer = useIsochrone ? await this.getIsochronePolygon(point.lat, point.lng, maxMinutes, profile) : circleFor(maxMinutes);
      if (!outer) return null;
      return { bbox: turf.bbox(outer), hole: inner, outer, tooLarge: false };
    }
    const ib = turf.bbox(inner);
    const bw = defaultBbox ? Math.abs(defaultBbox[2] - defaultBbox[0]) : Infinity;
    if (defaultBbox && Math.abs(ib[2] - ib[0]) >= bw * 0.9) return { bbox: defaultBbox, hole: null, tooLarge: true };
    const cx = (ib[0] + ib[2]) / 2, cy = (ib[1] + ib[3]) / 2, f = 1.5;
    return { bbox: [cx - (cx - ib[0]) * f, cy - (cy - ib[1]) * f, cx + (ib[2] - cx) * f, cy + (ib[3] - cy) * f], hole: inner, tooLarge: false };
  }

  async _reachPolygon([lng, lat], distParams, isoCache) {
    if (!distParams.useIsochrone) {
      const radiusKm = (distParams.radiusM ?? 250) / 1000;
      return turf.circle(turf.point([lng, lat]), radiusKm, { units: 'kilometers', steps: 32 });
    }
    const prof = distParams.profile || 'walking';
    const mins = distParams.minutes;
    const cacheKey = `${lat},${lng},${mins},${prof}`;
    const cached = isoCache.get(cacheKey);
    if (cached) {
      this._isoCacheHits++;
      this._logApi({ api: 'isochrone', purpose: '候補↔条件間の距離評価(isochroneモード)', profile: prof, minutes: mins, lat, lng, cacheHit: true });
      return cached;
    }
    if (this._isoRequests >= (this.config.ISO_MAX_PER_QUERY ?? 100)) {
      this._capHit.iso++;
      this._logApi({ api: 'isochrone', purpose: '候補↔条件間の距離評価(isochroneモード)', profile: prof, minutes: mins, lat, lng, capped: true });
      return null;
    }
    const url = `https://api.mapbox.com/isochrone/v1/mapbox/${prof}/${lng},${lat}?contours_minutes=${mins}&polygons=true&access_token=${this.token}`;
    this._isoRequests++;
    try {
      const res = await this._fetchWithRetry(url);
      if (!res.ok) {
        this._logApi({ api: 'isochrone', purpose: '候補↔条件間の距離評価(isochroneモード)', profile: prof, minutes: mins, lat, lng, error: `HTTP ${res.status ?? '(不明)'}` });
        return null;
      }
      const data = await res.json();
      const polygon = data.features?.[0] || null;
      if (polygon) isoCache.set(cacheKey, polygon);
      this._logApi({ api: 'isochrone', purpose: '候補↔条件間の距離評価(isochroneモード)', profile: prof, minutes: mins, lat, lng, found: !!polygon });
      return polygon;
    } catch { return null; }
  }

  /** Evaluate ALL main candidates against a condition's items in one pass (unchanged from geonator). */
  async evaluateDistanceBatch(mainCandidates, conditionItems, distParams, isoCache = new Map(), direction = null) {
    const matches = new Map();
    if (!mainCandidates?.length || !conditionItems?.length || distParams.pushback) return { matches, debug: [] };

    const ll = (o) => [o.longitude ?? o.lng, o.latitude ?? o.lat];
    const dirOK = ([mLng, mLat], [iLng, iLat]) => {
      if (!direction) return true;
      switch (direction) {
        case 'north': return iLat > mLat;
        case 'south': return iLat < mLat;
        case 'east':  return iLng > mLng;
        case 'west':  return iLng < mLng;
        default: return true;
      }
    };
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

    const flip = conditionItems.length <= mainCandidates.length;
    const anchors = flip ? conditionItems : mainCandidates;
    const polyByKey = new Map();
    const anchorPolys = await Promise.all(anchors.map(a => {
      const ap = ll(a);
      if (ap[0] == null || ap[1] == null) return null;
      const key = `${ap[1]},${ap[0]}`;
      if (!polyByKey.has(key)) polyByKey.set(key, this._reachPolygon(ap, distParams, isoCache));
      return polyByKey.get(key);
    }));

    for (let ai = 0; ai < anchors.length; ai++) {
      const a = anchors[ai], ap = ll(a), poly = anchorPolys[ai];
      if (ap[0] == null || ap[1] == null || !poly) continue;
      this._evalPolygons.push(poly);
      if (flip) {
        for (const main of mainCandidates) {
          const mp = ll(main);
          if (mp[0] == null || mp[1] == null || !dirOK(mp, ap)) continue;
          if (turf.booleanPointInPolygon(turf.point(mp), poly)) {
            const nm = nearestFor(mp);
            const prev = matches.get(String(main.id));
            if (!matches.has(String(main.id)) || (nm != null && (prev == null || nm < prev))) matches.set(String(main.id), nm);
          }
        }
      } else {
        for (const c of conditionItems) {
          const ip = ll(c);
          if (ip[0] == null || ip[1] == null || !dirOK(ap, ip)) continue;
          if (turf.booleanPointInPolygon(turf.point(ip), poly)) { matches.set(String(a.id), nearestFor(ap)); break; }
        }
      }
    }

    // Debug-only: actual nearest distance for EVERY main candidate, matched or not (cheap —
    // nearestFor is pure turf.distance, no extra API calls). Lets the 処理ログ show *why*
    // a condition excluded someone (e.g. "73m, 圏外(閾値50m)") instead of just silently
    // dropping them, which was previously invisible and made real bugs (adjacent-radius too
    // tight for POI-centroid precision, etc.) hard to diagnose without guessing.
    const debug = mainCandidates.map(main => {
      const mp = ll(main);
      return { id: main.id, name: main.name, nearestM: (mp[0] != null && mp[1] != null) ? nearestFor(mp) : null };
    });
    return { matches, debug };
  }

  // ═══════════════════════════════════════════════════════════════
  // Candidate collection (spec §5 — single-shot, no grid)
  // ═══════════════════════════════════════════════════════════════

  _assignIds(items) {
    return items.map(item => ({ ...item, id: item.id ?? this._resultIdCounter++, lat: item.latitude, lng: item.longitude }));
  }

  /**
   * Core collection routine (replaces geonator's `_searchNearbyPOI`). Single-shot
   * Tilequery (spec §5) instead of grid sampling; bus-stop/intersection/signal/
   * transit-entrance special-cased layers are the same shape as geonator. category_tag
   * (when resolved) is passed as `poi_category` on the primary forward-search request
   * rather than a separate Category Search API call (retired — see below).
   *
   * @param {string[]} queries
   * @param {number[]|null} proximity - [lng, lat], the Search Box bias point AND the Tilequery center
   * @param {string|null} queryIntent
   * @param {Promise<string|null>|null} categoryTagPromise
   * @param {string|null} specificity - 'unique'|'brand'|'generic' (see _searchBoxLimitFor)
   * @param {string|null} textType - L1's own 'poi'|'place'|'ambiguous' self-report (schema
   *   text_type — see query-schema.js), used only by the general-POI branch below to pick
   *   Search Box's `types` param. Replaces the former classifyQueryType() regex heuristic:
   *   L1 already knows semantically whether e.g. "渋谷109" is a facility vs. an area, so
   *   re-guessing it from text-only suffix patterns was redundant and less accurate.
   *   'ambiguous' (default) preserves the old 'both' fallback (query both types).
   * @returns {Promise<Array>}
   */
  async _collectPOI(queries, proximity, queryIntent = null, categoryTagPromise = null, specificity = null, textType = null) {
    const effectiveProximity = proximity?.length >= 2 ? proximity : null;
    const sbLimit = this._searchBoxLimitFor(specificity);

    const cacheKey = `${queryIntent ?? 'auto'}|${textType ?? 'ambiguous'}|${queries.slice(0, 3).join(',')}|${effectiveProximity ? effectiveProximity.join(',') : 'noloc'}|${sbLimit}`;
    if (this._searchResultCache.has(cacheKey)) return this._searchResultCache.get(cacheKey);

    // Tilequery takes a point+radius, not a bbox, so a user-set search bbox caps the radius
    // to the farthest-corner distance from the proximity point — the smallest circle that
    // still fully covers the box.
    const configRadius = this.config.TILEQUERY_RADIUS_M ?? 50000;
    const bboxRadius = (this._bbox && effectiveProximity)
      ? this._bboxMaxCornerDistanceM(effectiveProximity[0], effectiveProximity[1], this._bbox)
      : null;
    const TQ_RADIUS = bboxRadius != null ? Math.min(configRadius, bboxRadius) : configRadius;
    const BUILDING_INTENTS = ['category_building', 'category_mansion', 'category_apartment'];

    // ── special layer-driven types (single-shot Tilequery only) ──
    if (queryIntent === 'intersection' && effectiveProximity) {
      const [lng, lat] = effectiveProximity;
      const items = await this._findIntersections(lat, lng, TQ_RADIUS, queries?.[0] || null);
      const out = this._assignIds(items);
      this._searchResultCache.set(cacheKey, out);
      return out;
    }
    if (queryIntent === 'signal' && effectiveProximity) {
      const [lng, lat] = effectiveProximity;
      const out = this._assignIds(await this._findTrafficSignals(lat, lng, TQ_RADIUS));
      this._searchResultCache.set(cacheKey, out);
      return out;
    }
    if (queryIntent === 'transit_entrance' && effectiveProximity) {
      const [lng, lat] = effectiveProximity;
      const entrances = await this.tilequeryTransitEntrances(lat, lng, 500);
      let q = (queries[0] || '').replace(/(出口|口)\s*$/, '').replace(/番\s*$/, '').trim();
      const norm = s => MapboxMCPClient._normalizeName(s);
      const nq = norm(q);
      let filtered = !nq ? entrances : entrances.filter(e => e.name && norm(e.name) === nq);
      if (nq && !filtered.length) filtered = entrances.filter(e => e.name && norm(e.name).includes(nq));
      let items = filtered.map(e => ({ name: e.name, latitude: e.lat, longitude: e.lng }));
      if (items.length === 0) items = [{ name: '(出口不明・駅代表地点)', latitude: lat, longitude: lng }];
      const out = this._assignIds(items);
      this._searchResultCache.set(cacheKey, out);
      return out;
    }
    const isBusStop = queryIntent === 'category_busstop' || (!queryIntent && this._isBusStopQuery(queries));
    if (isBusStop && effectiveProximity) {
      const [lng, lat] = effectiveProximity;
      const busStops = await this._busStopFallback(lat, lng, TQ_RADIUS);
      const seen = new Map();
      busStops.forEach(item => { if (!seen.has(item.name)) seen.set(item.name, item); });
      const out = this._assignIds([...seen.values()]);
      this._searchResultCache.set(cacheKey, out);
      return out;
    }
    const isBuilding = BUILDING_INTENTS.includes(queryIntent) || (!queryIntent && !isBusStop && this._isBuildingQuery(queries));
    if (isBuilding && effectiveProximity) {
      const [lng, lat] = effectiveProximity;
      const buildings = await this._findBuildings(lat, lng, TQ_RADIUS);
      const out = this._assignIds(buildings);
      this._searchResultCache.set(cacheKey, out);
      return out;
    }

    // ── general POI (and building/bus-stop targets with no proximity at all): Search Box only ──

    const _notBlocked = (name) => {
      if (!name || typeof POI_BLOCKLIST_FLAT === 'undefined') return true;
      const n = name.toLowerCase();
      return !POI_BLOCKLIST_FLAT.some(b => n.startsWith(b.toLowerCase()));
    };
    const dedupKey = item => `${MapboxMCPClient._normalizeName(item.name)}|${Math.round((item.longitude ?? 0) * 1000)}|${Math.round((item.latitude ?? 0) * 1000)}`;
    const seen = new Map();

    // Category Search API (separate endpoint, max limit=25) has been retired in favor of
    // passing poi_category directly on the forward-search call, keeping forward's higher
    // limit (up to 30) and avoiding a second parallel API call. NOTE: q + poi_category are
    // ANDed by the forward endpoint — if q's text doesn't match any indexed name/address in
    // the current proximity/bbox, poi_category can't rescue it even when true category
    // matches exist (e.g. "牛丼屋" q text failing to match "松屋"'s name). _resolveCategoryTag
    // also strips our taxonomy's "親>子" grouping down to just the child keyword, since that's
    // what Mapbox's poi_category value actually expects. Only attached to the primary query
    // (index 0, always the original tx per the QE-expansion rule) — attaching it to every
    // expanded synonym too would just resend the same category filter redundantly.
    const categoryTag = categoryTagPromise ? await Promise.resolve(categoryTagPromise).catch(() => null) : null;

    const sbRequests = queries.flatMap((q, i) => {
      const cat = i === 0 ? categoryTag : null;
      if (textType === 'place') return [this._searchBoxRequest(q, 'place,district,locality', effectiveProximity, null, sbLimit)];
      if (textType === 'poi')   return [this._searchBoxRequest(q, 'poi', effectiveProximity, cat, sbLimit)];
      // 'ambiguous' (or unset): L1 couldn't commit either way (e.g. "鎌倉" — a locality
      // name that could also be a same-named facility) — query both types, same safety
      // net the old classifyQueryType 'both' fallback provided.
      return [
        this._searchBoxRequest(q, 'poi', effectiveProximity, cat, sbLimit),
        this._searchBoxRequest(q, 'place,district,locality', effectiveProximity, null, sbLimit),
      ];
    });

    const sbResultArrays = await Promise.all(sbRequests);

    sbResultArrays.flat().forEach(item => {
      if (isBuilding && !_notBlocked(item.name)) return;
      const key = dedupKey(item);
      if (!seen.has(key)) seen.set(key, item);
    });

    const out = this._assignIds([...seen.values()].sort((a, b) => (a.distance ?? 9999) - (b.distance ?? 9999)));
    this._searchResultCache.set(cacheKey, out);
    return out;
  }

  /** Collect target candidates near a point. point=null → no location bias at all (spec §4.2 "no clue" path): plain text Search Box, Tilequery skipped. */
  async collectTarget(target, point, categoryTagPromise = null) {
    const proximity = point ? [point.lng, point.lat] : null;
    let queries = (target.queries?.length ? target.queries : [target.text]);
    const GENERIC_INTENTS = ['intersection', 'signal', 'transit_entrance', 'category_busstop'];
    if (GENERIC_INTENTS.includes(target.query_intent)) queries = queries.filter(q => !GENERIC_WORDS.includes(q.trim()));
    return this._collectPOI(queries, proximity, target.query_intent, categoryTagPromise, target.specificity, target.text_type);
  }

  /** Collect condition candidates near a point. condition.type and target.query_intent now share the same vocabulary (poi/intersection/signal/transit_entrance/category_busstop), so it's passed straight through as the queryIntent. */
  async collectCondition(condition, point, categoryTagPromise = null) {
    const proximity = point ? [point.lng, point.lat] : null;
    let text = condition.text || null;
    if (text && GENERIC_WORDS.includes(text.trim())) text = null;
    let queries;
    if (condition.type === 'poi' && condition.queries?.length) {
      queries = condition.queries.filter(q => !GENERIC_WORDS.includes(q.trim()));
    } else {
      queries = text ? [text] : [];
    }
    return this._collectPOI(queries, proximity, condition.type, condition.type === 'poi' ? categoryTagPromise : null, condition.specificity, condition.text_type);
  }
}
