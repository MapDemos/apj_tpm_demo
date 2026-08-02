/**
 * Spatial Utilities Module
 *
 * Pure geometry calculations using Turf.js (browser environment).
 * No API communication — all methods are synchronous spatial operations
 * on GeoJSON coordinates.
 *
 * Based on spec §3: バックエンド幾何学計算モジュール
 *
 * Requires: turf.js loaded via CDN (<script src="...turf.min.js">)
 */

class SpatialUtils {

  // ─────────────────────────────────────────────────────────────
  // A. 2駅の中間領域計算 (spec §3-A)
  // ─────────────────────────────────────────────────────────────

  /**
   * Calculate midpoint and BBOX between two coordinates.
   * Buffers the connecting line by 500m to create the search corridor.
   *
   * @param {number[]} coordA - [lng, lat] of place A
   * @param {number[]} coordB - [lng, lat] of place B
   * @returns {{ midpoint: number[], bbox: number[] }}
   */
  calculateMidpointBBOX(coordA, coordB) {
    const ptA      = turf.point(coordA);
    const ptB      = turf.point(coordB);
    const midpoint = turf.midpoint(ptA, ptB);
    const line     = turf.lineString([coordA, coordB]);
    const buffered = turf.buffer(line, 0.5, { units: 'kilometers' });
    const bbox     = turf.bbox(buffered);  // [minX, minY, maxX, maxY]
    return {
      midpoint: midpoint.geometry.coordinates,
      bbox,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // B. 角地判定 (spec §3-B)
  // ─────────────────────────────────────────────────────────────

  /**
   * Determine whether a POI sits on a street corner.
   * A corner is defined as: within 10m of ≥2 different roads AND
   * within 20m of their intersection node.
   *
   * @param {number[]} poiCoord - [lng, lat] of the POI
   * @param {object[]} roads    - Array of GeoJSON LineString features
   * @returns {{ isCorner: boolean, nearRoadCount: number, minIntersectionDistance: number }}
   */
  checkCornerProperty(poiCoord, roads) {
    if (!roads || roads.length < 2) return { isCorner: false };

    const poiPt        = turf.point(poiCoord);
    const roadDists    = [];
    const intersections = [];

    for (let i = 0; i < roads.length; i++) {
      try {
        roadDists.push(
          turf.pointToLineDistance(poiPt, roads[i], { units: 'meters' })
        );
      } catch (_) { /* malformed geometry */ }

      for (let j = i + 1; j < roads.length; j++) {
        try {
          turf.lineIntersect(roads[i], roads[j]).features
            .forEach(f => intersections.push(f.geometry.coordinates));
        } catch (_) {}
      }
    }

    const nearCount = roadDists.filter(d => d <= 10).length;
    if (nearCount < 2 || intersections.length === 0) return { isCorner: false };

    let minDist = Infinity;
    intersections.forEach(coord => {
      const d = turf.distance(poiPt, turf.point(coord), { units: 'meters' });
      if (d < minDist) minDist = d;
    });

    return {
      isCorner:                minDist <= 20,
      nearRoadCount:           nearCount,
      minIntersectionDistance: Math.round(minDist),
    };
  }

  // ─────────────────────────────────────────────────────────────
  // C. 「左右の見え方」からの進行方向逆算 (spec §3-C)
  // ─────────────────────────────────────────────────────────────

  /**
   * Calculate the user's travel bearing from a relative sighting
   * (e.g., "the store is on my left side").
   *
   * @param {number[]} P    - Store centroid [lng, lat]
   * @param {number[]} R    - Routable point on road [lng, lat]
   * @param {'left'|'right'} side - Which side the store appears on
   * @returns {{ storeBearing: number, userBearing: number, direction: string }}
   */
  calculateUserBearing(P, R, side) {
    const storeBearing = turf.bearing(turf.point(R), turf.point(P));
    const userBearing  = side === 'left'
      ? (storeBearing + 90  + 360) % 360
      : (storeBearing - 90  + 360) % 360;

    const compassDirs = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
    const direction   = compassDirs[Math.round(userBearing / 45) % 8];

    return {
      storeBearing: Math.round(storeBearing),
      userBearing:  Math.round(userBearing),
      direction,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // D. 「すぐ隣（間に建物なし）」判定 (spec §3-D)
  // ─────────────────────────────────────────────────────────────

  /**
   * Check whether two POIs are immediately adjacent (no building between them).
   * Uses a simple bounding-box scan: any building whose coordinate falls
   * strictly between the two POIs on both axes is treated as blocking.
   *
   * @param {number[]} baseCoord   - [lng, lat] of base POI
   * @param {number[]} targetCoord - [lng, lat] of target POI
   * @param {number[][]} buildings - Array of [lng, lat] building centroids
   * @returns {{ isImmediateNeighbor: boolean, blockingCount: number }}
   */
  checkImmediateNeighbor(baseCoord, targetCoord, buildings) {
    if (!buildings || buildings.length === 0) return { isImmediateNeighbor: true, blockingCount: 0 };

    const minLng = Math.min(baseCoord[0], targetCoord[0]);
    const maxLng = Math.max(baseCoord[0], targetCoord[0]);
    const minLat = Math.min(baseCoord[1], targetCoord[1]);
    const maxLat = Math.max(baseCoord[1], targetCoord[1]);

    const blocking = buildings.filter(([lng, lat]) =>
      lng > minLng && lng < maxLng && lat > minLat && lat < maxLat
    );

    return {
      isImmediateNeighbor: blocking.length === 0,
      blockingCount:       blocking.length,
    };
  }
}
