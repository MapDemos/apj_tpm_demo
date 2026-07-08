/**
 * QuerySchema — type definitions, validator, and default-value filler.
 * Reference: systemdesign_20260704.md §4
 */

const SCHEMA_ENUMS = {
  anchor_type:    ['station', 'poi', 'address', 'locality', 'intersection'],
  specificity:    ['specific', 'generic'],
  query_intent:   ['category_mansion', 'category_apartment', 'category_building', 'specific', 'category_busstop', 'category_busstop_location', 'intersection', 'signal'],
  condition_type: ['poi', 'road', 'water', 'rail', 'intersection', 'signal', 'transit_entrance', 'category_busstop'],
  distance_method: ['radius', 'isochrone'],
  distance_level: ['same_building', 'adjacent', 'roadside', 'very_close', 'nearby', 'somewhat_nearby', 'far'],
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
 * ターゲットが自然物（公園・川・海・山 等）か、テキストのキーワードで判定する。
 * query_intent には自然物カテゴリが無いためテキストで見る（取りこぼしは許容＝既定100m側に倒れる）。
 * road/rail「沿い」の既定半径を、自然物なら 150m(very_close)、それ以外(建物等)なら 100m(roadside) に振り分ける用。
 */
function isNaturalTarget(target) {
  const t = target?.text || '';
  return /(公園|河川|運河|河口|[^\p{L}]?川$|川沿|海岸|海辺|海$|湖|池|沼|山$|山沿|丘|緑地|森|林|浜|ビーチ|滝|湿地|干潟|庭園|渓谷|岬|水辺|堤防|土手)/u.test(t);
}

/**
 * Fill in default values for optional fields.
 * - distance with no level → level = CONFIG.DEFAULT_LEVEL
 * - conditions missing distance → default distance object
 * - road/rail conditions with no explicit distance → roadside(100m) / natural target なら very_close(150m)
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
  // proximity.within: 明示的な到達距離/時間（「駅から徒歩5分以内」「500m以内」）。
  // 指定があれば探索bboxをこの範囲で引く。曖昧な「近く/付近」は null（=既定半径）。
  if (schema.proximity && schema.proximity.within === undefined) {
    schema.proximity.within = null;
  }

  // target queries default (QE) → fall back to [text]
  if (schema.target) {
    if (!Array.isArray(schema.target.queries) || schema.target.queries.length === 0) {
      schema.target.queries = schema.target.text ? [schema.target.text] : [];
    } else if (schema.target.text && !schema.target.queries.includes(schema.target.text)) {
      schema.target.queries.unshift(schema.target.text); // ensure original is present
    }
    // floors.negate: 「N階建てではない/N階じゃない」の反転。既定 false。
    if (schema.target.floors && typeof schema.target.floors === 'object') {
      schema.target.floors.negate = schema.target.floors.negate === true;
    }
  }

  // Hard cap: at most `maxConditions` conditions (JS-side block, configurable 0-5).
  // Keeps scoring quality and LLM cost bounded; extras are dropped here.
  const cap = Number.isFinite(maxConditions) ? Math.max(0, Math.min(5, maxConditions)) : 3;
  if (Array.isArray(schema.conditions) && schema.conditions.length > cap) {
    // 上限超過で切り捨てた条件は捨てずに記録 → ユーザーに「今回の検索に含めていない」旨を通知する。
    schema.droppedConditionTexts = schema.conditions.slice(cap).map(c => c.text ?? c.type).filter(Boolean);
    schema.conditions = schema.conditions.slice(0, cap);
  } else {
    schema.droppedConditionTexts = [];
  }

  // road/rail「沿い」の既定レベル：建物ターゲットは roadside(100m)、自然物は very_close(150m)。
  // 明示距離（分/m や level）がある場合は尊重し、ここでは「未指定時の既定」だけを差し替える。
  const roadRailDefaultLevel = isNaturalTarget(schema.target) ? 'very_close' : 'roadside';

  // condition distance + queries defaults
  if (schema.conditions) {
    for (const c of schema.conditions) {
      const lineDefault = (c.type === 'road' || c.type === 'rail') ? roadRailDefaultLevel : defaultLevel;
      if (!c.distance) {
        c.distance = { method: 'radius', level: lineDefault, profile: null, minutes: null, meters: null };
      } else {
        if (!c.distance.level)  c.distance.level  = lineDefault;
        if (!c.distance.method) c.distance.method = 'radius';
        c.distance.profile  = c.distance.profile  ?? null;
        c.distance.minutes  = c.distance.minutes  ?? null;
        c.distance.meters   = c.distance.meters   ?? null;
      }
      // road/rail「沿い」: L1 が緩いレベル(nearby/somewhat_nearby/far)を付けても線路/道路沿いには
      // 広すぎるので既定(建物100m/自然物150m)へ締める。明示距離(m/分)と より近い明示レベル
      // (adjacent=すぐ隣 / very_close=すぐ近く)は尊重する。
      if ((c.type === 'road' || c.type === 'rail')
          && c.distance.meters == null && c.distance.minutes == null
          && ['nearby', 'somewhat_nearby', 'far'].includes(c.distance.level)) {
        c.distance.level = lineDefault;
      }
      // QE queries only for poi conditions; others use [text]
      if (!Array.isArray(c.queries) || c.queries.length === 0) {
        c.queries = c.text ? [c.text] : [];
      } else if (c.text && !c.queries.includes(c.text)) {
        c.queries.unshift(c.text);
      }
      if (c.direction === undefined) c.direction = null;
      // negate: 「〜が無い/入っていない/ではない」反転条件。既定は false（通常の「〜がある」）。
      c.negate = c.negate === true;
    }
  }

  // result_area: L1 sets true for vague "大体この辺" queries → JS draws an approximate
  // area (convex hull of candidates) instead of pinpointing a single spot.
  if (schema.result_area === undefined) schema.result_area = false;

  // unsupported_features: 数値化・地図化できない非地理的特徴（築浅・壁が赤い・ペット可等）を
  // L1が構造化して出す → JSが決定的に通知する（確認文の散文任せにしない）。文字列配列に正規化。
  schema.unsupported_features = Array.isArray(schema.unsupported_features)
    ? schema.unsupported_features.map(x => (typeof x === 'string' ? x : String(x?.text ?? ''))).filter(Boolean)
    : [];

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
