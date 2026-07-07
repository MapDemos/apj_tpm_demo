/**
 * QueryEngine — JS-driven orchestrator. Controls the entire location-finding flow.
 * LLM is called only at L1 (parseQuery) and L2 (filterCandidates).
 * Reference: systemdesign_20260704.md §3, flowdetail_20260704.md
 *
 * UI callbacks are injected via constructor so this module is DOM-independent.
 */

class QueryEngine {
  /**
   * @param {{ mcp: MapboxMCPClient, llm: LLMClient, ui: UICallbacks, config: object }} opts
   *
   * UICallbacks shape:
   *   showMessage(text: string): void
   *   showChoices(question: string, choices: string[]): Promise<string>
   *   showHintInput(prompt: string): Promise<string>
   *   showSearching(text: string): void
   *   showResults(full, partial, none, unsupported, conditionLabels): void
   *   showFeedback(): Promise<'done'|'continue'|'restart'>
   *   clearResults(): void
   */
  constructor({ mcp, llm, ui, config }) {
    this.mcp    = mcp;
    this.llm    = llm;
    this.ui     = ui;
    this.config = config;

    // Cache layers (K)
    this._cache = { bbox: null, mainCandidates: null, condCandidates: null, surfaced: null, schema: null };
    this._clarifyCount = 0;
    this._previousText = null;    // for L1 re-parse
    this._awaitingClarify = false; // last run ended asking for more info (main-input answer merges)
    this._ratingCache = new Map(); // L2-2 relevance cache: "intent||name" → definitely|probably|unknown|no (session stability)
    this._catCache    = new Map(); // L2-1 category cache: "intent||sortedCats" → { remove_poi_category:Set, remove_class:Set }
  }

  /** Localized message bundle for the current UI language. */
  _m() { return MESSAGES[this.ui.getLang?.() === 'en' ? 'en' : 'ja']; }

  /** Debug-mode step gate: pause until the operator clicks "next" (no-op otherwise). */
  async _step(stepId, label, lines) {
    if (this.ui.isDebug?.()) await this.ui.debugStep?.(stepId, label, lines || []);
  }

  // ─────────────────────────────────────────────
  // Entry point
  // ─────────────────────────────────────────────

  async run(userText) {
    // If the previous run ended waiting for clarification (e.g. "池袋は複数あります"),
    // the user's main-input answer (「池袋駅」) is merged with the original query so
    // target/conditions are retained.
    const merged = (this._awaitingClarify && this._previousText)
      ? `${this._previousText}\n追加情報：${userText}`
      : userText;
    this._previousText = merged;
    this._awaitingClarify = false;
    this._clarifyCount = 0;
    this._dbgReport = { schema: null, proximity: null, target: null, conditions: [], categoryFilter: [], evaluation: null, excludedByHardFilter: [] };
    this.llm.resetStats?.();
    this._runStart = Date.now();
    this.ui.clearResults();

    const schema = await this._parseAndValidate(merged, null);
    if (!schema) return; // clarification was handled inside

    this._dbgReport.schema = schema;

    // User-facing confirmation (LLM-generated NL) shown immediately, in parallel with
    // the heavy processing that follows. States what we understood + what couldn't be included.
    if (schema.confirmation) this.ui.showMessage(schema.confirmation);

    // [STEP] QuerySchema — show the parsed intent early so the operator can sanity-check
    // L1's interpretation (target / conditions / distances) before any search runs.
    const anchors = (schema.proximity?.anchors || []).map(a => `${a.text}[${a.type}/${a.specificity}]`).join(', ');
    await this._step('step-schema', '⓪ クエリ解釈 (QuerySchema)', [
      `proximity: ${anchors || '(なし)'}${schema.proximity?.bearing_filter ? ' 方角=' + schema.proximity.bearing_filter : ''}`,
      `target: ${schema.target?.text}  intent=${schema.target?.query_intent}`,
      ...(schema.conditions || []).map(c => {
        const d = c.distance || {};
        return `condition: ${c.text ?? c.type} [${c.type}] 距離=${d.level ?? '-'}/${d.method ?? '-'}${d.minutes ? ' ' + d.minutes + '分' : ''}`;
      }),
    ]);

    await this._executeSearch(schema, merged);
  }

  // ─────────────────────────────────────────────
  // [2] L1 parse + [A] structural checks + [II] validate
  // ─────────────────────────────────────────────

  async _parseAndValidate(userText, previousText) {
    let schema;
    try {
      schema = await this.llm.parseQuery(userText, previousText);
    } catch (e) {
      this.ui.showMessage(this._m().error_communication);
      return null;
    }

    // Not a location query (greeting / chit-chat / no location clue) → guide the user
    const noLocationClue = !schema?.proximity?.anchors?.length && !schema?.target?.text;
    if (schema?.not_a_query || noLocationClue) {
      this.ui.showMessage(this._m().not_a_query);
      return null;
    }

    // [II] schema validation — malformed structure = treat as a real parse/comm issue
    const validation = validateQuerySchema(schema);
    if (!validation.ok) {
      console.warn('[QueryEngine] L1 schema invalid:', validation.errors);
      // If it lacks the essentials, it's more likely a non-query than a comm error.
      if (!schema?.proximity?.anchors?.length || !schema?.target?.text) {
        this.ui.showMessage(this._m().not_a_query);
      } else {
        this.ui.showMessage(this._m().error_communication);
      }
      return null;
    }

    fillSchemaDefaults(schema, this.config.DEFAULT_LEVEL, this.config.MAX_CONDITIONS);

    // [A] structural checks
    const issues = structuralChecks(schema);
    for (const issue of issues) {
      const handled = await this._handleStructuralIssue(issue, schema);
      if (!handled) return null; // unresolvable
    }

    return schema;
  }

  async _handleStructuralIssue(issue, schema) {
    if (this._clarifyCount >= this.config.MAX_CLARIFY_TURNS) {
      this.ui.showMessage(this._m().clarify_limit);
      return false;
    }
    this._clarifyCount++;

    switch (issue.kind) {
      case 'proximity_missing': {
        // [DD] Mode2 — ask for location
        const answer = await this.ui.showHintInput(this._m().ask_proximity);
        if (!answer) return false;
        const newSchema = await this._reparseMerged(answer);
        if (!newSchema) return false;
        Object.assign(schema, newSchema);
        return true;
      }
      case 'target_missing': {
        const answer = await this.ui.showHintInput(this._m().ask_target);
        if (!answer) return false;
        const newSchema = await this._reparseMerged(answer);
        if (!newSchema) return false;
        Object.assign(schema, newSchema);
        return true;
      }
      case 'distance_too_far': {
        // [4] level=far → pushback
        this.ui.showMessage(this._m().distance_too_far);
        return false;
      }
      default:
        return true;
    }
  }

  async _reparseMerged(additionalText) {
    // Combine once here, then pass as the full text (previousText=null) so parseQuery
    // does NOT re-append and duplicate the hint.
    const combined = `${this._previousText}\n追加情報：${additionalText}`;
    this._previousText = combined;
    try {
      const schema = await this.llm.parseQuery(combined, null);
      if (!validateQuerySchema(schema).ok) return null;
      fillSchemaDefaults(schema, this.config.DEFAULT_LEVEL, this.config.MAX_CONDITIONS);
      return schema;
    } catch {
      this.ui.showMessage(this._m().error_communication);
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // [3-A] Primary search: proximity → bbox
  // ─────────────────────────────────────────────

  async _executeSearch(schema, originalText) {
    // Clear previous map results/drawings on every (re)execution so follow-up
    // queries don't accumulate stale markers/bboxes on the map.
    this.ui.clearResults?.();

    // Determine which cache layers to reuse (K)
    const cacheInvalid = this._detectCacheInvalidation(schema);
    this._cache.schema = schema;

    // [3-A] resolve proximity → bbox (unless cached)
    if (cacheInvalid.bbox) {
      this.ui.showSearching(this._m().searching);
      const bboxResult = await this._resolveProximity(schema);
      if (!bboxResult) return;
      this._cache.bbox = bboxResult;
      // Visualize resolved anchor points
      this.ui.drawProximityPoints?.(bboxResult.resolvedPoints);
    }

    // [3-A4] compute dual bbox (C-2)
    const bboxes = this._computeDualBbox(this._cache.bbox, schema);

    // anchorScore の参照半径 = target収集bboxの外接半径（幅の半分）。候補の c.distance
    // (アンカー中心からの距離) をこの半径で正規化して「アンカーからの近さ」に使う。
    this._anchorRefM = Math.max(1, this._bboxWidthM(bboxes.targetBbox) / 2);

    // Debug: proximity resolution info
    this._dbgReport.proximity = {
      anchors:      schema.proximity.anchors.map(a => `${a.text}(${a.type})`),
      pointCount:   this._cache.bbox.resolvedPoints?.length ?? 0,
      targetBboxM:  this._bboxWidthM(bboxes.targetBbox),
      condBboxM:    this._bboxWidthM(bboxes.condBbox),
      bearing:      schema.proximity.bearing_filter || null,
    };

    // Visualize search area (target = tight, condition = wide) + fit map
    this.ui.drawBBox?.(bboxes.condBbox);
    this.ui.drawBBox?.(bboxes.targetBbox);
    this.ui.fitToBBox?.(bboxes.condBbox);
    this.ui.refreshCounts?.();

    // [STEP] proximity解決
    await this._step('step-proximity', '① 一次検索: proximity解決', [
      `アンカー: ${this._dbgReport.proximity.anchors.join(', ')}`,
      `target収集bbox 約${this._dbgReport.proximity.targetBboxM}m / condition収集bbox 約${this._dbgReport.proximity.condBboxM}m`,
    ]);

    // [3-B] collect candidates (unless cached)
    if (cacheInvalid.candidates) {
      const collected = await this._collectCandidates(schema, bboxes);
      if (!collected) return;
      this._cache.mainCandidates = collected.main;
      this._cache.condCandidates = collected.conditions;
      // Visualize hits
      this.ui.drawHits?.(collected.main);
      Object.values(collected.conditions).forEach(items => this.ui.drawConditionHits?.(items));
      this.ui.refreshCounts?.();
    }

    // [STEP] Step1 収集
    await this._step('step-collect', '② Step1: 候補収集', [
      `target「${this._dbgReport.target?.intent}」: 取得${this._dbgReport.target?.raw} → 除外${this._dbgReport.target?.excluded} → 残${this._dbgReport.target?.kept}`,
      ...(this._dbgReport.conditions || []).map(c => `条件 ${c.label}[${c.type}]: ${c.found}`),
    ]);

    // [3-C] evaluate (collect reach polygons for visualization)
    this.mcp._evalPolygons = [];
    const results = await this._evaluate(schema, this._cache.mainCandidates, this._cache.condCandidates);
    this.ui.drawPolygons?.(this.mcp._evalPolygons);

    // Debug: evaluation breakdown (with score + tier)
    const dbgRow = c => ({ name: c.name || '(名前なし)', score: c._matchInfo?.score ?? 0, tier: c._tier, rel: c._relevance, hit: c._matchInfo?.hit ?? 0, total: c._matchInfo?.total ?? 0, labels: c._matchInfo?.labels ?? [] });
    this._dbgReport.evaluation = {
      full:    results.full.map(dbgRow),
      partial: results.partial.map(dbgRow),
      noneCount: results.none.length,
    };

    // [STEP] Step2 評価
    await this._step('step-eval', '③ Step2: 距離評価', [
      `全一致 ${results.full.length} / 部分一致 ${results.partial.length} / 参考 ${results.none.length}`,
    ]);

    // [4] show results
    this._showResults(results, schema);
    this.ui.refreshCounts?.();
    // Token/time telemetry for this search cycle
    this.ui.showRunStats?.({ ms: Date.now() - (this._runStart || Date.now()), llm: this.llm.stats });
    this.ui.showDebugReport?.(this._dbgReport);

    // [5] feedback
    await this._handleFeedback(schema, originalText);
  }

  _bboxWidthM(bbox) {
    if (!bbox) return 0;
    const cy = (bbox[1] + bbox[3]) / 2;
    return Math.round(Math.abs(bbox[2] - bbox[0]) * 111320 * Math.cos(cy * Math.PI / 180));
  }

  // ─────────────────────────────────────────────
  // [3-A] proximity resolution
  // ─────────────────────────────────────────────

  async _resolveProximity(schema) {
    const anchors = schema.proximity.anchors;
    const resolvedPoints = [];

    // Optional scope (broad area to locate/disambiguate a POI anchor within):
    // 「鎌倉市のコメダの前の…」→ scope=鎌倉市, anchor=コメダ.
    let scopeBbox = null;
    if (schema.proximity.scope?.text) {
      scopeBbox = await this._resolveScopeBbox(schema.proximity.scope);
    }

    for (const anchor of anchors) {
      // [B1] generic check — only for anchor, not target (§4-3)
      if (anchor.specificity === 'generic' && anchors.length === 1 && !scopeBbox) {
        await this._clarifyGenericAnchor(anchor);
        return null; // re-entry will happen from feedback loop
      }

      const points = await this._resolveAnchor(anchor, scopeBbox);
      if (points === null) return null; // clarification/disambiguation in progress or aborted
      if (points.length === 0) {
        this.ui.showMessage(this._m().anchorNotFound(anchor.text));
        this._awaitingClarify = true; // next answer merges with this query
        return null;
      }
      resolvedPoints.push(...points);
    }

    // [AA] compute base bbox from all resolved points
    let bbox = this.mcp.resolveBBox({ points: resolvedPoints, marginM: 0 });

    // Upper-limit check (EE/§6-3): the dense building grid is infeasible over a
    // huge area, so only building-category targets get pushed back. General POI
    // targets (e.g. 鎌倉のコメダ珈琲) tolerate a large area — Search Box handles it.
    if (this._bboxExceedsLimit(bbox)) {
      const buildingTarget = ['category_mansion', 'category_apartment', 'category_building']
        .includes(schema.target?.query_intent);
      if (buildingTarget) {
        this.ui.showMessage(this._m().bbox_too_large);
        return null;
      }
      // else: allow — collectTarget will rely on Search Box (grid is skipped for big bbox)
    }

    // [3-A3] bearing filter
    if (schema.proximity.bearing_filter) {
      bbox = this._applyBearingCut(bbox, schema.proximity.bearing_filter);
    }

    return { bbox, resolvedPoints };
  }

  async _resolveAnchor(anchor, scopeBbox = null) {
    switch (anchor.type) {
      case 'station':
        return await this._resolveStation(anchor);
      case 'locality':
      case 'address':
        // Area anchors (地名・丁目) — homonym disambiguation by municipality
        // (台東区入谷 vs 足立区入谷 are both 東京都 → must compare at 区/市 level).
        return await this._resolveLocality(anchor);
      case 'intersection':
        // Named intersection as reference (「入谷二丁目の交差点」= the intersection
        // NAMED 入谷二丁目). Resolve its area, then find that named intersection.
        return await this._resolveIntersectionAnchor(anchor);
      case 'poi':
        return await this._resolvePoiOrAddress(anchor, scopeBbox);
      default:
        return null;
    }
  }

  /** Resolve a scope place/locality to a bbox (used to constrain POI anchor search). */
  async _resolveScopeBbox(scope) {
    const sb = await this.mcp.searchBox(scope.text, { types: 'place,locality,district' });
    const f = sb?.features?.[0];
    if (!f) return null;
    const bbox = f.properties?.bbox;
    if (bbox) return bbox;
    // no bbox → build a generous box around the point
    const [lng, lat] = f.geometry.coordinates;
    const r = 5000; // ~city-ish
    const dLng = r / (111320 * Math.cos(lat * Math.PI / 180)), dLat = r / 110540;
    return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
  }

  async _resolveStation(anchor) {
    // 1. Search Box → station coordinate
    const sbResult = await this.mcp.searchBox(anchor.text, { types: 'poi,address,place' });
    if (!sbResult?.features?.length) return null;

    const stationCoord = sbResult.features[0].geometry.coordinates; // [lng, lat]

    // 2. Tilequery → all transit entrances
    const entrances = await this.mcp.tilequeryTransitEntrances(stationCoord[1], stationCoord[0], 500);

    // [C-2] exit-specified
    const exitName = anchor.subtype?.exit;
    if (exitName && entrances.length > 0) {
      const matched = entrances.find(e => e.name && e.name.includes(exitName));
      if (matched) {
        const radiusM = DISTANCE_TABLE.nearby.radius_m; // 700m default station extent
        return [{ lng: matched.lng, lat: matched.lat, radiusM }];
      }
    }

    // No exit specified → span all entrances with a modest station radius so the
    // "駅の近く" area stays reasonable (also bounds the dense building-grid cost).
    const STATION_RADIUS_M = 400;
    if (entrances.length > 0) {
      return entrances.map(e => ({ lng: e.lng, lat: e.lat, radiusM: STATION_RADIUS_M }));
    }

    // Fallback: use station representative coordinate
    return [{ lng: stationCoord[0], lat: stationCoord[1], radiusM: STATION_RADIUS_M }];
  }

  async _resolveLocality(anchor) {
    const sbResult = await this.mcp.searchBox(anchor.text, { types: 'place,locality,neighborhood,district,address' });
    if (!sbResult?.features?.length) return null;

    const features = sbResult.features;

    // Group by MUNICIPALITY (都道府県+市区町村). A true homonym is the same name
    // in a different municipality — 台東区入谷 vs 足立区入谷 are BOTH 東京都, so
    // prefecture alone is too coarse; compare at the 区/市 level.
    const byMuni = new Map();
    for (const f of features) {
      const key = this._municipalityKey(f.properties?.full_address || f.properties?.name || '');
      if (!byMuni.has(key)) byMuni.set(key, []);
      byMuni.get(key).push(f);
    }
    // representative per municipality: prefer place-level, else the first
    const reps = [...byMuni.values()].map(group =>
      group.find(f => f.properties?.feature_type === 'place') || group[0]
    );

    // [B2] genuine homonym across municipalities → Mode1 button
    if (reps.length > 1 && this._clarifyCount < this.config.MAX_CLARIFY_TURNS) {
      this._clarifyCount++;
      const choices = reps.map(f => f.properties.full_address || f.properties.name);
      const chosen = await this.ui.showChoices(this._m().whichArea(anchor.text), choices.slice(0, 4));
      const idx = choices.indexOf(chosen);
      return [this._featureToBboxPoint(reps[idx >= 0 ? idx : 0])];
    }

    // Single municipality → use its representative, no buttons
    return [this._featureToBboxPoint(reps[0])];
  }

  /**
   * Resolve a named intersection as a proximity anchor.
   * 「入谷二丁目の交差点」→ resolve 入谷二丁目 area (with 台東/足立 disambiguation),
   * then find the intersection NAMED 入谷二丁目 within it.
   */
  async _resolveIntersectionAnchor(anchor) {
    // 1. Resolve the area (reuses municipality disambiguation)
    const areaPoints = await this._resolveLocality({ type: 'locality', text: anchor.text });
    if (!areaPoints || areaPoints.length === 0) return null;
    const areaBbox = this.mcp.resolveBBox({ points: areaPoints, marginM: 0 });

    // 2. Find intersections whose name matches (road layer, class=intersection)
    const items = await this.mcp.collectCondition({ type: 'intersection', text: anchor.text }, areaBbox);
    if (!items || items.length === 0) {
      this.ui.showMessage(this._m().intersectionNotFound(anchor.text));
      return null;
    }

    // Nearest matching intersection (items are distance-sorted from area center)
    const best = items[0];
    const radiusM = DISTANCE_TABLE.nearby.radius_m;
    return [{ lng: best.longitude ?? best.lng, lat: best.latitude ?? best.lat, radiusM }];
  }

  /** Municipality key: 都道府県 + 最初の市区町村 (e.g. 東京都台東区). Falls back to raw. */
  _municipalityKey(name) {
    const clean = (name || '').replace(/〒[\d-]*/g, '').trim();
    const m = clean.match(/(..[都道府県])((?:.+?郡)?.+?[市区町村])/);
    return m ? (m[1] + m[2]) : clean;
  }

  async _resolvePoiOrAddress(anchor, scopeBbox = null) {
    // If a scope is given (「鎌倉市のコメダ…」), BIAS by its center but do NOT pass
    // bbox as a hard filter (Search Box bbox-filtering silently drops valid hits).
    // Then filter results to the scope in JS.
    const opts = { types: 'poi,address,place,locality' };
    if (scopeBbox) {
      opts.proximity = [(scopeBbox[0] + scopeBbox[2]) / 2, (scopeBbox[1] + scopeBbox[3]) / 2];
    }
    const sbResult = await this.mcp.searchBox(anchor.text, opts);
    const rawFeatures = sbResult?.features || [];
    let features = rawFeatures;
    if (scopeBbox) {
      const filtered = rawFeatures.filter(f => this._pointInBbox(f.geometry?.coordinates, scopeBbox));
      // Safety net (recall priority): if the scope box drops EVERYTHING but the raw
      // search did find results, the scope was likely too tight/wrong (or the anchor
      // is actually outside it). Fall back to the proximity-biased raw results rather
      // than aborting with nothing.
      features = filtered.length ? filtered : rawFeatures;
    }
    if (!features.length) {
      // Genuinely nothing found — tell the user instead of aborting silently.
      this.ui.showMessage(this._m().anchorNotFound(anchor.text));
      this._awaitingClarify = true;
      return null;
    }

    const radiusM = DISTANCE_TABLE.nearby.radius_m; // default extent around the anchor

    // Distinct candidate locations (a POI anchor can resolve to several — e.g. 3
    // コメダ). proximity MUST be a single point → disambiguate to 1 via buttons.
    const distinct = this._dedupByCoord(features);

    if (distinct.length > 1 && this._clarifyCount < this.config.MAX_CLARIFY_TURNS) {
      this._clarifyCount++;
      const choices = distinct.slice(0, 4).map(f =>
        `${f.properties.name}${f.properties.full_address ? '（' + f.properties.full_address + '）' : ''}`
      );
      const chosen = await this.ui.showChoices(this._m().whichPoi(anchor.text), choices);
      const idx = choices.indexOf(chosen);
      const f = distinct[idx >= 0 ? idx : 0];
      return [{ lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], radiusM }];
    }

    const feature = distinct[0];
    const ftype = feature.properties?.feature_type;
    // Only reject genuinely huge admin areas; a place (市/区) is acceptable as a
    // broad proximity (its bbox is used when available).
    if (['region', 'country'].includes(ftype)) {
      this.ui.showMessage(this._m().proximity_too_broad);
      this._awaitingClarify = true;
      return null;
    }
    if (feature.properties?.bbox) return [this._featureToBboxPoint(feature)];
    const coord = feature.geometry.coordinates;
    return [{ lng: coord[0], lat: coord[1], radiusM }];
  }

  _pointInBbox(coord, bbox) {
    if (!coord || !bbox) return false;
    return coord[0] >= bbox[0] && coord[0] <= bbox[2] && coord[1] >= bbox[1] && coord[1] <= bbox[3];
  }

  /** Dedup Search Box features by coordinate (~30m) — distinct physical locations. */
  _dedupByCoord(features) {
    const seen = new Map();
    const out = [];
    for (const f of features) {
      const c = f.geometry?.coordinates;
      if (!c) continue;
      const key = `${Math.round(c[0] * 3000)}|${Math.round(c[1] * 3000)}`; // ~30m grid
      if (!seen.has(key)) { seen.set(key, true); out.push(f); }
    }
    return out;
  }

  _featureToBboxPoint(feature) {
    // locality → use bbox if available, else coordinate
    const bbox = feature.properties?.bbox || feature.bbox;
    if (bbox) return { bbox }; // { bbox: [minX,minY,maxX,maxY] }
    const coord = feature.geometry.coordinates;
    return { lng: coord[0], lat: coord[1], radiusM: DISTANCE_TABLE.nearby.radius_m };
  }

  _filterDistinctLocalities(features) {
    // Distinct = different region context (different administrative area)
    const seen = new Map();
    const result = [];
    for (const f of features) {
      const region = f.properties?.context?.region?.name ?? f.properties?.place_formatted ?? f.properties?.name;
      if (!seen.has(region)) { seen.set(region, true); result.push(f); }
    }
    return result;
  }

  async _clarifyGenericAnchor(anchor) {
    if (this._clarifyCount >= this.config.MAX_CLARIFY_TURNS) {
      this.ui.showMessage(this._m().clarify_limit);
      return;
    }
    this._clarifyCount++;
    this.ui.showMessage(this._m().genericMulti(anchor.text));
    this._awaitingClarify = true; // next main-input answer merges with this query
  }

  // ─────────────────────────────────────────────
  // [3-A4] Dual bbox (C-2 / §7-4)
  // ─────────────────────────────────────────────

  _computeDualBbox(bboxResult, schema) {
    const targetBbox = bboxResult.bbox;
    const margin     = maxConditionRadiusM(schema.conditions, this.config.DEFAULT_LEVEL);
    const condBbox   = margin > 0
      ? this.mcp.expandBBox(targetBbox, margin)
      : targetBbox;
    return { targetBbox, condBbox };
  }

  _applyBearingCut(bbox, direction) {
    // Cut bbox in half along center line for the given cardinal direction.
    // Keeps the "direction" half.
    const [minX, minY, maxX, maxY] = bbox;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    switch (direction) {
      case 'north': return [minX, cy,   maxX, maxY];
      case 'south': return [minX, minY, maxX, cy  ];
      case 'east':  return [cx,   minY, maxX, maxY];
      case 'west':  return [minX, minY, cx,   maxY];
      default:      return bbox;
    }
  }

  /**
   * Deterministic JS name rules for building-category targets.
   * マンション/アパート（居住系）は「〜ビル」で終わる名前を除外する
   * （ビル＝オフィス/雑居/商業。居住系が「〜ビル」で終わることはほぼ無い。
   *  後方一致なので名前途中に"ビル"を含む居住系は残る）。
   * category_building（ビル探し）には適用しない。
   */
  _applyBuildingNameRules(target, candidates) {
    if (!['category_mansion', 'category_apartment'].includes(target?.query_intent)) return candidates;
    const BUILDING_SUFFIX = /(ビル|ビルヂング|ビルディング)$/;
    return candidates.filter(c => !(c.name && BUILDING_SUFFIX.test(c.name.trim())));
  }

  _bboxExceedsLimit(bbox) {
    if (!bbox) return false;
    const [minX, minY, maxX, maxY] = bbox;
    const latDiff  = Math.abs(maxY - minY);
    const lngDiff  = Math.abs(maxX - minX);
    const halfM    = Math.max(latDiff, lngDiff) * 111000 / 2;
    return halfM > this.config.BBOX_MAX_HALF_M;
  }

  // ─────────────────────────────────────────────
  // [3-B] Step1: collect candidates
  // ─────────────────────────────────────────────

  async _collectCandidates(schema, { targetBbox, condBbox }) {
    const { target, conditions } = schema;

    // Build ONE shared poi_label grid over the widest (condition) bbox, reused by the
    // target and every poi condition — they all query poi_label, so one dense (65)
    // pass replaces N per-query grids (fixes latency; keeps full recall). Skip only
    // for huge general-target areas (buildings are bounded earlier by push-back).
    const targetIsBuilding = ['category_mansion', 'category_apartment', 'category_building']
      .includes(target?.query_intent);
    const useGrid = targetIsBuilding || this.mcp._bboxToRadius(condBbox) <= 1500;
    const sharedGrid = useGrid ? await this.mcp.buildPoiLabelGrid(condBbox, 65) : null;

    // Target collection (partition shared grid to the tight target bbox)
    let mainRaw = await this.mcp.collectTarget(target, targetBbox, sharedGrid);
    mainRaw = this._applyBuildingNameRules(target, mainRaw);

    // Conditions collection (partition shared grid to the wide condition bbox) — parallel
    const condResults = {};
    const condDebug   = [];
    if (conditions?.length) {
      await Promise.all(conditions.map(async (c) => {
        const key = c.text ?? c.type;
        // road/water are evaluated per-candidate against the road/water layer
        // (they're lines, not points) — no item collection here.
        if (c.type === 'road' || c.type === 'water') {
          condDebug.push({ label: key, type: c.type, level: c.distance?.level, method: c.distance?.method, found: '候補ごと評価' });
          return;
        }
        const items = await this.mcp.collectCondition(c, condBbox, sharedGrid);
        condResults[key] = items;
        condDebug.push({ label: key, type: c.type, level: c.distance?.level, method: c.distance?.method, found: items.length });
        // [S] note if condition returned 0 items
        if (!items || items.length === 0) {
          this.ui.showMessage(this._m().condNotFound(key));
        }
      }));
    }

    // [3-B0] L2-1 category validity filter (通常クエリ collections only): drop candidates
    // whose poi_category/class is clearly different from the intent. Runs BEFORE the
    // reach-polygon build (conditions) and BEFORE L2-2 (target) so noise (e.g. コンビニ
    // named "セブンイレブン天神中央公園") never pollutes downstream geometry/scoring.
    mainRaw = await this._applyCategoryFilter(schema, mainRaw, condResults);

    // [3-B1] L2-2 relevance rating: remove 'no', tag kept as definitely/probably/unknown
    const { kept, excludedNames } = await this._rateMain(target, mainRaw);

    // Debug: target + condition collection breakdown
    const tdbg = this.mcp._lastTargetDebug || null;
    this._dbgReport.target = {
      intent:        this._buildIntentLabel(target),
      raw:           mainRaw.length,
      excluded:      excludedNames.length,
      excludedNames: excludedNames.slice(0, 40),
      kept:          kept.length,
      keptNames:     kept.map(c => c.name).slice(0, 50),
      // Raw collection lists (before L2 rating): what each API returned + what the
      // name/class filter dropped. Surfaced so the collection stage is inspectable.
      sbCount:       tdbg?.sb_count ?? null,
      tqCount:       tdbg?.tq_count ?? null,
      tqDroppedCount: tdbg?.tq_dropped_count ?? null,
      wantClasses:   tdbg?.want_classes ?? null,
      sbItems:       tdbg?.sb_items ?? [],
      tqItems:       tdbg?.tq_items ?? [],
      tqDropped:     tdbg?.tq_dropped ?? [],
    };
    this._dbgReport.conditions = condDebug;

    return { main: kept, conditions: condResults };
  }

  /**
   * L2-1 category validity filter. Applies to 通常クエリ collections only:
   *   - target when query_intent === 'specific' (general_poi search via Search Box)
   *   - conditions of type 'poi'
   * For each such group: dedupe candidate poi_category(SB)/class(TQ), ask the LLM which
   * categories are clearly-wrong (remove-set), then drop matching candidates.
   * Soft: candidates with no category are kept; a removal that would empty a group is skipped.
   * Mutates condResults[key] in place; returns the (possibly filtered) target list.
   */
  async _applyCategoryFilter(schema, mainRaw, condResults) {
    const target = schema.target;
    const TARGET_KEY = '__target__';
    const groups = [];

    // target group (general_poi search only)
    if (target && target.query_intent === 'specific' && mainRaw?.length) {
      groups.push(this._buildCatGroup(TARGET_KEY, target.text || this._buildIntentLabel(target), mainRaw));
    }
    // poi condition groups
    for (const c of (schema.conditions || [])) {
      if (c.type !== 'poi') continue;
      const key   = c.text ?? c.type;
      const items = condResults[key];
      if (items?.length) groups.push(this._buildCatGroup(key, c.text || key, items));
    }

    // only groups that actually carry a category vocabulary can be judged
    const judgeable = groups.filter(g => g.poi_category.length || g.class.length);
    if (judgeable.length === 0) return mainRaw;

    const cacheKeyOf = g => `${g.intent}||${[...g.poi_category].sort().join(',')}||${[...g.class].sort().join(',')}`;

    // send only un-cached groups to the LLM (one batched call). Use simple ASCII keys
    // (g0,g1,…) for the LLM payload so it doesn't have to echo Japanese keys back.
    const uncached = judgeable.filter(g => !this._catCache.has(cacheKeyOf(g)));
    if (uncached.length) {
      const res = await this.llm.filterCategories(uncached.map((g, i) => ({
        key: `g${i}`, intent: g.intent, poi_category: g.poi_category, class: g.class,
      })));
      if (res) {
        uncached.forEach((g, i) => {
          if (res[`g${i}`]) this._catCache.set(cacheKeyOf(g), res[`g${i}`]);
        });
      }
    }

    // null-category handling (setting): false = drop candidates with no category at all.
    const excludeNull = this.config.L2_1_KEEP_NULL_CATEGORY === false;

    // apply removals (soft + never-empty)
    const dbg = [];
    let outMain = mainRaw;
    for (const g of judgeable) {
      const removeSet = this._catCache.get(cacheKeyOf(g));
      if (!removeSet) continue; // uncached (LLM failed) → keep all
      const { remove_poi_category, remove_class } = removeSet;
      const hasRemovals = remove_poi_category.size || remove_class.size;
      if (!hasRemovals && !excludeNull) continue; // nothing to do for this group
      const survivors = g.items.filter(it => {
        if (this._catMatchesRemove(it, remove_poi_category, remove_class)) return false; // clearly-wrong category
        if (excludeNull && !this._hasCategory(it)) return false;                          // no category → strict drop
        return true;
      });
      const after = survivors.length ? survivors : g.items; // never-empty guard
      dbg.push({
        label:       g.key === TARGET_KEY ? 'target' : g.key,
        removePoi:   [...remove_poi_category],
        removeClass: [...remove_class],
        nullDropped: excludeNull,
        before:      g.items.length,
        after:       after.length,
      });
      if (g.key === TARGET_KEY) outMain = after;
      else condResults[g.key] = after;
    }
    if (dbg.length) this._dbgReport.categoryFilter = dbg;
    return outMain;
  }

  /** Build a category group: dedupe poi_category(SB) and class/maki(TQ) across items. */
  _buildCatGroup(key, intent, items) {
    const poiCat = new Set();
    const cls    = new Set();
    for (const it of items) {
      if (Array.isArray(it.poi_category)) it.poi_category.forEach(c => { if (c) poiCat.add(String(c)); });
      if (it.cls)  cls.add(String(it.cls));
      if (it.maki) cls.add(String(it.maki));
    }
    return { key, intent, items, poi_category: [...poiCat], class: [...cls] };
  }

  /** True if the item carries any category signal (poi_category / class / maki). */
  _hasCategory(it) {
    return (Array.isArray(it.poi_category) && it.poi_category.length > 0) || !!it.cls || !!it.maki;
  }

  /** True if the item's own categories intersect the remove-set (→ drop). */
  _catMatchesRemove(it, removePoi, removeClass) {
    if (Array.isArray(it.poi_category) && it.poi_category.some(c => removePoi.has(String(c)))) return true;
    if (it.cls  && removeClass.has(String(it.cls)))  return true;
    if (it.maki && removeClass.has(String(it.maki))) return true;
    return false;
  }

  async _rateMain(target, candidates) {
    if (!candidates || candidates.length === 0) return { kept: [], excludedNames: [] };

    // L2 relevance rating (all target types). 4-level ordinal for stability:
    // definitely / probably / unknown(default) / no(removed). Cached by intent||name
    // for the session so repeated queries stay stable (LLM rating is nondeterministic).
    const intentLabel = this._buildIntentLabel(target);
    const keyOf = c => `${intentLabel}||${(c.name || '').trim()}`;

    // Only send un-cached (and named) candidates to the LLM
    const uncached = candidates.filter(c => c.name && !this._ratingCache.has(keyOf(c)));
    if (uncached.length) {
      const BATCH = 40;
      const batches = [];
      for (let i = 0; i < uncached.length; i += BATCH) batches.push(uncached.slice(i, i + BATCH));
      const results = await Promise.all(batches.map(b =>
        this.llm.rateCandidates(intentLabel, b.map(c => ({ id: c.id, name: c.name })))
      ));
      batches.forEach((b, bi) => {
        const r = results[bi];
        if (!r) return; // failed batch → leave uncached (retry next time), default 'unknown' this run
        for (const c of b) {
          const id = String(c.id);
          const rel = r.no.has(id)         ? 'no'
                    : r.definitely.has(id) ? 'definitely'
                    : r.probably.has(id)   ? 'probably'
                    : 'unknown';
          this._ratingCache.set(keyOf(c), rel);
        }
      });
    }

    const kept = [], excludedNames = [];
    for (const c of candidates) {
      const rel = this._ratingCache.get(keyOf(c)) ?? 'unknown';
      if (rel === 'no') { excludedNames.push(c.name || '(名前なし)'); continue; }
      c._relevance = rel;
      kept.push(c);
    }
    return { kept, excludedNames };
  }

  /**
   * Decide how to match a road condition from its text.
   * - 大通り/幹線/国道等の一般語 → 幹線道路のみ (majorOnly)
   * - ○○通り/○○街道 等の固有名 → 名前一致
   * - それ以外 → 任意の道路
   */
  _roadOpts(text) {
    if (!text) return {};
    const t = text.trim();
    const MAJOR = ['大通り', '大通', '幹線', '幹線道路', '幹線道', '国道', '都道', '県道', '主要道路', '産業道路', '大道り'];
    if (MAJOR.includes(t)) return { majorOnly: true };
    if (/(通り|街道|バイパス|ライン|道路)$/.test(t) && t.length >= 3) return { name: t };
    return {};
  }

  _buildIntentLabel(target) {
    switch (target.query_intent) {
      case 'category_mansion':   return 'マンション（分譲・賃貸マンション等の中高層集合住宅）';
      case 'category_apartment': return 'アパート（木造・軽量鉄骨等の低層集合住宅。ハイツ・コーポ・荘・メゾン等を含む）';
      case 'category_building':  return 'ビル（オフィスビル・商業ビル・雑居ビル等の建物）';
      default:                   return target.text;
    }
  }

  // ─────────────────────────────────────────────
  // [3-C] Step2: evaluate distances
  // ─────────────────────────────────────────────

  async _evaluate(schema, mainCandidates, condCandidates) {
    if (!mainCandidates || mainCandidates.length === 0) {
      return { full: [], partial: [], none: [] };
    }

    const allConditions = schema.conditions ?? [];

    // ── 絶対条件フィルタ（ハードフィルタ・スコアリング前に候補を除外）──
    // 現状 same_building(method=building_id) が対象。評価不能なら除外しない(graceful)。
    // 除外候補は共通の excludedByHardFilter に記録（過剰除外の検知用）。
    const isAbsolute = c => resolveDistanceParams(c.distance, this.config.DEFAULT_LEVEL).useBuildingId;
    const hardConds  = allConditions.filter(isAbsolute);
    const conditions = allConditions.filter(c => !isAbsolute(c)); // ← 採点対象（ハードは除く）
    for (const hc of hardConds) {
      const label = hc.text ?? hc.type;
      const items = condCandidates[label] ?? [];
      if (items.length === 0) continue; // アンカー未取得＝評価不能 → フィルタしない
      const { kept, excluded } = await this.mcp.filterSameBuilding(mainCandidates, items);
      excluded.forEach(c => this._dbgReport.excludedByHardFilter.push({
        name: c.name || '(名前なし)', reason: `絶対条件「${label}」(同じビル)を満たさない`,
      }));
      mainCandidates = kept;
    }
    if (mainCandidates.length === 0) return { full: [], partial: [], none: [] };

    // conditionTracker: candidateId → { total, hit, closenessSum }
    const tracker = new Map();
    for (const c of mainCandidates) {
      tracker.set(String(c.id), { candidate: c, total: conditions.length, hit: 0, hitLabels: [], closenessSum: 0 });
    }

    // 3要素の重み付き和: score = normalize(w_rel×relScore + w_cond×condScore + w_anchor×anchorScore)。
    // 利用可能な要素の重みだけで割る（条件なし→condを除外、距離不明→anchorを除外）。
    // relScore は4段階(絶対そう/多分そう/わからない、「違う」は_rateMainで除外済み)。
    const wRel    = Math.max(0, this.config.SCORE_WEIGHT_RELEVANCE ?? 0.3);
    const wCond   = Math.max(0, this.config.SCORE_WEIGHT_CONDITION ?? 0.5);
    const wAnchor = Math.max(0, this.config.SCORE_WEIGHT_ANCHOR    ?? 0.2);
    const relScore = c => {
      switch (c._relevance) {
        case 'definitely': return this.config.SCORE_REL_DEFINITELY ?? 1.0;
        case 'probably':   return this.config.SCORE_REL_PROBABLY   ?? 0.7;
        default:           return this.config.SCORE_REL_UNKNOWN    ?? 0.4; // unknown
      }
    };
    // anchorScore = proximityアンカーからの近さ。c.distance(アンカー中心からの距離) と
    // this._anchorRefM(target収集bbox半径) から算出。距離不明なら null（重みから除外）。
    const anchorScore = c => {
      const d = c.distance;
      if (d == null || !this._anchorRefM) return null;
      return Math.max(0, Math.min(1, 1 - d / this._anchorRefM));
    };
    // 利用可能な要素だけで正規化した重み付き和
    const weighted = (parts) => {
      let num = 0, den = 0;
      for (const [w, v] of parts) if (v != null && w > 0) { num += w * v; den += w; }
      return den > 0 ? num / den : 0;
    };

    if (conditions.length === 0) {
      // No conditions — score = relevance + anchor closeness (no condition term).
      mainCandidates.forEach(c => {
        const score = weighted([[wRel, relScore(c)], [wAnchor, anchorScore(c)]]);
        c._matchInfo = { hit: 0, total: 0, labels: [], score: +score.toFixed(3), relevance: c._relevance };
      });
      this._assignTiers(mainCandidates, [], []);
      mainCandidates.sort((a, b) => b._matchInfo.score - a._matchInfo.score);
      return { full: mainCandidates, partial: [], none: [] };
    }

    // reference reach per profile (m/min) for isochrone closeness approximation
    const speed = { walking: 80, cycling: 250, driving: 500 };

    // [FF] isochrone optimization: compute polygon once per anchor+level
    const isoCache = new Map();

    // Track which conditions were hit by ≥1 candidate. A condition hit by NOBODY
    // (0件/データ未収録/周辺に実在しない) carries zero ranking info and only drags
    // every candidate down uniformly — so it's excluded from the effective total below
    // (treated like 'unsupported': 注記のみ・非採点)。condNotFound already notified.
    const conditionHit = new Set();
    const addHit = (t, label, nearestM, refM) => {
      t.hit++;
      t.hitLabels.push(label);
      conditionHit.add(label);
      const closeness = nearestM != null ? Math.max(0, Math.min(1, 1 - nearestM / refM)) : 0.5;
      t.closenessSum += closeness;
    };

    for (const cond of conditions) {
      const label = cond.text ?? cond.type;
      const distParams = resolveDistanceParams(cond.distance, this.config.DEFAULT_LEVEL);
      const refM = distParams.radiusM
        ?? (distParams.minutes ? distParams.minutes * (speed[distParams.profile] || 80) : 250);

      // road / water: per-candidate layer check (streets-v8 road/water layers).
      // 候補ごとに独立なので並列化（結果は候補順に同期適用するので挙動は同一）。
      if (cond.type === 'road' || cond.type === 'water') {
        const roadOpts = cond.type === 'road' ? this._roadOpts(cond.text) : null;
        const results = await Promise.all(mainCandidates.map(main => {
          const lat = main.latitude ?? main.lat, lng = main.longitude ?? main.lng;
          return cond.type === 'road'
            ? this.mcp.roadNear(lat, lng, refM, roadOpts)
            : this.mcp.waterNear(lat, lng, refM);
        }));
        mainCandidates.forEach((main, i) => {
          const res = results[i];
          if (res.matched && res.nearestM != null && res.nearestM <= refM) {
            const t = tracker.get(String(main.id));
            if (t) addHit(t, label, res.nearestM, refM);
          }
        });
        continue;
      }

      // point-based conditions (poi / bus stop / intersection / signal)
      const condItems = condCandidates[label] ?? [];
      if (condItems.length === 0) continue; // 0-item → all miss (S already notified)
      const dir = cond.direction || null; // 「南側にアパホテル」→ item must be south of candidate
      // Build reach polygons on the fewer-cardinality side (fewer isochrone calls,
      // and centers the reach on the fixed reference — correct for "X分以内 from anchor").
      const matches = await this.mcp.evaluateDistanceBatch(mainCandidates, condItems, distParams, isoCache, dir);
      for (const [mid, nearestM] of matches) {
        const t = tracker.get(mid);
        if (t) addHit(t, label, nearestM, refM);
      }
    }

    // 有効条件数 = 少なくとも1候補がヒットした条件のみ。全員0ヒットの条件（0件/データ
    // 未収録/周辺に実在しない）は分母から除外する。こうしないと評価不能な条件が全候補を
    // 一律 partial(bronze) に落とし、condScore も薄める。type を問わず適用（poi/road/水域/
    // 出口/バス停…）。除外条件は condNotFound で既に注記済み。
    const effTotal = conditions.filter(c => conditionHit.has(c.text ?? c.type)).length;

    // Classify (OR — all displayed) + attach continuous score.
    // score = normalize(w_rel×relScore + w_cond×condScore + w_anchor×anchorScore)。
    const full = [], partial = [], none = [];
    for (const [, t] of tracker) {
      // condScore = 有効条件での平均closeness（分母=effTotal、非ヒット条件は0算入）。
      // hit で割る条件付き平均は partial を楽観評価するため effTotal で割る（統計レビュー §4）。
      // effTotal===0（有効条件なし）は null にして weighted の重みから除外＝relevance/anchorのみ。
      const condScore = effTotal > 0 ? t.closenessSum / effTotal : null;
      const c = t.candidate;
      const score = weighted([[wRel, relScore(c)], [wCond, condScore], [wAnchor, anchorScore(c)]]);
      c._matchInfo = { hit: t.hit, total: effTotal, labels: t.hitLabels, score: +score.toFixed(3), relevance: c._relevance };
      // effTotal===0 のとき hit(0)===effTotal(0) で full 扱い（＝条件なしと同じ挙動）。
      if (t.hit === effTotal)     full.push(c);
      else if (t.hit > 0)         partial.push(c);
      else                        none.push(c);
    }

    // Tiering (JS, deterministic): 絶対ゲート＋マージン。絶対水準を満たし単独突出のときのみ
    // gold、僅差なら "同程度"(match)、全件低スコアなら gold なし。詳細は _assignTiers。
    this._assignTiers(full, partial, none);

    // Sort each class by score desc (best first)
    const byScore = (a, b) => (b._matchInfo.score - a._matchInfo.score);
    full.sort(byScore); partial.sort(byScore);

    return { full, partial, none };
  }

  /**
   * Assign _tier to candidates: 'gold' | 'silver' | 'match' | 'bronze' | 'none'.
   *
   * 絶対ゲート（主）＋マージン（従）方式。旧 range(max-min)ゲートは
   *   ① 期待レンジがサンプル数 n とともに増大 → n と交絡（多い時に金乱発 / 少ない時に潰す）
   *   ② min 側の外れ値1件で range が広がり誤分割（「最下位の悪さ」を見てしまう）
   * のため廃止。zスコア/パーセンタイルは n≤3 で破綻するため採用しない（統計レビュー参照）。
   *
   * 判定（full マッチのみが gold/silver 対象）:
   *   - top < GOLD_MIN_SCORE           → 絶対ゲート不通過。全員 match（"全件イマイチ"で
   *                                       単独 full でも gold にしない。best-of-garbage 防止）
   *   - n==1 または (top−2nd) ≥ MARGIN → top を gold（絶対水準を満たし単独突出）。
   *                                       残りは GOLD_MIN_SCORE 以上なら silver、未満は match。
   *   - それ以外（絶対水準は満たすが僅差）→ 同程度。全員 match（どんぐり＝勝者なし）
   *   - partial → 'bronze', none → 'none'
   */
  _assignTiers(full, partial, none) {
    const GOLD_MIN = this.config.GOLD_MIN_SCORE ?? 0.5;
    // MARGIN は言い切り度スライダーから導出：言い切り(1.0)ほど小さく(僅差でもgold)、
    // 慎重(0.0)ほど大きく(同程度に倒す)。decisiveness 0→0.30, 1→0.05 に線形マップ。
    const dec    = Math.max(0, Math.min(1, this.config.SCORE_DECISIVENESS ?? 0.4));
    const MARGIN = 0.30 - 0.25 * dec;

    if (full.length >= 1) {
      const sorted = [...full].sort((a, b) => b._matchInfo.score - a._matchInfo.score);
      const top    = sorted[0]._matchInfo.score;
      const second = sorted.length > 1 ? sorted[1]._matchInfo.score : -Infinity;
      const margin = top - second; // n==1 のとき +Infinity 相当

      if (top < GOLD_MIN) {
        // 絶対ゲート不通過：全条件を満たしていても実力が低い → 勝者を立てない
        full.forEach(c => { c._tier = 'match'; c._flatTier = true; });
      } else if (margin >= MARGIN) {
        // 絶対水準を満たし、1位が単独で突出 → gold
        sorted[0]._tier = 'gold';
        sorted.slice(1).forEach(c => { c._tier = c._matchInfo.score >= GOLD_MIN ? 'silver' : 'match'; });
      } else {
        // 絶対水準は満たすが僅差（どんぐりの背比べ）→ 同程度、gold なし
        full.forEach(c => { c._tier = 'match'; c._flatTier = true; });
      }
    }
    partial.forEach(c => { c._tier = 'bronze'; });
    none.forEach(c => { c._tier = 'none'; });
  }

  // ─────────────────────────────────────────────
  // [4] Show results
  // ─────────────────────────────────────────────

  _showResults({ full, partial, none }, schema) {
    const totalMain = full.length + partial.length + none.length;

    if (totalMain === 0) {
      // [L] main 0 → ask for more info
      this.ui.showMessage(this._m().mainZero(schema.target.text));
      return;
    }

    const hasMatch = full.length > 0 || partial.length > 0;

    if (!hasMatch && none.length > 0) {
      // [L] main exists but 0 conditions matched → show 参考 as fallback
      this.ui.showMessage(this._m().no_condition_match);
    }

    // 参考(none) is only shown when there is NO full/partial match (else too many).
    const displayNone = hasMatch ? [] : none;

    // Remember the SURFACED candidates (what the user actually sees as results) so that
    // "更に絞り込む" narrows within these — not within the full pre-evaluation pool.
    this._cache.surfaced = [...full, ...partial, ...displayNone];

    const conditionLabels = (schema.conditions ?? []).map(c => c.text ?? c.type);
    this.ui.showResults(full, partial, displayNone, null, conditionLabels);

    const M = this._m();
    let msg;
    if (!hasMatch) {
      msg = M.resultRefOnly(displayNone.length);
    } else if (full.length === 1) {
      msg = M.resultSingle(partial.length);
    } else {
      const goldCount = full.filter(c => c._tier === 'gold').length;
      const isFlat    = full.length > 1 && full[0]._tier === 'match';
      if (goldCount > 0)      msg = M.resultGold(goldCount, full.length, partial.length);
      else if (isFlat)        msg = M.resultFlat(full.length, partial.length);
      else                    msg = M.resultPlain(full.length, partial.length);
    }
    this.ui.showMessage(msg);
  }

  // ─────────────────────────────────────────────
  // [5][6] Feedback handling
  // ─────────────────────────────────────────────

  async _handleFeedback(schema, originalText) {
    const proximityLabel = (schema?.proximity?.anchors || []).map(a => a.text).filter(Boolean).join('・') || null;
    const action = await this.ui.showFeedback(proximityLabel);

    if (action === 'done') {
      this.ui.showMessage(this._m().confirmed);
      this._resetCache();
      return;
    }

    if (action !== 'narrow' && action !== 'research') return;

    // Both narrow and research take a hint and parse it as a delta.
    const hint = await this.ui.showHintInput(this._m().ask_hint);
    if (!hint) return;
    this.llm.resetStats?.();
    this._runStart = Date.now();

    const delta = await this.llm.parseRefinement(schema, hint);
    if (!delta) { this.ui.showMessage(this._m().error_communication); return; }
    const validTypes = SCHEMA_ENUMS.condition_type;
    const addConds = delta.add_conditions.filter(c => c && validTypes.includes(c.type));

    // ── narrow: filter WITHIN the already-surfaced Target candidates (pool fixed,
    // target NOT re-collected). Purely additive — only new conditions apply. ──
    if (action === 'narrow') {
      if (!addConds.length) { this.ui.showMessage(this._m().error_communication); return; }
      if (delta.confirmation) this.ui.showMessage(delta.confirmation);
      await this._narrowWithin(schema, addConds);
      return;
    }

    // ── research: surgically apply the full delta (add/remove/target/proximity) to
    // the existing schema and RE-SEARCH around the proximity (target re-collected). ──
    const merged = {
      ...schema,
      proximity:  schema.proximity,
      target:     schema.target,
      conditions: [...(schema.conditions || [])],
    };
    if (delta.new_target && delta.new_target.text) merged.target = { ...schema.target, ...delta.new_target };
    if (delta.new_proximity) merged.proximity = delta.new_proximity;
    if (delta.remove_condition_texts.length) {
      const rm = new Set(delta.remove_condition_texts);
      merged.conditions = merged.conditions.filter(c => !rm.has(c.text));
    }
    merged.conditions = [...merged.conditions, ...addConds];
    merged.confirmation = delta.confirmation;
    fillSchemaDefaults(merged, this.config.DEFAULT_LEVEL, Math.max(merged.conditions.length, this.config.MAX_CONDITIONS));

    if (!validateQuerySchema(merged).ok) { this.ui.showMessage(this._m().error_communication); return; }

    this._previousText = `${this._previousText}\n追加情報：${hint}`;
    this._dbgReport.schema = merged;
    if (delta.confirmation) this.ui.showMessage(delta.confirmation);

    await this._executeSearch(merged, this._previousText);
  }

  /**
   * "更に絞り込む": narrow WITHIN the candidates that REMAINED from the previous attempt
   * (the surfaced full+partial results — NOT the full pre-evaluation pool). Target is
   * NOT re-collected; only the new conditions are collected and this fixed subset is
   * re-evaluated/re-tiered. Consecutive narrows keep shrinking the previous remainder.
   */
  async _narrowWithin(schema, addConds) {
    // Pool = last surfaced results (remaining candidates). Fall back to mainCandidates
    // only if surfaced wasn't captured (shouldn't happen after a normal run).
    const pool = (this._cache.surfaced && this._cache.surfaced.length)
      ? this._cache.surfaced
      : this._cache.mainCandidates;
    if (!pool || !pool.length) { this.ui.showMessage(this._m().mainZero(schema.target?.text || '')); return; }

    const merged = { ...schema, conditions: [...(schema.conditions || []), ...addConds] };
    fillSchemaDefaults(merged, this.config.DEFAULT_LEVEL, Math.max(merged.conditions.length, this.config.MAX_CONDITIONS));
    this._cache.schema = merged;
    this._previousText = `${this._previousText}\n絞り込み：${addConds.map(c => c.text ?? c.type).join('、')}`;
    this._dbgReport = { schema: merged, proximity: this._dbgReport.proximity, target: this._dbgReport.target, conditions: [], categoryFilter: [], evaluation: null, excludedByHardFilter: [] };

    this.ui.clearResults?.();

    // Reuse the cached bbox; collect ONLY the new conditions (poi/point types).
    const bboxes = this._computeDualBbox(this._cache.bbox, merged);
    this._anchorRefM = Math.max(1, this._bboxWidthM(bboxes.targetBbox) / 2);

    const condResults = { ...(this._cache.condCandidates || {}) };
    const condDebug = [];
    for (const c of addConds) {
      const key = c.text ?? c.type;
      if (c.type === 'road' || c.type === 'water') { condDebug.push({ label: key, type: c.type, level: c.distance?.level, method: c.distance?.method, found: '候補ごと評価' }); continue; }
      const items = await this.mcp.collectCondition(c, bboxes.condBbox, null);
      condResults[key] = items;
      condDebug.push({ label: key, type: c.type, level: c.distance?.level, method: c.distance?.method, found: items.length });
    }
    // L2-1 category validity on the (new) poi conditions. Pool is fixed, so the target
    // filter is a cache-hit no-op; we keep the returned pool as-is. Do NOT overwrite
    // _cache.mainCandidates (that stays the full collected pool for a later re-search);
    // the narrow subset lives only in `keptPool` and is re-captured as `surfaced` below.
    const keptPool = await this._applyCategoryFilter(merged, pool, condResults);
    this._cache.condCandidates = condResults;
    this._dbgReport.conditions = [...(this._dbgReport.conditions || []), ...condDebug];

    // Evaluate with the FIXED pool (no target re-collection).
    this.mcp._evalPolygons = [];
    const results = await this._evaluate(merged, keptPool, condResults);
    this.ui.drawHits?.(keptPool);
    Object.values(condResults).forEach(items => this.ui.drawConditionHits?.(items));
    this.ui.drawPolygons?.(this.mcp._evalPolygons);
    this.ui.fitToBBox?.(bboxes.condBbox);
    this.ui.refreshCounts?.();

    const dbgRow = c => ({ name: c.name || '(名前なし)', score: c._matchInfo?.score ?? 0, tier: c._tier, rel: c._relevance, hit: c._matchInfo?.hit ?? 0, total: c._matchInfo?.total ?? 0, labels: c._matchInfo?.labels ?? [] });
    this._dbgReport.evaluation = { full: results.full.map(dbgRow), partial: results.partial.map(dbgRow), noneCount: results.none.length };

    this._showResults(results, merged);
    this.ui.showRunStats?.({ ms: Date.now() - (this._runStart || Date.now()), llm: this.llm.stats });
    this.ui.showDebugReport?.(this._dbgReport);

    await this._handleFeedback(merged, this._previousText);
  }

  // ─────────────────────────────────────────────
  // Cache (K — 3+1 granularity)
  // ─────────────────────────────────────────────

  _detectCacheInvalidation(newSchema) {
    const old = this._cache.schema;
    if (!old) return { bbox: true, candidates: true };

    const proximityChanged  = JSON.stringify(old.proximity)  !== JSON.stringify(newSchema.proximity);
    const targetChanged     = JSON.stringify(old.target)     !== JSON.stringify(newSchema.target);
    const conditionsChanged = JSON.stringify(old.conditions) !== JSON.stringify(newSchema.conditions);

    return {
      bbox:       proximityChanged,
      candidates: proximityChanged || targetChanged || conditionsChanged,
    };
  }

  _resetCache() {
    this._cache = { bbox: null, mainCandidates: null, condCandidates: null, surfaced: null, schema: null };
    this._clarifyCount = 0;
    this._previousText = null;
  }
}

// ─────────────────────────────────────────────
// Fixed UI text (systemdesign §5-3)
// ─────────────────────────────────────────────

const MESSAGES = {
  ja: {
    searching:            '候補を検索しています…',
    ask_proximity:        'どのあたりをお探しですか？地名や駅名を教えてください。',
    ask_target:           '何をお探しですか？',
    ask_hint:             'さらに絞り込む情報を教えてください（例：出口番号、近くの交差点名、建物の特徴など）。',
    confirmed:            'ありがとうございました。またお気軽にご相談ください。',
    welcome:              '探している場所を教えてください。近くの駅名・施設名・住所と、条件（近くのお店・道路など）を一緒に伝えていただくと絞り込めます。',
    no_condition_match:   '条件に完全一致する候補はありませんでしたが、候補を参考として地図に表示しています。',
    distance_too_far:     'その範囲は広すぎます。もっと近い目印を教えてください。',
    bbox_too_large:       'その範囲は広すぎます。もっと絞れる情報を教えてください。',
    proximity_too_broad:  'もう少し具体的な地名（町名・丁目等）か駅名を教えてください。',
    error_communication:  '通信エラーが発生しました。もう一度お試しください。',
    clarify_limit:        '情報が不足しています。分かる範囲で場所を教えてください。',
    not_a_query:          '場所の情報が読み取れませんでした。駅名・施設名・住所などと、探しているものを教えてください。（例：西大島駅の近くのマンション、バス停が目の前）',
    anchorNotFound:  t => `${t}が見つかりませんでした。別の地名や駅名をお試しください。`,
    whichArea:       t => `「${t}」はどちらですか？`,
    whichPoi:        t => `「${t}」はどれですか？`,
    genericMulti:    t => `「${t}」は複数あります。地名や駅名も一緒に教えてください。`,
    intersectionNotFound: t => `「${t}」という名前の交差点が見つかりませんでした。`,
    condNotFound:    k => `「${k}」はこのエリアで見つかりませんでした（地図データ未収録の可能性があります）。`,
    mainZero:        t => `${t}の近くに候補は見つかりませんでした。追加の情報を教えていただけますか？`,
    resultSingle: p => `条件に合う候補を1件特定しました${p > 0 ? `（部分マッチ：${p}件）` : ''}。`,
    resultGold:  (g, f, p) => `最有力${g}件を特定しました（全マッチ：${f}件、部分マッチ：${p}件）。金色マーカーが最も条件に近い候補です。`,
    resultFlat:  (f, p)    => `${f}件が同程度に条件を満たしています（部分マッチ：${p}件）。甲乙つけがたいため全て同格で表示します。`,
    resultPlain: (f, p)    => `${f + p}件見つかりました（全マッチ：${f}件、部分マッチ：${p}件）`,
    resultRefOnly: n       => `条件に一致する候補はありませんでしたが、範囲内の候補${n}件を参考として表示します。`,
  },
  en: {
    searching:            'Searching for candidates…',
    ask_proximity:        'Where should I look? Please give a place or station name.',
    ask_target:           'What are you looking for?',
    ask_hint:             'Add details to narrow it down (e.g. exit number, nearby intersection, building features).',
    confirmed:            'Thank you. Feel free to ask anytime.',
    welcome:              'Tell me the location you are looking for. Share a nearby station, facility, or address, plus conditions (nearby stores, roads, etc.).',
    no_condition_match:   'No candidate fully matched the conditions, but candidates are shown on the map for reference.',
    distance_too_far:     'That range is too wide. Please give a closer landmark.',
    bbox_too_large:       'That area is too large. Please provide something more specific.',
    proximity_too_broad:  'Please give a more specific place (town/block) or a station name.',
    error_communication:  'A communication error occurred. Please try again.',
    clarify_limit:        'Not enough information. Please tell me the location as best you can.',
    not_a_query:          "I couldn't read a location. Please give a station/facility/address and what you are looking for (e.g. a condo near Nishi-ojima station with a bus stop right in front).",
    anchorNotFound:  t => `Couldn't find "${t}". Please try another place or station name.`,
    whichArea:       t => `Which "${t}" do you mean?`,
    whichPoi:        t => `Which "${t}"?`,
    genericMulti:    t => `There are several "${t}". Please add a place or station name.`,
    intersectionNotFound: t => `No intersection named "${t}" was found.`,
    condNotFound:    k => `"${k}" wasn't found in this area (it may not be in the map data).`,
    mainZero:        t => `No "${t}" found nearby. Could you give more information?`,
    resultSingle: p => `Found 1 matching candidate${p > 0 ? ` (partial: ${p})` : ''}.`,
    resultGold:  (g, f, p) => `Identified ${g} top candidate(s) (full match: ${f}, partial: ${p}). The gold markers best fit the conditions.`,
    resultFlat:  (f, p)    => `${f} candidates match the conditions about equally (partial: ${p}). Shown as equals since none clearly stands out.`,
    resultPlain: (f, p)    => `Found ${f + p} (full match: ${f}, partial: ${p}).`,
    resultRefOnly: n       => `No candidate matched the conditions; showing ${n} in-area candidate(s) for reference.`,
  },
};
