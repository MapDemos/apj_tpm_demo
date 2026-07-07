/**
 * QuerySchema — type definitions, validator, and default-value filler.
 * Reference: systemdesign_20260704.md §4
 */

const SCHEMA_ENUMS = {
  anchor_type:    ['station', 'poi', 'address', 'locality', 'intersection'],
  specificity:    ['specific', 'generic'],
  query_intent:   ['category_mansion', 'category_apartment', 'category_building', 'specific', 'category_busstop', 'category_busstop_location', 'intersection', 'signal'],
  condition_type: ['poi', 'road', 'water', 'intersection', 'signal', 'transit_entrance', 'category_busstop'],
  distance_method: ['radius', 'isochrone'],
  distance_level: ['same_building', 'adjacent', 'very_close', 'nearby', 'somewhat_nearby', 'far'],
  profile:        ['walking', 'cycling', 'driving'],
  bearing_filter: ['north', 'south', 'east', 'west', null],
};

/**
 * Validate a QuerySchema object. Returns { ok: true } or { ok: false, errors: string[] }.
 * @param {object} schema
 * @returns {{ ok: boolean, errors?: string[] }}
 */
function validateQuerySchema(schema) {
  const errors = [];

  if (!schema || typeof schema !== 'object') {
    return { ok: false, errors: ['schema is not an object'] };
  }

  // proximity
  if (!schema.proximity || !Array.isArray(schema.proximity.anchors) || schema.proximity.anchors.length === 0) {
    errors.push('proximity.anchors must be a non-empty array');
  } else {
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

  // target
  if (!schema.target || typeof schema.target !== 'object') {
    errors.push('target is required');
  } else {
    if (!schema.target.text || typeof schema.target.text !== 'string') errors.push('target.text missing');
    if (schema.target.query_intent && !SCHEMA_ENUMS.query_intent.includes(schema.target.query_intent)) {
      errors.push(`target.query_intent invalid: ${schema.target.query_intent}`);
    }
  }

  // conditions
  if (schema.conditions && !Array.isArray(schema.conditions)) {
    errors.push('conditions must be an array');
  } else if (schema.conditions) {
    schema.conditions.forEach((c, i) => {
      if (!SCHEMA_ENUMS.condition_type.includes(c.type)) errors.push(`conditions[${i}].type invalid: ${c.type}`);
      if (c.distance) {
        const d = c.distance;
        if (d.method && !SCHEMA_ENUMS.distance_method.includes(d.method)) errors.push(`conditions[${i}].distance.method invalid`);
        if (d.level  && !SCHEMA_ENUMS.distance_level.includes(d.level))   errors.push(`conditions[${i}].distance.level invalid`);
        if (d.profile && !SCHEMA_ENUMS.profile.includes(d.profile))       errors.push(`conditions[${i}].distance.profile invalid`);
        // guard: level=far → pushback (not a validation error but flagged)
      }
    });
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Fill in default values for optional fields.
 * - distance with no level → level = CONFIG.DEFAULT_LEVEL
 * - conditions missing distance → default distance object
 * @param {object} schema
 * @param {string} defaultLevel
 * @returns {object} mutated schema
 */
function fillSchemaDefaults(schema, defaultLevel = 'very_close', maxConditions = 3) {
  if (!schema) return schema;

  // anchor specificity default
  if (schema.proximity?.anchors) {
    for (const a of schema.proximity.anchors) {
      if (!a.specificity) a.specificity = 'specific';
      if (!a.subtype)     a.subtype = {};
    }
  }
  if (schema.proximity && schema.proximity.bearing_filter === undefined) {
    schema.proximity.bearing_filter = null;
  }
  if (schema.proximity && schema.proximity.scope === undefined) {
    schema.proximity.scope = null;
  }

  // target queries default (QE) → fall back to [text]
  if (schema.target) {
    if (!Array.isArray(schema.target.queries) || schema.target.queries.length === 0) {
      schema.target.queries = schema.target.text ? [schema.target.text] : [];
    } else if (schema.target.text && !schema.target.queries.includes(schema.target.text)) {
      schema.target.queries.unshift(schema.target.text); // ensure original is present
    }
  }

  // Hard cap: at most `maxConditions` conditions (JS-side block, configurable 0-5).
  // Keeps scoring quality and LLM cost bounded; extras are dropped here.
  const cap = Number.isFinite(maxConditions) ? Math.max(0, Math.min(5, maxConditions)) : 3;
  if (Array.isArray(schema.conditions) && schema.conditions.length > cap) {
    schema.conditions = schema.conditions.slice(0, cap);
  }

  // condition distance + queries defaults
  if (schema.conditions) {
    for (const c of schema.conditions) {
      if (!c.distance) {
        c.distance = { method: 'radius', level: defaultLevel, profile: null, minutes: null, meters: null };
      } else {
        if (!c.distance.level)  c.distance.level  = defaultLevel;
        if (!c.distance.method) c.distance.method = 'radius';
        c.distance.profile  = c.distance.profile  ?? null;
        c.distance.minutes  = c.distance.minutes  ?? null;
        c.distance.meters   = c.distance.meters   ?? null;
      }
      // QE queries only for poi conditions; others use [text]
      if (!Array.isArray(c.queries) || c.queries.length === 0) {
        c.queries = c.text ? [c.text] : [];
      } else if (c.text && !c.queries.includes(c.text)) {
        c.queries.unshift(c.text);
      }
      if (c.direction === undefined) c.direction = null;
    }
  }

  return schema;
}

/**
 * Structural validations that JS can check before any API call (layer A checks).
 * Returns array of clarification events needed, or empty array if OK.
 * @param {object} schema
 * @returns {Array<{kind: string, detail: object}>}
 */
function structuralChecks(schema) {
  const issues = [];

  // proximity missing → ask for location
  if (!schema.proximity?.anchors?.length) {
    issues.push({ kind: 'proximity_missing' });
    return issues; // can't continue without proximity
  }

  // target missing → ask
  if (!schema.target?.text) {
    issues.push({ kind: 'target_missing' });
  }

  // distance without condition object (orphaned distance) — rare, guard
  if (schema.conditions) {
    for (const c of schema.conditions) {
      if (c.distance?.level === 'far') {
        issues.push({ kind: 'distance_too_far', condition: c });
      }
      // distance has level/meters but no text (bizarre case — skip it)
    }
  }

  return issues;
}
