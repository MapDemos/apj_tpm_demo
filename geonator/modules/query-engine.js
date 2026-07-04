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
    this._cache = { bbox: null, mainCandidates: null, condCandidates: null, schema: null };
    this._clarifyCount = 0;
    this._previousText = null; // for L1 re-parse
  }

  // ─────────────────────────────────────────────
  // Entry point
  // ─────────────────────────────────────────────

  async run(userText) {
    this._previousText = userText;
    this._clarifyCount = 0;
    this._dbgReport = { schema: null, proximity: null, target: null, conditions: [], evaluation: null };
    this.llm.resetStats?.();
    this._runStart = Date.now();
    this.ui.clearResults();

    const schema = await this._parseAndValidate(userText, null);
    if (!schema) return; // clarification was handled inside

    this._dbgReport.schema = schema;
    await this._executeSearch(schema, userText);
  }

  // ─────────────────────────────────────────────
  // [2] L1 parse + [A] structural checks + [II] validate
  // ─────────────────────────────────────────────

  async _parseAndValidate(userText, previousText) {
    let schema;
    try {
      schema = await this.llm.parseQuery(userText, previousText);
    } catch (e) {
      this.ui.showMessage(UI_TEXT.error_communication);
      return null;
    }

    // Not a location query (greeting / chit-chat / no location clue) → guide the user
    const noLocationClue = !schema?.proximity?.anchors?.length && !schema?.target?.text;
    if (schema?.not_a_query || noLocationClue) {
      this.ui.showMessage(UI_TEXT.not_a_query);
      return null;
    }

    // [II] schema validation — malformed structure = treat as a real parse/comm issue
    const validation = validateQuerySchema(schema);
    if (!validation.ok) {
      console.warn('[QueryEngine] L1 schema invalid:', validation.errors);
      // If it lacks the essentials, it's more likely a non-query than a comm error.
      if (!schema?.proximity?.anchors?.length || !schema?.target?.text) {
        this.ui.showMessage(UI_TEXT.not_a_query);
      } else {
        this.ui.showMessage(UI_TEXT.error_communication);
      }
      return null;
    }

    fillSchemaDefaults(schema, this.config.DEFAULT_LEVEL);

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
      this.ui.showMessage(UI_TEXT.clarify_limit);
      return false;
    }
    this._clarifyCount++;

    switch (issue.kind) {
      case 'proximity_missing': {
        // [DD] Mode2 — ask for location
        const answer = await this.ui.showHintInput(UI_TEXT.ask_proximity);
        if (!answer) return false;
        const newSchema = await this._reparseMerged(answer);
        if (!newSchema) return false;
        Object.assign(schema, newSchema);
        return true;
      }
      case 'target_missing': {
        const answer = await this.ui.showHintInput(UI_TEXT.ask_target);
        if (!answer) return false;
        const newSchema = await this._reparseMerged(answer);
        if (!newSchema) return false;
        Object.assign(schema, newSchema);
        return true;
      }
      case 'distance_too_far': {
        // [4] level=far → pushback
        this.ui.showMessage(UI_TEXT.distance_too_far);
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
      fillSchemaDefaults(schema, this.config.DEFAULT_LEVEL);
      return schema;
    } catch {
      this.ui.showMessage(UI_TEXT.error_communication);
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
      this.ui.showSearching(UI_TEXT.searching);
      const bboxResult = await this._resolveProximity(schema);
      if (!bboxResult) return;
      this._cache.bbox = bboxResult;
      // Visualize resolved anchor points
      this.ui.drawProximityPoints?.(bboxResult.resolvedPoints);
    }

    // [3-A4] compute dual bbox (C-2)
    const bboxes = this._computeDualBbox(this._cache.bbox, schema);

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
        this.ui.showMessage(`${anchor.text}が見つかりませんでした。別の地名や駅名をお試しください。`);
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
        this.ui.showMessage(UI_TEXT.bbox_too_large);
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
      const chosen = await this.ui.showChoices(`「${anchor.text}」はどちらですか？`, choices.slice(0, 4));
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
      this.ui.showMessage(`「${anchor.text}」という名前の交差点が見つかりませんでした。`);
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
    let features = sbResult?.features || [];
    if (scopeBbox) features = features.filter(f => this._pointInBbox(f.geometry?.coordinates, scopeBbox));
    if (!features.length) return null;

    const radiusM = DISTANCE_TABLE.nearby.radius_m; // default extent around the anchor

    // Distinct candidate locations (a POI anchor can resolve to several — e.g. 3
    // コメダ). proximity MUST be a single point → disambiguate to 1 via buttons.
    const distinct = this._dedupByCoord(features);

    if (distinct.length > 1 && this._clarifyCount < this.config.MAX_CLARIFY_TURNS) {
      this._clarifyCount++;
      const choices = distinct.slice(0, 4).map(f =>
        `${f.properties.name}${f.properties.full_address ? '（' + f.properties.full_address + '）' : ''}`
      );
      const chosen = await this.ui.showChoices(`「${anchor.text}」はどれですか？`, choices);
      const idx = choices.indexOf(chosen);
      const f = distinct[idx >= 0 ? idx : 0];
      return [{ lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], radiusM }];
    }

    const feature = distinct[0];
    const ftype = feature.properties?.feature_type;
    // Only reject genuinely huge admin areas; a place (市/区) is acceptable as a
    // broad proximity (its bbox is used when available).
    if (['region', 'country'].includes(ftype)) {
      this.ui.showMessage(UI_TEXT.proximity_too_broad);
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
      this.ui.showMessage(UI_TEXT.clarify_limit);
      return;
    }
    this._clarifyCount++;
    this.ui.showMessage(`「${anchor.text}」は複数あります。地名や駅名も一緒に教えてください。`);
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

    // Target collection (tight bbox)
    let mainRaw = await this.mcp.collectTarget(target, targetBbox);
    mainRaw = this._applyBuildingNameRules(target, mainRaw);

    // Conditions collection (wide bbox) — parallel
    const condResults = {};
    const condDebug   = [];
    if (conditions?.length) {
      await Promise.all(conditions.map(async (c) => {
        const items = await this.mcp.collectCondition(c, condBbox);
        const key   = c.text ?? c.type;
        condResults[key] = items;
        condDebug.push({ label: key, type: c.type, level: c.distance?.level, method: c.distance?.method, found: items.length });
        // [S] note if condition returned 0 items
        if (!items || items.length === 0) {
          this.ui.showMessage(`「${key}」はこのエリアで見つかりませんでした（地図データ未収録の可能性があります）。`);
        }
      }));
    }

    // [3-B1] L2 relevance rating: remove mismatches, tag kept as exact/related
    const { kept, excludedNames } = await this._rateMain(target, mainRaw);

    // Debug: target + condition collection breakdown
    this._dbgReport.target = {
      intent:        this._buildIntentLabel(target),
      raw:           mainRaw.length,
      excluded:      excludedNames.length,
      excludedNames: excludedNames.slice(0, 40),
      kept:          kept.length,
    };
    this._dbgReport.conditions = condDebug;

    return { main: kept, conditions: condResults };
  }

  async _rateMain(target, candidates) {
    if (!candidates || candidates.length === 0) return { kept: [], excludedNames: [] };

    // L2 relevance rating (all target types). Coarse buckets for stability:
    // exact / mismatch(removed) / related(default). Batched + parallel (a single
    // call can't reliably rate 500+ building candidates).
    const intentLabel = this._buildIntentLabel(target);
    const BATCH = 40;
    const batches = [];
    for (let i = 0; i < candidates.length; i += BATCH) batches.push(candidates.slice(i, i + BATCH));

    const results = await Promise.all(batches.map(b =>
      this.llm.rateCandidates(intentLabel, b.map(c => ({ id: c.id, name: c.name ?? '' })))
    ));

    const exact = new Set(), mismatch = new Set();
    results.forEach(r => {
      if (!r) return; // failed batch → its candidates default to 'related', kept
      r.exact.forEach(id => exact.add(id));
      r.mismatch.forEach(id => mismatch.add(id));
    });

    const kept = [], excludedNames = [];
    for (const c of candidates) {
      const id = String(c.id);
      if (mismatch.has(id)) { excludedNames.push(c.name || '(名前なし)'); continue; }
      c._relevance = exact.has(id) ? 'exact' : 'related';
      kept.push(c);
    }
    return { kept, excludedNames };
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

    const conditions = schema.conditions ?? [];

    // conditionTracker: candidateId → { total, hit, closenessSum }
    const tracker = new Map();
    for (const c of mainCandidates) {
      tracker.set(String(c.id), { candidate: c, total: conditions.length, hit: 0, hitLabels: [], closenessSum: 0 });
    }

    const relMult = c => (c._relevance === 'exact' ? 1.0 : 0.5); // L2 relevance factor

    if (conditions.length === 0) {
      // No conditions — score = L2 relevance only (exact スーパー > related 八百屋).
      mainCandidates.forEach(c => {
        c._matchInfo = { hit: 0, total: 0, labels: [], score: +relMult(c).toFixed(3), relevance: c._relevance };
      });
      this._assignTiers(mainCandidates, [], []); // variance gate splits gold/silver by relevance
      mainCandidates.sort((a, b) => b._matchInfo.score - a._matchInfo.score);
      return { full: mainCandidates, partial: [], none: [] };
    }

    // reference reach per profile (m/min) for isochrone closeness approximation
    const speed = { walking: 80, cycling: 250, driving: 500 };

    // [FF] isochrone optimization: compute polygon once per anchor+level
    const isoCache = new Map();

    for (const cond of conditions) {
      const condKey = `${cond.text ?? cond.type}`;
      const condItems = condCandidates[condKey] ?? [];
      if (condItems.length === 0) continue; // 0-item condition → all miss (S already notified)

      const distParams = resolveDistanceParams(cond.distance, this.config.DEFAULT_LEVEL);
      const refM = distParams.radiusM
        ?? (distParams.minutes ? distParams.minutes * (speed[distParams.profile] || 80) : 250);

      for (const main of mainCandidates) {
        const { matched, nearestM } = await this.mcp.evaluateDistance(main, condItems, distParams, isoCache);
        if (matched) {
          const t = tracker.get(String(main.id));
          if (t) {
            t.hit++;
            t.hitLabels.push(cond.text ?? cond.type);
            // closeness ∈ [0,1]: 1 = right on top, 0 = at the threshold edge
            const closeness = nearestM != null ? Math.max(0, Math.min(1, 1 - nearestM / refM)) : 0.5;
            t.closenessSum += closeness;
          }
        }
      }
    }

    // Classify (OR — all displayed) + attach continuous score.
    // score = L2 relevance × condition proximity (exact スーパー near conditions
    // ranks above a related 八百屋 near the same conditions).
    const full = [], partial = [], none = [];
    for (const [, t] of tracker) {
      const condScore = t.hit > 0 ? t.closenessSum / t.hit : 0;
      const score = relMult(t.candidate) * condScore;
      t.candidate._matchInfo = { hit: t.hit, total: t.total, labels: t.hitLabels, score: +score.toFixed(3), relevance: t.candidate._relevance };
      if (t.hit === t.total)      full.push(t.candidate);
      else if (t.hit > 0)         partial.push(t.candidate);
      else                        none.push(t.candidate);
    }

    // Tiering with variance gate (JS, deterministic) — gold/silver only when the
    // full-match scores actually spread; otherwise everyone is equal ("同程度").
    this._assignTiers(full, partial, none);

    // Sort each class by score desc (best first)
    const byScore = (a, b) => (b._matchInfo.score - a._matchInfo.score);
    full.sort(byScore); partial.sort(byScore);

    return { full, partial, none };
  }

  /**
   * Assign _tier to candidates: 'gold' | 'silver' | 'match' | 'bronze' | 'none'.
   * - full matches: split gold/silver only if score spread ≥ EPS; else all 'match' (flat).
   * - partial → 'bronze', none → 'none'.
   */
  _assignTiers(full, partial, none) {
    const EPS = 0.2;        // score range below which we do NOT crown a winner
    const GOLD_BAND = 0.34; // top fraction of the range that earns gold

    if (full.length > 0) {
      const scores = full.map(c => c._matchInfo.score);
      const max = Math.max(...scores), min = Math.min(...scores);
      const range = max - min;
      if (range < EPS || full.length === 1) {
        // Flat: no meaningful winner → all equal (no dramatic gold)
        full.forEach(c => { c._tier = 'match'; c._flatTier = true; });
      } else {
        const goldCut = max - range * GOLD_BAND;
        full.forEach(c => { c._tier = c._matchInfo.score >= goldCut ? 'gold' : 'silver'; });
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
      this.ui.showMessage(`${schema.target.text}の近くに候補は見つかりませんでした。追加の情報を教えていただけますか？`);
      return;
    }

    const hasMatch = full.length > 0 || partial.length > 0;

    if (!hasMatch && none.length > 0) {
      // [L] main exists but 0 conditions matched → show 参考 as fallback
      this.ui.showMessage(UI_TEXT.no_condition_match);
    }

    // 参考(none) is only shown when there is NO full/partial match (else too many).
    const displayNone = hasMatch ? [] : none;

    const conditionLabels = (schema.conditions ?? []).map(c => c.text ?? c.type);
    this.ui.showResults(full, partial, displayNone, schema.unsupported, conditionLabels);

    let msg;
    if (!hasMatch) {
      msg = `条件に一致する候補はありませんでしたが、範囲内の候補${displayNone.length}件を参考として表示します。`;
    } else {
      const goldCount = full.filter(c => c._tier === 'gold').length;
      const isFlat    = full.length > 0 && full[0]._tier === 'match';
      if (goldCount > 0) {
        msg = `最有力${goldCount}件を特定しました（全マッチ：${full.length}件、部分マッチ：${partial.length}件）。金色マーカーが最も条件に近い候補です。`;
      } else if (isFlat) {
        msg = `${full.length}件が同程度に条件を満たしています（部分マッチ：${partial.length}件）。甲乙つけがたいため全て同格で表示します。`;
      } else {
        msg = `${full.length + partial.length}件見つかりました（全マッチ：${full.length}件、部分マッチ：${partial.length}件）`;
      }
    }
    this.ui.showMessage(msg);
  }

  // ─────────────────────────────────────────────
  // [5][6] Feedback handling
  // ─────────────────────────────────────────────

  async _handleFeedback(schema, originalText) {
    const action = await this.ui.showFeedback();

    switch (action) {
      case 'done':
        this.ui.showMessage(UI_TEXT.confirmed);
        this._resetCache();
        break;

      case 'continue': {
        // [6-2a] ask for hint
        const hint = await this.ui.showHintInput(UI_TEXT.ask_hint);
        if (!hint) break;

        // reset telemetry for this new search cycle
        this.llm.resetStats?.();
        this._runStart = Date.now();

        // [6-2b] re-parse (K)
        const newSchema = await this._reparseMerged(hint);
        if (!newSchema) break;

        // [6-2c] cache invalidation
        const invalid = this._detectCacheInvalidation(newSchema);
        if (invalid.bbox) this._cache.bbox = null;
        if (invalid.candidates) { this._cache.mainCandidates = null; this._cache.condCandidates = null; }

        await this._executeSearch(newSchema, this._previousText);
        break;
      }

      case 'restart':
        this._resetCache();
        this.ui.showMessage(UI_TEXT.welcome);
        break;
    }
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
    this._cache = { bbox: null, mainCandidates: null, condCandidates: null, schema: null };
    this._clarifyCount = 0;
    this._previousText = null;
  }
}

// ─────────────────────────────────────────────
// Fixed UI text (systemdesign §5-3)
// ─────────────────────────────────────────────

const UI_TEXT = {
  welcome:              '探している場所を教えてください。近くの駅名・施設名・住所と、条件（近くのお店・道路など）を一緒に伝えていただくと絞り込めます。',
  searching:            '候補を検索しています…',
  ask_proximity:        'どのあたりをお探しですか？地名や駅名を教えてください。',
  ask_target:           '何をお探しですか？',
  ask_hint:             'さらに絞り込む情報を教えてください（例：出口番号、近くの交差点名、建物の特徴など）。',
  confirmed:            'ありがとうございました。またお気軽にご相談ください。',
  no_condition_match:   '条件に完全一致する候補はありませんでしたが、候補を参考として地図に表示しています。',
  distance_too_far:     'その範囲は広すぎます。もっと近い目印を教えてください。',
  bbox_too_large:       'その範囲は広すぎます。もっと絞れる情報を教えてください。',
  proximity_too_broad:  'もう少し具体的な地名（町名・丁目等）か駅名を教えてください。',
  error_communication:  '通信エラーが発生しました。もう一度お試しください。',
  clarify_limit:        '情報が不足しています。分かる範囲で場所を教えてください。',
  not_a_query:          '場所の情報が読み取れませんでした。駅名・施設名・住所などと、探しているものを教えてください。（例：西大島駅の近くのマンション、バス停が目の前）',
};
