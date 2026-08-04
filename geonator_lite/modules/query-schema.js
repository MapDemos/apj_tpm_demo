/**
 * QuerySchema — short-key expansion, default-value filler, for geonator_lite.
 *
 * Forked from geonator/modules/query-schema.js. Differences (spec §4, §9):
 * - L1 now emits SHORT keys (spec §4.3) to cut output tokens. `expandShortKeys()`
 *   below renames them back to the canonical field names BEFORE fillSchemaDefaults()
 *   runs, so the rest of the pipeline (and this file's own default-filling logic)
 *   is unchanged from geonator's canonical-key shape.
 * - No `interpretations` / `confirmation` / `unsupported_features` / `result_area`
 *   handling — L1 no longer emits them (spec §2, §4.1), so those fields are simply
 *   absent; nothing here references them.
 * - `not_a_query` was retired — L1 just omits `tgt` when there's nothing to search on,
 *   and the caller (query-engine.js) already treats a missing target.text as 0 results.
 * - validateQuerySchema() no longer requires proximity.anchors (geonator_lite
 *   allows proximity-less queries — spec §4.2 fallback path).
 */

const SCHEMA_ENUMS = {
  anchor_type:    ['station', 'poi', 'address', 'locality', 'intersection'],
  specificity:    ['unique', 'brand', 'generic'],
  query_intent:   ['category_mansion', 'category_apartment', 'category_building', 'poi', 'category_busstop', 'intersection', 'signal', 'transit_entrance'],
  condition_type: ['poi', 'road', 'water', 'rail', 'intersection', 'signal', 'transit_entrance', 'category_busstop'],
  // L1 の「地名寄りか施設寄りか」自己申告（Search Boxのtypesパラメータ選択専用 — query_intentとは別軸）。
  // 'ambiguous'（省略時の既定）は「鎌倉」のように地名／同名施設のどちらもあり得るケースの安全策で、
  // 従来の classifyQueryType の 'both' フォールバックと同じ意味（poi/place両方のtypesで検索する）。
  text_type:      ['poi', 'place', 'ambiguous'],
  distance_method: ['radius', 'isochrone'],
  distance_level: ['adjacent', 'roadside', 'very_close', 'nearby', 'somewhat_nearby', 'far'],
  profile:        ['walking', 'cycling', 'driving'],
  bearing_filter: ['north', 'south', 'east', 'west', null],
};

// ── Short-key expansion table (spec §4.3) ──
// Flat rename map: applied recursively to every object key in the raw L1 JSON,
// regardless of nesting depth (the spec's table is itself flat/context-free —
// e.g. "mn"/"mx" only ever appear inside target.floors, never colliding with
// proximity.within's "mnMi"/"mxMi"/"mxMe", so a single flat map is safe).
const L1_SHORT_KEY_MAP = {
  prox: 'proximity', anc: 'anchors', ty: 'type', tx: 'text', spc: 'specificity', sub: 'subtype',
  sc: 'scope', brg: 'bearing_filter', wi: 'within', pf: 'profile', pfi: 'profile_inferred',
  mnMi: 'minMinutes', mxMi: 'maxMinutes', mxMe: 'maxMeters', lv: 'level', tgt: 'target',
  qi: 'query_intent', tt: 'text_type', q: 'queries', fl: 'floors', v: 'value', mn: 'min', mx: 'max',
  ng: 'negate', cat: 'category_tag', cond: 'conditions', dir: 'direction', d: 'distance',
  m: 'method', mi: 'minutes', me: 'meters',
};

/**
 * Recursively rename short keys → canonical keys in a raw L1 JSON response.
 * Keys not in the map (already-canonical keys) pass through unchanged.
 * @param {*} node
 * @returns {*}
 */
function expandShortKeys(node) {
  if (Array.isArray(node)) return node.map(expandShortKeys);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const fullKey = Object.prototype.hasOwnProperty.call(L1_SHORT_KEY_MAP, k) ? L1_SHORT_KEY_MAP[k] : k;
      out[fullKey] = expandShortKeys(v);
    }
    return out;
  }
  return node;
}

/**
 * Validate a QuerySchema object. Returns { ok: true } or { ok: false, errors: string[] }.
 * Unlike geonator, proximity.anchors is NOT required (spec §4.2 — a proximity-less
 * query is valid and simply searches Search Box without a bias / skips Tilequery).
 * @param {object} schema
 * @returns {{ ok: boolean, errors?: string[] }}
 */
function validateQuerySchema(schema) {
  const errors = [];

  if (!schema || typeof schema !== 'object') {
    return { ok: false, errors: ['schema is not an object'] };
  }

  if (schema.proximity?.anchors) {
    schema.proximity.anchors.forEach((a, i) => {
      if (!SCHEMA_ENUMS.anchor_type.includes(a.type)) errors.push(`anchors[${i}].type invalid: ${a.type}`);
      if (!a.text || typeof a.text !== 'string')       errors.push(`anchors[${i}].text missing`);
      if (a.specificity && !SCHEMA_ENUMS.specificity.includes(a.specificity)) errors.push(`anchors[${i}].specificity invalid`);
    });
    if (schema.proximity.bearing_filter !== undefined &&
        !SCHEMA_ENUMS.bearing_filter.includes(schema.proximity.bearing_filter)) {
      errors.push(`bearing_filter invalid: ${schema.proximity.bearing_filter}`);
    }
  }

  if (schema.target && typeof schema.target === 'object') {
    if (schema.target.query_intent && !SCHEMA_ENUMS.query_intent.includes(schema.target.query_intent)) {
      errors.push(`target.query_intent invalid: ${schema.target.query_intent}`);
    }
    if (schema.target.text_type && !SCHEMA_ENUMS.text_type.includes(schema.target.text_type)) {
      errors.push(`target.text_type invalid: ${schema.target.text_type}`);
    }
  }

  if (schema.conditions && !Array.isArray(schema.conditions)) {
    errors.push('conditions must be an array');
  } else if (schema.conditions) {
    schema.conditions.forEach((c, i) => {
      if (!SCHEMA_ENUMS.condition_type.includes(c.type)) errors.push(`conditions[${i}].type invalid: ${c.type}`);
      if (c.text_type && !SCHEMA_ENUMS.text_type.includes(c.text_type)) errors.push(`conditions[${i}].text_type invalid: ${c.text_type}`);
      if (c.distance) {
        const d = c.distance;
        if (d.method && !SCHEMA_ENUMS.distance_method.includes(d.method)) errors.push(`conditions[${i}].distance.method invalid`);
        if (d.level  && !SCHEMA_ENUMS.distance_level.includes(d.level))   errors.push(`conditions[${i}].distance.level invalid`);
        if (d.profile && !SCHEMA_ENUMS.profile.includes(d.profile))       errors.push(`conditions[${i}].distance.profile invalid`);
      }
    });
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** Natural-feature target detection (road/rail "沿い" default radius selection). */
function isNaturalTarget(target) {
  const t = target?.text || '';
  return /(公園|河川|運河|河口|[^\p{L}]?川$|川沿|海岸|海辺|海$|湖|池|沼|山$|山沿|丘|緑地|森|林|浜|ビーチ|滝|湿地|干潟|庭園|渓谷|岬|水辺|堤防|土手)/u.test(t);
}

/**
 * Fill in default values for optional fields (mirrors geonator's fillSchemaDefaults,
 * minus result_area/unsupported_features which L1 no longer emits).
 * @param {object} schema
 * @param {string} defaultLevel
 * @param {number} maxConditions
 * @returns {object} mutated schema
 */
function fillSchemaDefaults(schema, defaultLevel = 'very_close', maxConditions = 3) {
  if (!schema) return schema;

  if (schema.proximity?.anchors) {
    for (const a of schema.proximity.anchors) {
      // specificity intentionally left unset when L1 omits it — 'unique'/'brand'/generic
      // (see prompt-l1.js), and _searchBoxLimitFor's default branch already treats
      // undefined the same as explicit 'generic'.
      if (!a.subtype) a.subtype = {};
    }
  }
  if (schema.proximity && schema.proximity.bearing_filter === undefined) schema.proximity.bearing_filter = null;
  if (schema.proximity && schema.proximity.scope === undefined) schema.proximity.scope = null;
  if (schema.proximity && schema.proximity.within === undefined) schema.proximity.within = null;
  if (schema.proximity?.within && typeof schema.proximity.within === 'object') {
    schema.proximity.within.profile_inferred = schema.proximity.within.profile_inferred === true;
  }

  if (schema.target) {
    if (!schema.target.query_intent) schema.target.query_intent = 'poi';
    if (!schema.target.text_type) schema.target.text_type = 'ambiguous';
    if (!Array.isArray(schema.target.queries) || schema.target.queries.length === 0) {
      schema.target.queries = schema.target.text ? [schema.target.text] : [];
    } else if (schema.target.text && !schema.target.queries.includes(schema.target.text)) {
      schema.target.queries.unshift(schema.target.text);
    }
    if (schema.target.floors && typeof schema.target.floors === 'object') {
      schema.target.floors.negate = schema.target.floors.negate === true;
    }
  }

  const cap = Number.isFinite(maxConditions) ? Math.max(0, Math.min(5, maxConditions)) : 3;
  if (Array.isArray(schema.conditions) && schema.conditions.length > cap) {
    schema.droppedConditionTexts = schema.conditions.slice(cap).map(c => c.text ?? c.type).filter(Boolean);
    schema.conditions = schema.conditions.slice(0, cap);
  } else {
    schema.droppedConditionTexts = [];
  }

  const roadRailDefaultLevel = isNaturalTarget(schema.target) ? 'very_close' : 'roadside';

  if (schema.conditions) {
    for (const c of schema.conditions) {
      const lineDefault = (c.type === 'road' || c.type === 'rail') ? roadRailDefaultLevel : defaultLevel;
      if (!c.distance) {
        c.distance = { method: 'radius', level: lineDefault, profile: null, profile_inferred: false, minutes: null, meters: null };
      } else {
        if (!c.distance.level)  c.distance.level  = lineDefault;
        if (!c.distance.method) c.distance.method = 'radius';
        c.distance.profile  = c.distance.profile  ?? null;
        c.distance.minutes  = c.distance.minutes  ?? null;
        c.distance.meters   = c.distance.meters   ?? null;
        c.distance.profile_inferred = c.distance.profile_inferred === true;
      }
      if ((c.type === 'road' || c.type === 'rail')
          && c.distance.meters == null && c.distance.minutes == null
          && ['nearby', 'somewhat_nearby', 'far'].includes(c.distance.level)) {
        c.distance.level = lineDefault;
      }
      if (!Array.isArray(c.queries) || c.queries.length === 0) {
        c.queries = c.text ? [c.text] : [];
      } else if (c.text && !c.queries.includes(c.text)) {
        c.queries.unshift(c.text);
      }
      if (c.type === 'poi' && !c.text_type) c.text_type = 'ambiguous';
      if (c.direction === undefined) c.direction = null;
      c.negate = c.negate === true;
    }
  }

  return schema;
}
