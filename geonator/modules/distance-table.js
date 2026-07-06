/**
 * Distance Table — single source of truth for all proximity/condition distances.
 * All numeric values (meters, minutes) live here. LLM only selects level/method labels.
 * Reference: systemdesign_20260704.md §6
 */

const DISTANCE_TABLE = {
  same_building:   { method: 'building_id', radius_m: null,  iso_min: null },
  // Thresholds are GENEROUS (avoid missing real matches — POI points are building
  // centroids, so "目の前" can be 30-50m by point distance). Scoring ranks the
  // truly-close ones to the top (gold), so a wide threshold no longer over-dilutes.
  adjacent:        { method: 'circle',      radius_m: 50,    iso_min: null }, // always circle, never isochrone
  very_close:      { method: 'both',        radius_m: 150,   iso_min: 2   },
  nearby:          { method: 'both',        radius_m: 400,   iso_min: 5   },
  somewhat_nearby: { method: 'both',        radius_m: 800,   iso_min: 10  },
  far:             { method: 'none',        radius_m: null,  iso_min: null }, // → pushback, not used as filter
};

/**
 * Resolve the actual radius (meters) or isochrone minutes for a distance object.
 * @param {object} distance - condition.distance from QuerySchema
 * @param {string} defaultLevel - CONFIG.DEFAULT_LEVEL
 * @returns {{ useIsochrone: boolean, radiusM: number|null, minutes: number|null, profile: string }}
 */
function resolveDistanceParams(distance, defaultLevel = 'very_close') {
  if (!distance) distance = {};

  const level  = distance.level  || defaultLevel;
  const method = distance.method || 'radius';
  const entry  = DISTANCE_TABLE[level];

  // Level-driven special cases first
  if (level === 'same_building' || entry?.method === 'building_id') {
    return { useBuildingId: true, level };
  }
  if (!entry || entry.method === 'none') {
    return { pushback: true, level };
  }

  // ── Explicit user-provided values override the table (any level) ──
  if (distance.meters != null) {
    return { useIsochrone: false, radiusM: distance.meters, minutes: null, profile: null, level };
  }
  if (distance.minutes != null) {
    return { useIsochrone: true, radiusM: null, minutes: distance.minutes, profile: distance.profile || 'walking', level };
  }

  // ── Table-driven ──
  // adjacent is always a circle (straight-line), never isochrone
  if (entry.method === 'circle' || level === 'adjacent') {
    return { useIsochrone: false, radiusM: entry.radius_m, minutes: null, profile: null, level };
  }
  if (method === 'isochrone') {
    return { useIsochrone: true, radiusM: null, minutes: entry.iso_min, profile: distance.profile || 'walking', level };
  }
  // radius (default)
  return { useIsochrone: false, radiusM: entry.radius_m, minutes: null, profile: null, level };
}

/**
 * Return the maximum radius_m among all conditions (used for condition bbox margin).
 * @param {Array} conditions - QuerySchema.conditions
 * @param {string} defaultLevel
 * @returns {number} margin in meters
 */
function maxConditionRadiusM(conditions, defaultLevel = 'very_close') {
  if (!conditions || conditions.length === 0) return 0;
  let max = 0;
  for (const c of conditions) {
    const p = resolveDistanceParams(c.distance, defaultLevel);
    const r = p.radiusM ?? (p.minutes ? p.minutes * 80 : 0); // 80m/min walking estimate
    if (r > max) max = r;
  }
  return max;
}
