/**
 * QueryEngine (geonator_lite) — headless, one-shot POI search pipeline.
 *
 * Forked from geonator/modules/query-engine.js (3047 lines), stripped down to the
 * single-shot pipeline in IMPLEMENTATION_SPEC.md §3:
 *   L1 parse → collect candidates (single-shot Search Box + Tilequery, §5) →
 *   unified L2 (§6) → optional dedup → score/rank (§7) → return.
 *
 * Everything tied to L0 conversation management, choice panels / "did you mean" /
 * homonym-disambiguation dialogs, the refine loop, interpretations, tier labels,
 * and the broad-proximity LLM-suggestion narrowing flow has been deleted (spec §2).
 * Because there is no UI to ask the user a clarifying question, every place that
 * used to show a choice panel now picks deterministically (documented inline) —
 * see the final implementation report for the full list of judgment calls.
 *
 * Public entry point: `searchPOI(requestBody)` (spec §7.2/§7.3/§8).
 */

const LINE_COND_TYPES = new Set(['road', 'water', 'rail']);
const isLineCond = (type) => LINE_COND_TYPES.has(type);

// Target intents backed by a single deterministic Tilequery layer (proximity present):
// the collection itself already guarantees category+identity correctness, so L2 adds
// no value as a *target* filter. (As poi *conditions* these already skip L2 — only
// c.type === 'poi' conditions are rated — so this only needs handling on the target side.)
const SKIP_L2_TARGET_INTENTS = new Set(['transit_entrance', 'intersection', 'signal', 'category_busstop']);

// Building targets: Tilequery's building layer has no mansion/apartment/office
// distinction (`class` is always 'building'), so the category-domain half of L2 is
// dead weight for these — only the name-relevance half does real work.
const BUILDING_TARGET_INTENTS = new Set(['category_mansion', 'category_apartment', 'category_building']);

class QueryEngine {
  constructor({ mcp, llm, config }) {
    this.mcp = mcp;
    this.llm = llm;
    this.config = config;
  }

  _pnow() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

  // ─────────────────────────────────────────────
  // Entry point
  // ─────────────────────────────────────────────

  /**
   * @param {{text:string, proximity?:{lat,lng}, bbox?:[number,number,number,number], model?:string, judge?:object}} requestBody
   * @returns {Promise<{results:Array, meta:object}>}
   */
  async run(requestBody, t0) {
    // Debug log (spec: user-facing "処理ログ" modal) — L1 output, resolved QuerySchema,
    // per-group collection→L2 stage trace (hit vs. thinned-out POIs), and every individual
    // Mapbox API call (mcp._apiLog). ON/OFF via requestBody.debugLog (config.DEBUG_LOG) —
    // when off, this._log stays null and _logStage/_rateGroup/mcp._logApi are all no-ops.
    this._log = this.config.DEBUG_LOG ? { rawL1: null, schema: null, stages: [] } : null;

    // Optional user-set search bbox (UI-controlled, off by default — see MapboxMCPClient's
    // _bbox comment for why this doesn't reintroduce the old auto-derived bbox bugs). Used
    // as-is for Search Box/Category Search's `bbox` param, and as a radius cap for the
    // Tilequery-only collection paths. requestBody.bbox === 'auto' is a sentinel: the real
    // bbox can't be known yet (it depends on the parsed schema's proximity.within), so it's
    // resolved below once proximity is worked out.
    const bboxIsAuto = requestBody?.bbox === 'auto';
    this.mcp._bbox = (!bboxIsAuto && Array.isArray(requestBody?.bbox) && requestBody.bbox.length === 4) ? requestBody.bbox : null;

    const text = (requestBody?.text || '').trim();
    if (!text) return this._empty(t0, 0);

    let raw;
    try {
      raw = await this.llm.parseQuery(text);
    } catch (e) {
      // L1 failure → no crash, just a hitless result (spec §4.2 treats "no clue" as 0 results,
      // and a parse failure is functionally the same from the caller's point of view).
      return this._empty(t0, 0, { error: e?.message || String(e) });
    }
    if (this._log) this._log.rawL1 = raw;

    const schema = expandShortKeys(raw);
    fillSchemaDefaults(schema, this.config.DEFAULT_LEVEL, this.config.MAX_CONDITIONS);
    if (this._log) this._log.schema = schema;
    if (!schema.target || !schema.target.text) return this._empty(t0, 0);

    // ── proximity resolution (spec §4.2) ──
    const proxResult = await this._resolveProximity(schema, requestBody);
    if (proxResult.anchorNotFound) return this._empty(t0, 0); // explicit anchor didn't resolve → 0 hits, not an error

    const targetPoint = proxResult.point;
    this._anchorPoint = targetPoint;
    this._anchorRefM = proxResult.radiusM ? Math.max(1, proxResult.radiusM) : null;
    this._reachPolygons = proxResult.reachPolygons || null;
    this._reachHole = proxResult.reachHole || null;
    // 'auto' bbox: see _finalizeProximity for how it's derived (within/scope/multi-anchor).
    if (bboxIsAuto) this.mcp._bbox = proxResult.autoBbox || null;

    // ── collect candidates (spec §5) ──
    const { main, conditions } = await this._collectCandidates(schema, { targetPoint });

    // ── score/rank (spec §7.1) ──
    const scored = await this._evaluate(schema, main, conditions);

    // Precision-over-recall: drop low-confidence padding rather than show it ranked last.
    // Applied after scoring/sorting so rank numbering below is still contiguous from #1.
    // Judges on qualScore (relevance+condition, no anchor), same reasoning as
    // _keepOutliersOnly: anchorScore is a smooth distance preference, not evidence of
    // whether a candidate qualifies at all. Thresholding on the anchor-inclusive `score`
    // would silently drop a "definitely" match just for being a bit farther from the
    // anchor than an ambiguous "近く" guess allows — a real category match shouldn't be
    // cut for that. `score` (with anchor) still drives the display rank/order below.
    const minScore = this.config.SCORE_MIN_THRESHOLD ?? 0;
    let filtered = minScore > 0 ? scored.filter(c => (c._matchInfo?.qualScore ?? c._matchInfo?.score ?? 0) >= minScore) : scored;

    // If the survivors include a clear statistical standout, show only that (those).
    filtered = this._keepOutliersOnly(filtered);

    const results = filtered.map((c, i) => ({
      rank: i + 1,
      name: c.name || null,
      lat: c.latitude ?? c.lat ?? null,
      lng: c.longitude ?? c.lng ?? null,
      score: c._matchInfo?.score ?? 0,
      poi_category: Array.isArray(c.poi_category) ? c.poi_category : (c.cls ? [c.cls] : []),
    }));

    return {
      results,
      meta: {
        candidateCount: main.length,
        elapsedMs: Math.round(this._pnow() - t0),
        usage: this._usageMeta(),
        log: this._finalLog(),
        usedBbox: this.mcp._bbox || null, // actual bbox used this run (esp. for bbox:'auto' — client can't know it in advance)
      },
    };
  }

  _empty(t0, candidateCount, extra = {}) {
    return { results: [], meta: { candidateCount, elapsedMs: Math.round(this._pnow() - t0), usage: this._usageMeta(), log: this._finalLog(), ...extra } };
  }

  /** Median of an array (mutates nothing; caller passes an already- or not-yet-sorted array). */
  _median(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    const n = sorted.length;
    return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  }

  /**
   * If the top-scoring candidate(s) are a clear statistical outlier from the rest, keep
   * only those and drop the pack — a lopsided win shouldn't be diluted by a "top 10"-style
   * list. Uses the modified Z-score (median + MAD, Iglewicz & Hoaglin 1993) rather than
   * mean/stdev: with a handful of candidates, a raw z-score is distorted by the very
   * outlier it's trying to measure (masking), while median/MAD are robust to that.
   * No-op (returns input unchanged) below OUTLIER_MIN_N candidates (MAD isn't meaningful
   * on a tiny sample) or when MAD≈0 (everyone's already about equally close — no standout
   * to isolate).
   *
   * Judges on `qualScore` (relevance+condition, no anchor), not the display `score`.
   * anchorScore is a smooth, city-block-to-km-scale distance preference — with real
   * candidates, someone is always a bit closer to the station, so it manufactures spread
   * even when everyone equally satisfies what was actually asked (e.g. "X駅から徒歩5分以内
   * のホテル": once inside the 5-min reach polygon, every survivor equally satisfies that
   * stated constraint — ranking them further by raw distance and then calling the closest
   * one a "statistical outlier" would wrongly collapse a legitimate multi-result list down
   * to one). qualScore leaves conditions in (their radii are typically tight — adjacent/
   * very_close — so continuous closeness there genuinely separates "matches the specific
   * description" from "doesn't", e.g. "X駅前の牛丼屋の横のセブン" correctly narrows to one).
   */
  _keepOutliersOnly(sortedByScoreDesc) {
    const minN = this.config.OUTLIER_MIN_N ?? 4;
    if (!sortedByScoreDesc || sortedByScoreDesc.length < minN) return sortedByScoreDesc;
    const zThreshold = this.config.OUTLIER_Z_THRESHOLD ?? 3.5;
    const scores = sortedByScoreDesc.map(c => c._matchInfo?.qualScore ?? c._matchInfo?.score ?? 0);
    const median = this._median(scores);
    const mad = this._median(scores.map(s => Math.abs(s - median)));
    const outliers = sortedByScoreDesc.filter(c => {
      const q = c._matchInfo?.qualScore ?? c._matchInfo?.score ?? 0;
      if (mad < 1e-9) {
        // MAD=0 means the "typical" spread within the pack is exactly zero (a large tied
        // cluster) — the modified Z-score is undefined (divide by zero) here, but that's
        // the OPPOSITE of "no outlier": any real deviation from a zero-spread pack is
        // maximally significant, not evidence there's nothing to isolate. This is exactly
        // the common real case (most candidates fail a condition identically at 0, one
        // candidate genuinely satisfies it) — bailing out here previously suppressed the
        // single most important case this feature exists for. Fall back to a plain gap
        // check instead of z-score — but signed, not absolute: we're isolating a standout
        // that's BETTER than the pack (e.g. one candidate that actually satisfies a tight
        // condition the rest miss entirely), not just "different". Using abs() here
        // previously misfired on the mirror case (most candidates "definitely" match, a
        // handful only "probably" match) — it flagged the weaker minority as the "outlier"
        // and discarded the good majority, backwards from the intent.
        const gapThreshold = this.config.OUTLIER_MAD_ZERO_GAP ?? 0.05;
        return (q - median) > gapThreshold;
      }
      const z = 0.6745 * (q - median) / mad;
      return z > zThreshold;
    });
    // If everyone (or no one) ends up flagged, there's nothing meaningful to isolate.
    if (outliers.length === 0 || outliers.length === sortedByScoreDesc.length) return sortedByScoreDesc;
    return outliers;
  }

  /** Merge L1/L2 stage log with the raw per-API-call trace (mcp._apiLog) into one payload for the 処理ログ modal. null when logging is off. */
  _finalLog() {
    if (!this._log) return null;
    return { ...this._log, apiCalls: this.mcp._apiLog || [] };
  }

  /**
   * Token + Mapbox API call usage for this run (spec has no Matrix API usage — not called
   * by geonator_lite). Timing is reported only as the overall `elapsedMs` (wall-clock,
   * request → response for the whole searchPOI() call) — no per-role (L1/L2) time breakdown.
   */
  _usageMeta() {
    const cleanRole = ({ model, inTok, outTok, cacheRead, cacheWrite, calls }) =>
      ({ model, inTok, outTok, cacheRead, cacheWrite, calls });
    return {
      tokens: { L1: cleanRole(this.llm.stats.L1), L2: cleanRole(this.llm.stats.L2) },
      mapbox: {
        searchBox:  this.mcp._sbRequests  ?? 0,
        tilequery:  this.mcp._tqRequests  ?? 0,
        isochrone:  this.mcp._isoRequests ?? 0,
        matrix:     0, // Matrix API is not used by geonator_lite (see IMPLEMENTATION_SPEC.md — anchorScore uses straight-line distance only)
      },
    };
  }

  _bboxWidthM(bbox) {
    if (!bbox) return 0;
    const cy = (bbox[1] + bbox[3]) / 2;
    return Math.round(Math.abs(bbox[2] - bbox[0]) * 111320 * Math.cos(cy * Math.PI / 180));
  }

  _pointInBbox(coord, bbox) {
    if (!coord || !bbox) return false;
    return coord[0] >= bbox[0] && coord[0] <= bbox[2] && coord[1] >= bbox[1] && coord[1] <= bbox[3];
  }

  /** Expand a bbox outward by `marginM` meters on every side (scope-boundary slack — see
   * _filterByScope: a scope bbox is never an exact physical boundary, whether it's a
   * synthetic point+radius square (station/poi scope) or Mapbox's own rectangular
   * approximation of an irregular administrative polygon (locality scope), so a candidate
   * just outside it by a small margin can still be a legitimate in-scope match). */
  _expandBbox(bbox, marginM) {
    const cy = (bbox[1] + bbox[3]) / 2;
    const dLng = marginM / (111320 * Math.cos(cy * Math.PI / 180));
    const dLat = marginM / 110540;
    return [bbox[0] - dLng, bbox[1] - dLat, bbox[2] + dLng, bbox[3] + dLat];
  }

  /**
   * Filter candidate features to those within a scope bbox, with a fixed-distance slack
   * (config.NEAR_POI_M — this app's own definition of "close enough to count as near
   * something", reused here rather than inventing a new threshold) for boundary
   * approximation error. Unlike the old behavior, an empty result here is NOT papered
   * over by falling back to the full unfiltered candidate list — a scope the user
   * explicitly stated (e.g. "新橋駅の") is a strong signal, and silently ignoring it to
   * grab the closest text match from anywhere in Japan produces a confidently WRONG
   * anchor point (not just a missed one), which then contaminates every downstream
   * distance/score against that wrong point — worse than returning 0 hits (spec:
   * precision over recall — see [[project_geonator_lite_precision_over_recall]]).
   * Returns [] when nothing qualifies even with slack — callers must treat that as
   * "scope-constrained anchor unresolved", not "fall through to unrestricted feats".
   */
  _filterByScope(feats, scopeBbox) {
    if (!scopeBbox) return feats;
    const inScope = feats.filter(f => this._pointInBbox(f.geometry?.coordinates, scopeBbox));
    if (inScope.length) return inScope;
    const slackBbox = this._expandBbox(scopeBbox, this.config.NEAR_POI_M ?? 400);
    return feats.filter(f => this._pointInBbox(f.geometry?.coordinates, slackBbox));
  }

  // ─────────────────────────────────────────────
  // Proximity resolution (spec §4.2) — simplified: no clarify/choice dialogs
  // (deterministic best-match picks instead), no LLM world-knowledge place
  // interpretation (removed per spec §9), no broad-area narrowing flow (no UI
  // to narrow with, see _resolveAnchor*). No hard bbox pre-filter is ever applied
  // to Search Box/Category Search calls — only a soft `proximity` bias point is
  // resolved here; how "close" is close enough is decided downstream by L2
  // relevance + distance-based scoring (and, for `within`, real reach-polygon
  // filtering), not by pre-cutting the search area (see _finalizeProximity).
  // ─────────────────────────────────────────────

  async _resolveProximity(schema, requestBody) {
    const anchors = schema.proximity?.anchors || [];

    let scopeBbox = null;
    if (schema.proximity?.scope?.text) {
      scopeBbox = await this._resolveScopeBbox(schema.proximity.scope);
    }

    if (anchors.length) {
      let resolvedPoints = [];
      for (const anchor of anchors) {
        const points = await this._resolveAnchor(anchor, scopeBbox, requestBody?.proximity);
        if (!points || points.length === 0) return { point: null, anchorNotFound: true };
        resolvedPoints.push(...points);
      }
      // scopeBbox's job (disambiguating *which* anchor instance is meant — see
      // _resolveAnchor/_filterByScope) is already done by this point. Passing it through
      // to _finalizeProximity here would additionally intersect the final search-area bbox
      // with the scope's own box — geometrically that's two independently-centered squares
      // (anchor's own point+radius vs. the outer landmark's), which generically produces a
      // skewed/non-square (sometimes near-degenerate) rectangle centered on neither point,
      // not a tighter version of "near the anchor". The search area should stay centered on
      // the anchor alone, same as an anchor with no scope at all.
      return this._finalizeProximity(schema, resolvedPoints, null);
    }

    // scope alone, no anchor at all (e.g. "藍住町のショッピングモール" — a plain "POI
    // within this administrative area" query with no other landmark). Previously scopeBbox
    // was only ever used to narrow an *anchor's* resolution, so a scope-only query fell
    // straight through to the requestBody.proximity/no-bias paths below and the resolved
    // area was silently never used as the actual search center. An explicit textual place
    // mention should take priority over the ambient requestBody.proximity (map click) —
    // same principle anchors already follow.
    if (scopeBbox) {
      const p = {
        lng: (scopeBbox[0] + scopeBbox[2]) / 2,
        lat: (scopeBbox[1] + scopeBbox[3]) / 2,
        radiusM: this.config.NEAR_LOCALITY_M,
      };
      return this._finalizeProximity(schema, [p], scopeBbox);
    }

    // No anchor detected by L1. Spec §4.2 fallback:
    if (requestBody?.proximity && Number.isFinite(requestBody.proximity.lat) && Number.isFinite(requestBody.proximity.lng)) {
      const p = { lng: requestBody.proximity.lng, lat: requestBody.proximity.lat, radiusM: this.config.NEAR_POI_M };
      return this._finalizeProximity(schema, [p], scopeBbox);
    }

    // Neither an anchor nor a request proximity → search without bias, no Tilequery
    // (Tilequery needs a center point; spec §4.2 says skip it rather than error).
    return { point: null };
  }

  /** Intersect two bboxes (tighter of both). Falls back to `a` if they don't overlap at
   * all (rather than returning an empty/invalid box that would guarantee 0 results) —
   * that's a sign of conflicting signals, and the more directly query-relevant one should
   * win rather than break the search entirely. */
  _intersectBbox(a, b) {
    if (!a) return b;
    if (!b) return a;
    const out = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
    if (out[0] > out[2] || out[1] > out[3]) return a;
    return out;
  }

  /** Apply proximity.within (reach), resolve the search-bias point + scoring radius, and record the bearing_filter for a post-collection filter (spec §4.2). */
  async _finalizeProximity(schema, resolvedPoints, scopeBbox = null) {
    const within = schema.proximity?.within || null;
    const level = within?.level ?? null;
    const minMin = within?.minMinutes ?? null;
    const maxMin = within?.maxMinutes ?? within?.minutes ?? null;
    const maxMet = within?.maxMeters ?? within?.meters ?? null;
    const prof = within?.profile || 'walking';
    let radiusM = null, reachPolygons = null, reachHole = null, reachBbox = null;

    if (level) {
      radiusM = DISTANCE_TABLE[level]?.radius_m ?? null;
    } else if (minMin != null) {
      // defaultBbox here is purely internal isochrone-shape math (computeWithinReach's
      // own "is the reach polygon implausibly large" check) — not a search-restriction bbox.
      const defaultBbox = this.mcp.resolveBBox({ points: resolvedPoints });
      const reach = await this.mcp.computeWithinReach(resolvedPoints[0], { minMinutes: minMin, maxMinutes: maxMin, profile: prof }, defaultBbox, this.config.useIsochrone !== false);
      if (reach) {
        reachHole = reach.hole;
        if (reach.outer) reachPolygons = [reach.outer];
        if (reach.bbox) { radiusM = this._bboxWidthM(reach.bbox) / 2; reachBbox = reach.bbox; } // scoring reference + auto-bbox source
      }
    } else if (maxMin != null) {
      const reach = await this.mcp.isochroneReach(resolvedPoints, maxMin, prof, this.config.useIsochrone !== false);
      if (reach.bbox) {
        reachPolygons = reach.polygons;
        radiusM = this._bboxWidthM(reach.bbox) / 2; // scoring reference + auto-bbox source
        reachBbox = reach.bbox;
      } else {
        const SPEED = { walking: 80, cycling: 250, driving: 500 };
        radiusM = maxMin * (SPEED[prof] || SPEED.walking);
      }
    } else if (maxMet != null) {
      radiusM = maxMet;
    } else {
      // ambiguous "近く" (no explicit within) — near-extent depends on anchor type.
      // This is a scoring reference only now, never a hard search cutoff. A scope-only
      // resolution (no anchor at all — see _resolveProximity's scope-only fallback) is
      // itself a named area, so treat it as locality-scale rather than falling through to
      // the generic POI default (schema.proximity.anchors is empty in that case, so
      // _nearExtentForType would otherwise silently pick the wrong constant).
      radiusM = (!schema.proximity?.anchors?.length && schema.proximity?.scope?.text)
        ? (this.config.NEAR_LOCALITY_M ?? 800)
        : this._nearExtentForType(schema.proximity?.anchors?.[0]?.type);
    }

    // Merge to a single search-bias point (no bbox). For "AとBの間" (2 anchors), the
    // midpoint of both is a reasonable single center; the reach-polygon filtering above
    // (when `within` uses isochrone) still applies real per-candidate precision downstream.
    const point = resolvedPoints.length > 1
      ? {
          lng: resolvedPoints.reduce((s, p) => s + p.lng, 0) / resolvedPoints.length,
          lat: resolvedPoints.reduce((s, p) => s + p.lat, 0) / resolvedPoints.length,
        }
      : { lng: resolvedPoints[0].lng, lat: resolvedPoints[0].lat };

    // Auto-bbox source (bbox:'auto' — see run()). Unlike a hard radius cutoff, a bbox can
    // afford to be generous — it only keeps Search Box/Category Search's own return `limit`
    // from being spent on candidates from a much larger area, while L2 relevance + real
    // distance-based scoring downstream still decide "close enough". So, unlike the old
    // auto-derived locality bbox that motivated removing bbox entirely, we now compute one
    // even for the ambiguous "近く" fallback — just with extra (2x) padding there specifically,
    // since that radius is a guess rather than something the user actually stated.
    let autoBbox = reachBbox
      ? this.mcp.resolveBBox({ points: [{ bbox: reachBbox }] })
      : (radiusM != null
          ? this.mcp.resolveBBox({ points: [{ lng: point.lng, lat: point.lat, radiusM: within ? radiusM : radiusM * 2 }] })
          : null);

    // "AとBの間" (2+ anchors): the phrasing itself implies a bounded area even without an
    // explicit within, so also bound by the union of all anchor points (generous padding).
    if (resolvedPoints.length > 1) {
      const unionBbox = this.mcp.resolveBBox({ points: resolvedPoints, marginM: 300 });
      autoBbox = this._intersectBbox(autoBbox, unionBbox);
    }

    // scope（行政区域指定、例:「鎌倉市の」）: only reaches here when there's no anchor at
    // all (the scope-only fallback in _resolveProximity — e.g. "藍住町のショッピングモール").
    // There, scopeBbox *is* the stated search area, so narrowing to it is correct. When an
    // anchor exists, _resolveProximity passes scopeBbox=null here on purpose — see its
    // comment: scope's job was just disambiguating which anchor instance was meant, already
    // done during anchor resolution, and intersecting the anchor's own box with the outer
    // landmark's box here would just distort the search area around neither point.
    if (scopeBbox) autoBbox = this._intersectBbox(autoBbox, scopeBbox);

    return { point, radiusM, reachPolygons, reachHole, autoBbox };
  }

  _nearExtentForType(type) {
    switch (type) {
      case 'station': return this.config.NEAR_STATION_M ?? 600;
      case 'locality': return this.config.NEAR_LOCALITY_M ?? 800;
      default: return this.config.NEAR_POI_M ?? 400;
    }
  }

  /** Post-collection directional filter (replaces the old bbox-half-cut — same north/south/east/west test, applied to real candidate coordinates instead of pre-cutting the search area). */
  _applyBearingFilter(candidates, anchorPoint, direction) {
    if (!direction || !anchorPoint) return candidates;
    return candidates.filter(c => {
      const lat = c.latitude ?? c.lat, lng = c.longitude ?? c.lng;
      if (lat == null || lng == null) return true; // fail-open: can't judge, keep it
      switch (direction) {
        case 'north': return lat >= anchorPoint.lat;
        case 'south': return lat <= anchorPoint.lat;
        case 'east':  return lng >= anchorPoint.lng;
        case 'west':  return lng <= anchorPoint.lng;
        default: return true;
      }
    });
  }

  async _resolveScopeBbox(scope) {
    // scope.type === 'station'/'poi' handles the "[outer landmark]の[specific POI]の[近接語]
    // の[target]" pattern (e.g. "新丸子駅のドミノピザの横のマンション" → anc=ドミノピザ,
    // sc={station:新丸子駅}; "沖縄県庁近くのニッポンレンタカーから歩いてすぐのホテル" →
    // anc=ニッポンレンタカー, sc={poi:沖縄県庁}): the outer landmark is never the anchor here,
    // just a proximity hint for resolving *which* instance/branch of the inner POI is meant —
    // Search Box can't reliably find it via a single combined text query, so the outer landmark
    // must be resolved to a point first and used as a proximity bias when searching the inner
    // POI (same mechanism _resolvePoiOrAddress already uses for scopeBbox generally). Stations
    // and standalone landmarks are 'poi' features, not place/locality/district, so they need
    // broader types than the admin-area case.
    const isPointType = scope.type === 'station' || scope.type === 'poi';
    const types = isPointType ? 'poi,address,place' : 'place,locality,neighborhood,district,address';
    const sb = await this.mcp.searchBox(scope.text, { types });
    const feats = sb?.features || [];
    if (!feats.length) return null;
    const q = MapboxMCPClient._normalizeName(scope.text);
    const f = feats.find(x => MapboxMCPClient._normalizeName(x.properties?.name) === q) || feats[0];
    const bbox = f.properties?.bbox;
    if (bbox) return bbox;
    const [lng, lat] = f.geometry.coordinates;
    // Admin areas (place/locality/etc.) fall back to a generous 5km square when Mapbox gives
    // no bbox of its own. A station/landmark is a point, not a region, so a much tighter radius
    // makes more sense — callers apply their own boundary slack on top of this (_filterByScope),
    // so this radius doesn't need to itself be overly generous.
    const r = isPointType ? (this.config.NEAR_STATION_M ?? 600) : 5000;
    const dLng = r / (111320 * Math.cos(lat * Math.PI / 180)), dLat = r / 110540;
    return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
  }

  /**
   * Resolve one proximity anchor to point(s). No clarify/choice dialogs (spec has
   * no UI): ambiguous matches deterministically pick the exact-name match if there
   * is exactly one, else the Search Box top result (ML-ranked, so "first" is a
   * reasonable deterministic choice — this is a JUDGMENT CALL vs. geonator's
   * interactive homonym disambiguation; see final report).
   */
  async _resolveAnchor(anchor, scopeBbox, requestProximity) {
    switch (anchor.type) {
      case 'station': return this._resolveStation(anchor);
      case 'locality':
      case 'address': return this._resolveLocality(anchor, scopeBbox);
      case 'intersection': return this._resolveIntersectionAnchor(anchor);
      case 'poi': return this._resolvePoiOrAddress(anchor, scopeBbox, requestProximity);
      default: return null;
    }
  }

  _pickBest(feats, text) {
    const q = MapboxMCPClient._normalizeName(text);
    const exact = feats.filter(f => MapboxMCPClient._normalizeName(f.properties?.name) === q);
    return (exact.length ? exact : feats)[0];
  }

  // Always resolve to Mapbox's own representative point (feature.geometry.coordinates),
  // never the feature's administrative bbox — large/irregularly-shaped localities (e.g.
  // 京都市, which annexes far-north mountain wards) have a bbox whose geometric center can
  // land many km from the actual downtown area the query means. Mapbox's own point is a
  // proper "center of the place" (accuracy=proximate), unlike a bbox midpoint. A bbox-only
  // point also silently breaks the within/isochrone branches downstream, which need
  // point.lng/lat (this is NOT the same as `scope`/sc, which legitimately wants the full
  // administrative area and has its own bbox resolution in _resolveScopeBbox).
  _featureToPoint(feature) {
    const [lng, lat] = feature.geometry.coordinates;
    return { lng, lat, radiusM: this.config.NEAR_LOCALITY_M ?? 800 };
  }

  async _resolveStation(anchor) {
    const sb = await this.mcp.searchBox(anchor.text, { types: 'poi,address,place' });
    const feats = sb?.features || [];
    if (!feats.length) return null;
    const chosen = this._pickBest(feats, anchor.text);
    const stationCoord = chosen.geometry.coordinates;

    const exitName = anchor.subtype?.exit;
    if (exitName) {
      const entrances = await this.mcp.tilequeryTransitEntrances(stationCoord[1], stationCoord[0], 250);
      const matched = entrances.find(e => e.name && e.name.includes(exitName));
      if (matched) return [{ lng: matched.lng, lat: matched.lat, radiusM: DISTANCE_TABLE.nearby.radius_m }];
    }
    return [{ lng: stationCoord[0], lat: stationCoord[1], radiusM: 400 }];
  }

  async _resolveLocality(anchor, scopeBbox) {
    const sb = await this.mcp.searchBox(anchor.text, {
      types: 'place,locality,neighborhood,district,address',
      limit: this.mcp._searchBoxLimitFor(anchor.specificity),
    });
    let feats = sb?.features || [];
    if (scopeBbox) feats = this._filterByScope(feats, scopeBbox);
    if (!feats.length) return null;
    return [this._featureToPoint(this._pickBest(feats, anchor.text))];
  }

  async _resolveIntersectionAnchor(anchor) {
    const areaPoints = await this._resolveLocality({ type: 'locality', text: anchor.text });
    if (!areaPoints || !areaPoints.length) return null;
    const items = await this.mcp.collectCondition({ type: 'intersection', text: anchor.text }, areaPoints[0]);
    if (!items || !items.length) return null;
    const best = items[0];
    return [{ lng: best.longitude ?? best.lng, lat: best.latitude ?? best.lat, radiusM: DISTANCE_TABLE.nearby.radius_m }];
  }

  async _resolvePoiOrAddress(anchor, scopeBbox, requestProximity) {
    const opts = { types: 'poi,address,place,locality', limit: this.mcp._searchBoxLimitFor(anchor.specificity) };
    if (scopeBbox) opts.proximity = [(scopeBbox[0] + scopeBbox[2]) / 2, (scopeBbox[1] + scopeBbox[3]) / 2];
    else if (requestProximity) opts.proximity = [requestProximity.lng, requestProximity.lat];
    const sb = await this.mcp.searchBox(anchor.text, opts);
    let feats = sb?.features || [];
    if (!feats.length) return null;
    if (scopeBbox) feats = this._filterByScope(feats, scopeBbox);
    if (!feats.length) return null;
    const chosen = this._pickBest(feats, anchor.text);
    return [this._featureToPoint(chosen)];
  }

  // ─────────────────────────────────────────────
  // Candidate collection (spec §5 — single-shot, no grid)
  // ─────────────────────────────────────────────

  _resolveCategoryTag(queries, schemaTag = null) {
    if (!queries?.length) return null;
    const jsTag = this.mcp._resolveCategoryTag(queries);
    if (jsTag) return jsTag;
    if (!this.config.useCategorySearch || !schemaTag) return null;
    return (typeof CATEGORY_TAXONOMY !== 'undefined' && CATEGORY_TAXONOMY.includes(schemaTag)) ? schemaTag : null;
  }

  _distM(a, b) {
    const la = a.latitude ?? a.lat, lna = a.longitude ?? a.lng;
    const lb = b.latitude ?? b.lat, lnb = b.longitude ?? b.lng;
    if (la == null || lna == null || lb == null || lnb == null) return Infinity;
    const R = 6371000, toRad = d => d * Math.PI / 180;
    const dLat = toRad(lb - la), dLng = toRad(lnb - lna);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(la)) * Math.cos(toRad(lb)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /** JS-only pre-scoring dedup (name/proximity heuristics — no LLM). Unchanged from geonator. */
  _dedupTargets(cands) {
    if (!cands || cands.length <= 1) return cands;
    const norm = s => (s || '').normalize('NFKC').replace(/[\s　]+/g, '').toLowerCase();
    const hasStore = s => /店$/.test((s || '').trim());

    const byName = new Map();
    const unnamed = [];
    for (const c of cands) {
      const k = norm(c.name);
      if (!k) { unnamed.push(c); continue; }
      const ex = byName.get(k);
      if (!ex) { byName.set(k, c); continue; }
      const keep = (hasStore(c.name) && !hasStore(ex.name)) ? c
        : (!hasStore(c.name) && hasStore(ex.name)) ? ex
        : ((c.distance ?? 9e9) < (ex.distance ?? 9e9) ? c : ex);
      byName.set(k, keep);
    }
    const kept = [...byName.values(), ...unnamed];

    const NEAR_M = 30;
    const removed = new Set();
    for (let i = 0; i < kept.length; i++) {
      for (let j = 0; j < kept.length; j++) {
        if (i === j) continue;
        const a = kept[i], b = kept[j];
        if (removed.has(a.id) || removed.has(b.id)) continue;
        if (hasStore(a.name) && !hasStore(b.name) && this._distM(a, b) <= NEAR_M) {
          const na = norm(a.name), nb = norm(b.name);
          if (nb && na.startsWith(nb)) removed.add(b.id);
        }
      }
    }
    return kept.filter(c => !removed.has(c.id));
  }

  /** Deterministic building-name rule (unchanged from geonator §9). */
  _applyBuildingNameRules(target, candidates) {
    if (!['category_mansion', 'category_apartment'].includes(target?.query_intent)) return candidates;
    const BUILDING_SUFFIX = /(ビル|ビルヂング|ビルディング)$/;
    return candidates.filter(c => !(c.name && BUILDING_SUFFIX.test(c.name.trim())));
  }

  /** Debug-log a pipeline stage's surviving candidates (name only) for a group (spec: user-facing "処理ログ" modal). */
  _logStage(group, stage, items) {
    if (!this._log) return;
    this._log.stages.push({ group, stage, count: items.length, names: items.map(c => c.name || '(名前なし)') });
  }

  /** Debug-log per-candidate distance results for a condition check (name + actual nearest
   * distance + pass/fail vs threshold) — richer than _logStage's name-only list. A condition
   * that quietly excludes everyone (e.g. an "adjacent"=50m threshold too tight for
   * POI-centroid precision) previously had no visible trace; now the actual measured
   * distance for every candidate (matched or not) shows up in the 処理ログ. */
  _logConditionDistances(group, stage, entries) {
    if (!this._log) return;
    this._log.stages.push({
      group, stage, count: entries.length,
      names: entries.map(e => `${e.name || '(名前なし)'}: ${e.nearestM != null ? Math.round(e.nearestM) + 'm' : '(距離不明)'} ${e.matched ? '○圏内' : '×圏外'}`),
    });
  }

  async _collectCandidates(schema, { targetPoint }) {
    const { target, conditions } = schema;
    const targetGroup = `target: ${target.text}`;

    // No proximity at all (spec §4.2 "no clue" path): Tilequery cannot run, and
    // there's no bias point for Search Box either — just run a bias-free
    // Search Box text search on the target only (conditions need a location to be
    // meaningful, so they're skipped — a hitless search is a valid result).
    if (!targetPoint) {
      const targetCategoryTag = this._resolveCategoryTag(target.queries?.length ? target.queries : [target.text], target.category_tag);
      let mainRaw = await this.mcp.collectTarget(target, null, targetCategoryTag).catch(() => []);
      this._logStage(targetGroup, 'collectTarget（proximity無し）', mainRaw);
      mainRaw = this._applyBuildingNameRules(target, mainRaw);
      this._logStage(targetGroup, '建物名ルール後', mainRaw);
      mainRaw = this._dedupTargets(mainRaw);
      this._logStage(targetGroup, '重複排除後', mainRaw);
      const { kept } = await this._rateGroup(this._buildIntentLabel(target), mainRaw, target.query_intent, targetGroup);
      return { main: kept, conditions: {} };
    }

    const targetCategoryTag = this._resolveCategoryTag(target.queries?.length ? target.queries : [target.text], target.category_tag);
    const targetPromise = this.mcp.collectTarget(target, targetPoint, targetCategoryTag);

    const condResults = {};
    const condPromise = (conditions?.length
      ? Promise.all(conditions.map(async (c) => {
          const key = c.text ?? c.type;
          if (isLineCond(c.type)) return; // evaluated per-candidate against road/water/rail layers later
          const condQueries = (c.type === 'poi' && c.queries?.length) ? c.queries : (c.text ? [c.text] : []);
          const condCategoryTag = condQueries.length ? this._resolveCategoryTag(condQueries, c.category_tag) : null;
          // conditions share the same proximity bias point as the target — no separate
          // "expanded" area is needed now that neither is hard-filtered by a bbox.
          condResults[key] = await this.mcp.collectCondition(c, targetPoint, condCategoryTag);
          this._logStage(`condition: ${key}`, 'collectCondition', condResults[key]);
        }))
      : Promise.resolve());

    let [mainRaw] = await Promise.all([targetPromise, condPromise]);
    this._logStage(targetGroup, 'collectTarget', mainRaw);
    mainRaw = this._applyBuildingNameRules(target, mainRaw);
    this._logStage(targetGroup, '建物名ルール後', mainRaw);
    mainRaw = this._dedupTargets(mainRaw);
    this._logStage(targetGroup, '重複排除後', mainRaw);

    if (schema.proximity?.bearing_filter) {
      mainRaw = this._applyBearingFilter(mainRaw, this._anchorPoint, schema.proximity.bearing_filter);
      this._logStage(targetGroup, `方角フィルタ後(${schema.proximity.bearing_filter})`, mainRaw);
    }

    // proximity.within hard reach filter
    if (this._reachPolygons?.length || this._reachHole) {
      const { kept } = this.mcp.filterInsidePolygons(mainRaw, this._reachPolygons, this._reachHole);
      mainRaw = kept;
      this._logStage(targetGroup, 'reach範囲フィルタ後', mainRaw);
    }
    if (mainRaw.length > this.config.CANDIDATE_LIMIT) {
      mainRaw = mainRaw.slice(0, this.config.CANDIDATE_LIMIT);
      this._logStage(targetGroup, 'CANDIDATE_LIMIT後', mainRaw);
    }

    // ── unified L2 (spec §6): target + poi conditions in parallel ──
    const skipTargetRating = SKIP_L2_TARGET_INTENTS.has(target.query_intent);
    const poiConds = (conditions || []).filter(c => c.type === 'poi');
    const [mainRated] = await Promise.all([
      skipTargetRating
        ? Promise.resolve({ kept: mainRaw })
        : this._rateGroup(this._buildIntentLabel(target), mainRaw, target.query_intent, targetGroup),
      ...poiConds.map(async c => {
        const key = c.text ?? c.type;
        const items = condResults[key];
        if (!items?.length) return;
        const { kept } = await this._rateGroup(c.text || key, items, c.query_intent || 'poi', `condition: ${key}`);
        condResults[key] = kept;
      }),
    ]);
    let kept = mainRated.kept;

    // ── coordinate-cluster dedup (JS-only, deterministic) — after L2, not before ──
    // Moved back here (was briefly before L2 for cost savings) after finding a real bug:
    // pure name-containment dedup can't tell "same place, fuller name" (Starbucks example)
    // apart from "different sub-facility that happens to share a name prefix" (e.g. a
    // hotel's in-house restaurant "ホテル千秋閣レストラン聚楽" containing the hotel's own
    // name "ホテル千秋閣"). Deduping on raw pre-L2 data picked the longer name (the
    // restaurant) and discarded the actual hotel, which L2 then correctly rejected as
    // "not a hotel" — losing the real answer entirely. Running dedup after L2 means only
    // candidates L2 already confirmed relevant to the search intent can be merged, so a
    // wrong-business-type duplicate never gets the chance to evict the right one.
    const beforeClusterDedup = kept;
    kept = this._dedupClusters(kept);
    if (kept.length !== beforeClusterDedup.length) this._logStage(targetGroup, '座標クラスタ重複排除後', kept);

    return { main: kept, conditions: condResults };
  }

  /** Unified L2 (spec §6.1): category + name relevance in one LLM call per group. */
  async _rateGroup(intentLabel, candidates, queryIntent = null, logGroup = null) {
    if (!candidates || candidates.length === 0) return { kept: [] };
    // Building targets: `class` is uniformly 'building' (no mansion/apartment/office
    // distinction in the tileset), so the category field is noise — send name only and
    // use the name-only prompt variant.
    const nameOnly = BUILDING_TARGET_INTENTS.has(queryIntent);
    const payload = candidates.map(c => nameOnly
      ? { id: c.id, name: c.name }
      : { id: c.id, name: c.name, poi_category: c.poi_category, class: c.cls || null });
    const res = await this.llm.rateCandidates(intentLabel, payload, nameOnly).catch(() => null);
    if (!res) {
      this._logStage(logGroup, `L2判定失敗(fail-safe・全件keep, intent="${intentLabel}")`, candidates);
      return { kept: candidates }; // fail-safe: keep all as 'unknown'
    }
    const kept = [];
    const dropped = [];
    for (const c of candidates) {
      const id = String(c.id);
      // geonator_liteは精度優先（[[project_geonator_lite_precision_over_recall]]）: no はもちろん、
      // definitely/probablyどちらでもない unknown（=L2が確信を持てなかった候補）も最終結果には出さない。
      if (res.definitely.has(id)) { c._relevance = 'definitely'; kept.push(c); continue; }
      if (res.probably.has(id)) { c._relevance = 'probably'; kept.push(c); continue; }
      dropped.push(c);
    }
    if (this._log && logGroup) {
      this._log.stages.push({
        group: logGroup,
        stage: `L2判定(intent="${intentLabel}")`,
        count: kept.length,
        names: kept.map(c => `${c.name || '(名前なし)'} [${c._relevance}]`),
        droppedNames: dropped.map(c => c.name || '(名前なし)'),
      });
    }
    return { kept };
  }

  /**
   * Coordinate-cluster dedup (JS-only, deterministic — no LLM). Merges name variants of the
   * same real-world place (e.g. "スターバックスコーヒー渋谷店" / "コーヒー") among candidates
   * ≤10m apart, using normalized-name substring containment as the merge test. This mirrors
   * what the former LLM-based version actually checked (its own worked example was a
   * containment relationship), so behavior should carry over closely at zero LLM cost.
   * Ambiguous pairs (no containment either way) are left distinct — same conservative default.
   */
  _dedupClusters(cands) {
    if (!cands || cands.length <= 1) return cands;
    const DEDUP_M = 10;
    const norm = s => MapboxMCPClient._normalizeName(s);
    const removed = new Set();
    for (let i = 0; i < cands.length; i++) {
      if (removed.has(cands[i].id)) continue;
      const na = norm(cands[i].name);
      if (!na) continue; // unnamed candidates never match (would else match everything)
      for (let j = i + 1; j < cands.length; j++) {
        if (removed.has(cands[i].id)) break; // i itself got dropped by an earlier j
        if (removed.has(cands[j].id)) continue;
        const nb = norm(cands[j].name);
        if (!nb) continue;
        if (this._distM(cands[i], cands[j]) > DEDUP_M) continue;
        if (!na.includes(nb) && !nb.includes(na)) continue; // no containment → leave distinct
        const a = cands[i], b = cands[j];
        const drop = na.length === nb.length
          ? ((a.distance ?? 9e9) <= (b.distance ?? 9e9) ? b : a)
          : (na.length >= nb.length ? b : a);
        removed.add(drop.id);
      }
    }
    return removed.size ? cands.filter(c => !removed.has(c.id)) : cands;
  }

  _buildIntentLabel(target) {
    switch (target.query_intent) {
      case 'category_mansion': return 'マンション（分譲・賃貸マンション等の中高層集合住宅）';
      case 'category_apartment': return 'アパート（木造・軽量鉄骨等の低層集合住宅。ハイツ・コーポ・荘・メゾン等を含む）';
      case 'category_building': return 'ビル（オフィスビル・商業ビル・雑居ビル等の建物）';
      default: return target.text;
    }
  }

  _roadOpts(text) {
    if (!text) return {};
    const t = text.trim();
    const MAJOR = ['大通り', '大通', '幹線', '幹線道路', '幹線道', '国道', '都道', '県道', '主要道路', '産業道路', '大道り'];
    if (MAJOR.includes(t)) return { majorOnly: true };
    if (/(通り|街道|バイパス|ライン|道路)$/.test(t) && t.length >= 3) return { name: t };
    return {};
  }

  // ─────────────────────────────────────────────
  // Scoring / ranking (spec §7.1) — no tier labels, just score → sort desc.
  // ─────────────────────────────────────────────

  async _evaluate(schema, mainCandidates, condCandidates) {
    if (!mainCandidates || mainCandidates.length === 0) return [];

    // same_building is no longer an exact building-polygon hard filter (removed — see
    // distance-table.js) and floors is no longer filtered/scored at all — both conditions
    // now flow through the normal radius/isochrone distance evaluation below like any other.
    const conditions = schema.conditions ?? [];
    const targetGroup = `target: ${schema.target?.text}`;

    const tracker = new Map();
    for (const c of mainCandidates) tracker.set(String(c.id), { candidate: c, hit: 0, closenessSum: 0 });

    const wRel = Math.max(0, this.config.SCORE_WEIGHT_RELEVANCE ?? 0.3);
    const wCond = Math.max(0, this.config.SCORE_WEIGHT_CONDITION ?? 0.5);
    const wAnchor = Math.max(0, this.config.SCORE_WEIGHT_ANCHOR ?? 0.2);

    const relScore = c => {
      switch (c._relevance) {
        case 'definitely': return this.config.SCORE_REL_DEFINITELY ?? 1.0;
        case 'probably': return this.config.SCORE_REL_PROBABLY ?? 0.7;
        default: return this.config.SCORE_REL_UNKNOWN ?? 0.4;
      }
    };
    const anchorScore = c => {
      const d = c.distance;
      if (d == null || !this._anchorRefM) return null;
      return Math.max(0, Math.min(1, 1 - d / this._anchorRefM));
    };
    const weighted = (parts) => {
      let num = 0, den = 0;
      for (const [w, v] of parts) if (v != null && w > 0) { num += w * v; den += w; }
      return den > 0 ? num / den : 0;
    };

    if (conditions.length === 0) {
      mainCandidates.forEach(c => {
        const score = weighted([[wRel, relScore(c)], [wAnchor, anchorScore(c)]]);
        // qualScore excludes anchorScore — see _keepOutliersOnly for why.
        const qualScore = relScore(c);
        c._matchInfo = { score: +score.toFixed(3), qualScore: +qualScore.toFixed(3) };
      });
      mainCandidates.sort((a, b) => b._matchInfo.score - a._matchInfo.score);
      return mainCandidates;
    }

    const speed = { walking: 80, cycling: 250, driving: 500 };
    const isoCache = new Map();
    const conditionHit = new Set();
    // Conditions that were genuinely evaluable (regardless of whether anyone actually
    // matched) — distinct from conditionHit, which only tracks "someone matched". Without
    // this distinction, a condition that legitimately gets checked against every candidate
    // but happens to match nobody (e.g. no candidate is really trackside for a "線路沿い"
    // condition) looked identical to "we had no data to check at all" (e.g. a poi-condition
    // whose anchor text returned zero Search Box hits) — both silently dropped condScore's
    // weight from every candidate's score, letting relevance+anchor alone decide the ranking
    // as if the condition had never been asked. Only the latter (no data) should behave that
    // way; the former (evaluated, zero matches) should score everyone 0 for it.
    const evaluatedConditions = new Set();
    const addHit = (t, label, closeness) => { t.hit++; conditionHit.add(label); t.closenessSum += closeness; };
    const closenessOf = (nearestM, refM) => nearestM != null ? Math.max(0, Math.min(1, 1 - nearestM / refM)) : 0.5;

    for (const cond of conditions) {
      const label = cond.text ?? cond.type;
      const distParams = resolveDistanceParams(cond.distance, this.config.DEFAULT_LEVEL);
      if (this.config.useIsochrone === false) distParams.useIsochrone = false;
      const refM = distParams.radiusM ?? (distParams.minutes ? distParams.minutes * (speed[distParams.profile] || 80) : 250);

      if (isLineCond(cond.type)) {
        // Always genuinely evaluated: Tilequery runs per-candidate regardless of outcome.
        evaluatedConditions.add(label);
        const roadOpts = cond.type === 'road' ? this._roadOpts(cond.text) : null;
        const results = await Promise.all(mainCandidates.map(main => {
          const lat = main.latitude ?? main.lat, lng = main.longitude ?? main.lng;
          if (cond.type === 'road') return this.mcp.roadNear(lat, lng, refM, roadOpts);
          if (cond.type === 'rail') return this.mcp.railNear(lat, lng, refM);
          return this.mcp.waterNear(lat, lng, refM);
        }));
        this._logConditionDistances(targetGroup, `条件距離判定(${label}, 閾値${Math.round(refM)}m)`,
          mainCandidates.map((main, i) => ({
            name: main.name,
            nearestM: results[i].nearestM,
            matched: results[i].matched && results[i].nearestM != null && results[i].nearestM <= refM,
          })));
        mainCandidates.forEach((main, i) => {
          const res = results[i];
          const near = res.matched && res.nearestM != null && res.nearestM <= refM;
          const t = tracker.get(String(main.id));
          if (cond.negate) { if (!near) addHit(t, label, 1); }
          else if (near) addHit(t, label, closenessOf(res.nearestM, refM));
        });
        continue;
      }

      const condItems = condCandidates[label] ?? [];
      if (condItems.length === 0) {
        // Genuinely no reference data to evaluate against (e.g. the condition's own anchor
        // text returned zero collection hits) — this is the real "no information" case,
        // same treatment as anchorScore's null (excluded from effTotal, not added here).
        if (cond.negate) for (const main of mainCandidates) addHit(tracker.get(String(main.id)), label, 1);
        continue;
      }
      // We had real reference points and ran evaluateDistanceBatch — genuinely evaluated,
      // regardless of whether it found any matches.
      evaluatedConditions.add(label);
      const dir = cond.direction || null;
      const { matches, debug } = await this.mcp.evaluateDistanceBatch(mainCandidates, condItems, distParams, isoCache, dir);
      this._logConditionDistances(targetGroup, `条件距離判定(${label}, 閾値${Math.round(refM)}m)`,
        debug.map(d => ({ name: d.name, nearestM: d.nearestM, matched: matches.has(String(d.id)) })));
      if (cond.negate) {
        for (const main of mainCandidates) {
          if (matches.has(String(main.id))) continue;
          addHit(tracker.get(String(main.id)), label, 1);
        }
      } else {
        for (const [mid, nearestM] of matches) {
          const t = tracker.get(mid);
          if (t) addHit(t, label, closenessOf(nearestM, refM));
        }
      }
    }

    const effTotal = conditions.filter(c => conditionHit.has(c.text ?? c.type) || evaluatedConditions.has(c.text ?? c.type)).length;
    for (const [, t] of tracker) {
      const condScore = effTotal > 0 ? t.closenessSum / effTotal : null;
      const c = t.candidate;
      const score = weighted([[wRel, relScore(c)], [wCond, condScore], [wAnchor, anchorScore(c)]]);
      // qualScore excludes anchorScore — see _keepOutliersOnly for why: anchor distance is
      // a smooth, city-block-to-km-scale preference (someone's always a bit closer), not
      // evidence that a candidate actually qualifies better. Conditions keep their
      // continuous closeness here since they're typically tight-radius (adjacent/very_close)
      // and genuinely separate "matches the specific description" from "doesn't".
      const qualScore = weighted([[wRel, relScore(c)], [wCond, condScore]]);
      c._matchInfo = { score: +score.toFixed(3), qualScore: +qualScore.toFixed(3) };
    }

    mainCandidates.sort((a, b) => b._matchInfo.score - a._matchInfo.score);
    return mainCandidates;
  }
}

// ─────────────────────────────────────────────
// Headless entry point (spec §7.2/§7.3/§8)
// ─────────────────────────────────────────────

/** Merge a request's model/judge overrides onto the global CONFIG (spec §7.2). Does not mutate CONFIG. */
function _buildRuntimeConfig(requestBody) {
  const cfg = Object.assign({}, CONFIG);
  if (requestBody?.model) cfg.MODEL = requestBody.model;
  const j = requestBody?.judge || {};
  if (j.weights) {
    if (Number.isFinite(j.weights.relevance)) cfg.SCORE_WEIGHT_RELEVANCE = j.weights.relevance;
    if (Number.isFinite(j.weights.condition)) cfg.SCORE_WEIGHT_CONDITION = j.weights.condition;
    if (Number.isFinite(j.weights.anchor)) cfg.SCORE_WEIGHT_ANCHOR = j.weights.anchor;
  }
  cfg.DEBUG_LOG = !!requestBody?.debugLog; // 詳細処理ログ(L1/L2段階トレース+個別API呼び出し)のON/OFF
  return cfg;
}

/**
 * Headless POI search (spec §7.2 request / §7.3 response / §8 usage). No DOM, no
 * map instance — safe to call from any page that has loaded geonator_lite's
 * script-tag modules (config.js, data/*, prompts/*, modules/*).
 * @param {{text:string, proximity?:{lat:number,lng:number}, model?:string, judge?:object}} requestBody
 * @returns {Promise<{results:Array<{rank,name,lat,lng,score,poi_category}>, meta:{candidateCount,elapsedMs}}>}
 */
async function searchPOI(requestBody) {
  const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const config = _buildRuntimeConfig(requestBody || {});
  const mcp = new MapboxMCPClient(config);
  const llm = new LLMClient(config);
  const engine = new QueryEngine({ mcp, llm, config });
  return engine.run(requestBody || {}, t0);
}
