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
    this.ui.clearResults();

    const schema = await this._parseAndValidate(userText, null);
    if (!schema) return; // clarification was handled inside

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

    // [II] schema validation
    const validation = validateQuerySchema(schema);
    if (!validation.ok) {
      console.warn('[QueryEngine] L1 schema invalid:', validation.errors);
      // retry already done inside LLMClient; treat as communication error
      this.ui.showMessage(UI_TEXT.error_communication);
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
    const combined = `${this._previousText}\n追加情報：${additionalText}`;
    this._previousText = combined;
    try {
      const schema = await this.llm.parseQuery(additionalText, this._previousText);
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
    // Determine which cache layers to reuse (K)
    const cacheInvalid = this._detectCacheInvalidation(schema);
    this._cache.schema = schema;

    // [3-A] resolve proximity → bbox (unless cached)
    if (cacheInvalid.bbox) {
      this.ui.showSearching(UI_TEXT.searching);
      const bboxResult = await this._resolveProximity(schema);
      if (!bboxResult) return;
      this._cache.bbox = bboxResult;
    }

    // [3-A4] compute dual bbox (C-2)
    const bboxes = this._computeDualBbox(this._cache.bbox, schema);

    // [3-B] collect candidates (unless cached)
    if (cacheInvalid.candidates) {
      const collected = await this._collectCandidates(schema, bboxes);
      if (!collected) return;
      this._cache.mainCandidates = collected.main;
      this._cache.condCandidates = collected.conditions;
    }

    // [3-C] evaluate
    const results = await this._evaluate(schema, this._cache.mainCandidates, this._cache.condCandidates);

    // [4] show results
    this._showResults(results, schema);

    // [5] feedback
    await this._handleFeedback(schema, originalText);
  }

  // ─────────────────────────────────────────────
  // [3-A] proximity resolution
  // ─────────────────────────────────────────────

  async _resolveProximity(schema) {
    const anchors = schema.proximity.anchors;
    const resolvedPoints = [];

    for (const anchor of anchors) {
      // [B1] generic check — only for anchor, not target (§4-3)
      if (anchor.specificity === 'generic' && anchors.length === 1) {
        await this._clarifyGenericAnchor(anchor);
        return null; // re-entry will happen from feedback loop
      }

      const points = await this._resolveAnchor(anchor);
      if (!points || points.length === 0) {
        this.ui.showMessage(`${anchor.text}が見つかりませんでした。別の地名や駅名をお試しください。`);
        return null;
      }
      resolvedPoints.push(...points);
    }

    // [AA] compute base bbox from all resolved points
    let bbox = this.mcp.resolveBBox({ points: resolvedPoints, marginM: 0 });

    // span upper limit check (EE/§6-3)
    if (this._bboxExceedsLimit(bbox)) {
      this.ui.showMessage(UI_TEXT.bbox_too_large);
      return null;
    }

    // [3-A3] bearing filter
    if (schema.proximity.bearing_filter) {
      bbox = this._applyBearingCut(bbox, schema.proximity.bearing_filter);
    }

    return { bbox, resolvedPoints };
  }

  async _resolveAnchor(anchor) {
    switch (anchor.type) {
      case 'station':
        return await this._resolveStation(anchor);
      case 'locality':
        return await this._resolveLocality(anchor);
      case 'poi':
      case 'address':
        return await this._resolvePoiOrAddress(anchor);
      default:
        return null;
    }
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

    // No exit specified → span all entrances
    if (entrances.length > 0) {
      return entrances.map(e => ({ lng: e.lng, lat: e.lat }));
    }

    // Fallback: use station representative coordinate
    return [{ lng: stationCoord[0], lat: stationCoord[1], radiusM: DISTANCE_TABLE.nearby.radius_m }];
  }

  async _resolveLocality(anchor) {
    const sbResult = await this.mcp.searchBox(anchor.text, { types: 'place,locality,neighborhood,district' });
    if (!sbResult?.features?.length) return null;

    const features = sbResult.features;

    // [B2] multiple distinct localities → Mode1 button
    const distinct = this._filterDistinctLocalities(features);
    if (distinct.length > 1 && this._clarifyCount < this.config.MAX_CLARIFY_TURNS) {
      this._clarifyCount++;
      const choices = distinct.map(f => f.properties.full_address || f.properties.name);
      const chosen = await this.ui.showChoices(
        `「${anchor.text}」はどちらですか？`,
        choices.slice(0, 4)
      );
      const idx = choices.indexOf(chosen);
      const feature = distinct[idx >= 0 ? idx : 0];
      return [this._featureToBboxPoint(feature)];
    }

    return [this._featureToBboxPoint(features[0])];
  }

  async _resolvePoiOrAddress(anchor) {
    const sbResult = await this.mcp.searchBox(anchor.text, { types: 'poi,address,place,locality' });
    if (!sbResult?.features?.length) return null;

    const feature = sbResult.features[0];
    const coord   = feature.geometry.coordinates;
    const radiusM = DISTANCE_TABLE.nearby.radius_m; // default extent

    // guard: too broad (place/region/country) → ask for more detail
    const ftype = feature.properties?.feature_type;
    if (['region', 'country', 'district'].includes(ftype)) {
      this.ui.showMessage(UI_TEXT.proximity_too_broad);
      return null;
    }

    return [{ lng: coord[0], lat: coord[1], radiusM }];
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
    const mainRaw = await this.mcp.collectTarget(target, targetBbox);

    // Conditions collection (wide bbox) — parallel
    const condResults = {};
    if (conditions?.length) {
      await Promise.all(conditions.map(async (c) => {
        const items = await this.mcp.collectCondition(c, condBbox);
        condResults[c.text ?? c.type] = items;
        // [S] note if condition returned 0 items
        if (!items || items.length === 0) {
          this.ui.showMessage(`「${c.text ?? c.type}」はこのエリアで見つかりませんでした（地図データ未収録の可能性があります）。`);
        }
      }));
    }

    // [3-B1] noise removal: prefix filter (JS) + L2 (LLM)
    const mainFiltered = await this._denoiseMain(target, mainRaw);

    return { main: mainFiltered, conditions: condResults };
  }

  async _denoiseMain(target, candidates) {
    if (!candidates || candidates.length === 0) return [];

    // 1. prefix filter for specific POI
    let filtered = candidates;
    if (target.query_intent === 'specific' && target.text) {
      filtered = candidates.filter(c =>
        !c.name || c.name.startsWith(target.text) || target.text.startsWith(c.name.slice(0, 4))
      );
    }

    // 2. L2 negative filter (all candidates — B)
    const slim = filtered.map(c => ({ id: c.id, name: c.name ?? '' }));
    const excludeIds = await this.llm.filterCandidates(target, slim);
    const excludeSet = new Set(excludeIds.map(String));
    return filtered.filter(c => !excludeSet.has(String(c.id)));
  }

  // ─────────────────────────────────────────────
  // [3-C] Step2: evaluate distances
  // ─────────────────────────────────────────────

  async _evaluate(schema, mainCandidates, condCandidates) {
    if (!mainCandidates || mainCandidates.length === 0) {
      return { full: [], partial: [], none: [] };
    }

    const conditions = schema.conditions ?? [];

    // conditionTracker: candidateId → { total, hit }
    const tracker = new Map();
    for (const c of mainCandidates) {
      tracker.set(String(c.id), { candidate: c, total: conditions.length, hit: 0, hitLabels: [] });
    }

    if (conditions.length === 0) {
      // No conditions — all are "full" by default
      return {
        full:    mainCandidates,
        partial: [],
        none:    [],
      };
    }

    // [FF] isochrone optimization: group by (level+method+profile+minutes) → compute once
    const isoCache = new Map();

    for (const cond of conditions) {
      const condKey = `${cond.text ?? cond.type}`;
      const condItems = condCandidates[condKey] ?? [];
      if (condItems.length === 0) continue; // 0-item condition → all miss (S already notified)

      const distParams = resolveDistanceParams(cond.distance, this.config.DEFAULT_LEVEL);

      for (const main of mainCandidates) {
        const inside = await this.mcp.evaluateDistance(
          main, condItems, distParams, isoCache
        );
        if (inside) {
          const t = tracker.get(String(main.id));
          if (t) { t.hit++; t.hitLabels.push(cond.text ?? cond.type); }
        }
      }
    }

    // Classify (I — OR, all displayed)
    const full    = [];
    const partial = [];
    const none    = [];

    for (const [, t] of tracker) {
      t.candidate._matchInfo = { hit: t.hit, total: t.total, labels: t.hitLabels };
      if (t.hit === t.total)      full.push(t.candidate);
      else if (t.hit > 0)         partial.push(t.candidate);
      else                        none.push(t.candidate);
    }

    return { full, partial, none };
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

    if (full.length === 0 && partial.length === 0 && none.length > 0) {
      // [L] main exists but 0 conditions matched
      this.ui.showMessage(UI_TEXT.no_condition_match);
    }

    const conditionLabels = (schema.conditions ?? []).map(c => c.text ?? c.type);
    this.ui.showResults(full, partial, none, schema.unsupported, conditionLabels);

    const msg = `${totalMain}件見つかりました（全マッチ：${full.length}件、部分マッチ：${partial.length}件、参考：${none.length}件）`;
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
};
