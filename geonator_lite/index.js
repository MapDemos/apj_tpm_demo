/**
 * geonator_lite demo app — map + search box + simplified settings form (spec §8.1).
 *
 * This file OWNS the map instance; geonator_lite's `searchPOI()` (modules/query-engine.js)
 * never touches the DOM or a map — it just takes `{lat,lng}` and returns a POI list
 * (spec §8: "地図の所有権は呼び出し元にある"). This is intentionally a thin, secondary
 * client of `searchPOI()` — the headless function is the actual deliverable.
 */

mapboxgl.accessToken = CONFIG.MAPBOX_ACCESS_TOKEN;

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/10da032y/cmp29b79d001601so7q6d07ls',
  center: CONFIG.DEFAULT_MAP_CENTER || [139.7671, 35.6812], // Tokyo
  zoom: 12,
});
map.addControl(new mapboxgl.NavigationControl(), 'top-left');

// コンソール(旧サイドバー)はハンバーガーで開閉するオーバーレイ。地図上には検索ボックスと
// ハンバーガーだけを常時表示し、それ以外(proximity/bbox/設定/結果一覧/ログ)はここに隠す。
const consoleEl = document.getElementById('console');
const consoleBackdrop = document.getElementById('consoleBackdrop');
function setConsoleOpen(open) {
  consoleEl.classList.toggle('open', open);
  consoleBackdrop.classList.toggle('open', open);
}
document.getElementById('consoleToggle').addEventListener('click', () => setConsoleOpen(!consoleEl.classList.contains('open')));
document.getElementById('consoleClose').addEventListener('click', () => setConsoleOpen(false));
consoleBackdrop.addEventListener('click', () => setConsoleOpen(false));

// 検索結果は mapboxgl.Marker(DOM)ではなく、circle(丸+番号) + symbol(名前ラベル)の
// レイヤーとして描画する。ズーム15以上でのみ名前ラベルを出したい要件がlayer側の
// minzoomでそのまま表現できるため、DOMマーカー+zoomイベント監視より素直な実装になる。
const RESULTS_LABEL_MINZOOM = 15;
let resultPopup = null;

// 直近の searchPOI() 結果の meta.log（L1出力・QuerySchema・段階ごとのヒット/間引き）— 処理ログモーダル用。
let lastLog = null;

// 1件のAPI呼び出しログを人間可読な行に整形（endpoint種別ごとにフィールドが違うため分岐）。
function formatApiCall(c, i) {
  const lines = [];
  const status = c.error ? `エラー: ${c.error}` : (c.capped ? 'スキップ(上限到達)' : (c.cacheHit ? 'キャッシュヒット' : 'OK'));
  if (c.api === 'search_box_forward') {
    lines.push(`[${i}] Search Box (forward)  q="${c.q}"  types=${c.types}${c.poiCategory ? `  poi_category=${c.poiCategory}` : ''}  limit=${c.limit}  ${status}`);
    lines.push(`      proximity=${c.proximity ? c.proximity.join(',') : '(なし)'}  bbox=${c.bbox ? c.bbox.map(n => n.toFixed(5)).join(',') : '(なし)'}`);
  } else if (c.api === 'search_box_category') {
    lines.push(`[${i}] Search Box (category)  canonical_id="${c.canonicalId}"  limit=${c.limit}${c.retrying ? '(→10で再試行)' : ''}  ${status}`);
    lines.push(`      proximity=${c.proximity ? c.proximity.join(',') : '(なし)'}  bbox=${c.bbox ? c.bbox.map(n => n.toFixed(5)).join(',') : '(なし)'}`);
  } else if (c.api === 'tilequery') {
    lines.push(`[${i}] Tilequery  目的="${c.purpose}"  tileset=${c.tileset}  layers=${c.layers}  radius=${c.radius}m  ${status}`);
    lines.push(`      中心=${c.lng?.toFixed?.(6)},${c.lat?.toFixed?.(6)}`);
  } else if (c.api === 'isochrone') {
    lines.push(`[${i}] Isochrone  目的="${c.purpose}"  profile=${c.profile}  minutes=${c.minutes}  ${c.found === false ? 'ポリゴン無し' : status}`);
    lines.push(`      中心=${c.lng?.toFixed?.(6)},${c.lat?.toFixed?.(6)}`);
    return lines;
  } else {
    lines.push(`[${i}] ${JSON.stringify(c)}`);
    return lines;
  }
  if (!c.error && !c.capped) {
    lines.push(`      → ${c.resultCount ?? 0}件` + (c.names?.length ? `: ${c.names.join(', ')}` : ''));
  }
  return lines;
}

function formatLog(log) {
  if (!log) return '(ログなし。「詳細ログを記録する」をONにして再検索してください)';
  const lines = [];
  lines.push('=== Query Schema（L1解析結果） ===');
  lines.push(JSON.stringify(log.schema, null, 2));
  lines.push('');
  lines.push('=== L1 生JSON（短縮キー） ===');
  lines.push(JSON.stringify(log.rawL1, null, 2));
  lines.push('');
  lines.push(`=== 個別API呼び出し（${(log.apiCalls || []).length}件・発生順） ===`);
  (log.apiCalls || []).forEach((c, i) => {
    formatApiCall(c, i + 1).forEach(l => lines.push(l));
    lines.push('');
  });
  lines.push('=== 収集〜L2の段階ごとの候補（ヒット / 間引き） ===');
  (log.stages || []).forEach(s => {
    lines.push(`--- [${s.group}] ${s.stage}（${s.count}件） ---`);
    s.names.forEach(n => lines.push(`  ○ ${n}`));
    if (s.droppedNames?.length) {
      lines.push(`  × 除外(${s.droppedNames.length}件):`);
      s.droppedNames.forEach(n => lines.push(`    - ${n}`));
    }
    lines.push('');
  });
  return lines.join('\n');
}

function openLogModal() {
  document.getElementById('logModalContent').textContent = formatLog(lastLog);
  document.getElementById('logModal').style.display = 'block';
}
function closeLogModal() { document.getElementById('logModal').style.display = 'none'; }

document.getElementById('logBtn').addEventListener('click', openLogModal);
document.getElementById('logModalClose').addEventListener('click', closeLogModal);
document.getElementById('logModal').addEventListener('click', (e) => { if (e.target.id === 'logModal') closeLogModal(); });

// proximity is explicitly set by clicking the map (no implicit map-center fallback) —
// unset means the request omits `proximity` entirely (spec §4.2 "no clue" path).
let proximityPoint = null;
let proximityMarker = null;

function renderProximityInfo() {
  const box = document.getElementById('proximityInfo');
  box.textContent = proximityPoint
    ? `${proximityPoint.lat.toFixed(6)}, ${proximityPoint.lng.toFixed(6)}`
    : '未指定';
}

// ターゲット(照準)風のSVGアイコン。既定のピン型マーカーだと「proximityは点そのもの」という
// 意味が伝わりにくいため、中心が正確にproximity座標を指す照準マークにする。
function createProximityMarkerElement() {
  const el = document.createElement('div');
  el.className = 'proximity-target-marker';
  el.innerHTML = `<svg viewBox="0 0 28 28" width="28" height="28">
    <circle cx="14" cy="14" r="9" fill="none" stroke="#0a5" stroke-width="2"/>
    <circle cx="14" cy="14" r="2.5" fill="#0a5"/>
    <line x1="14" y1="0" x2="14" y2="6" stroke="#0a5" stroke-width="2"/>
    <line x1="14" y1="22" x2="14" y2="28" stroke="#0a5" stroke-width="2"/>
    <line x1="0" y1="14" x2="6" y2="14" stroke="#0a5" stroke-width="2"/>
    <line x1="22" y1="14" x2="28" y2="14" stroke="#0a5" stroke-width="2"/>
  </svg>`;
  return el;
}

function setProximityPoint(lngLat) {
  proximityPoint = { lat: lngLat.lat, lng: lngLat.lng };
  if (proximityMarker) proximityMarker.remove();
  proximityMarker = new mapboxgl.Marker({ element: createProximityMarkerElement() })
    .setLngLat([lngLat.lng, lngLat.lat])
    .addTo(map);
  renderProximityInfo();
  updateBboxPreview();
}

function clearProximityPoint() {
  proximityPoint = null;
  if (proximityMarker) { proximityMarker.remove(); proximityMarker = null; }
  renderProximityInfo();
  updateBboxPreview();
}

map.on('click', (e) => setProximityPoint(e.lngLat));
document.getElementById('clearProximityBtn').addEventListener('click', clearProximityPoint);

// 検索範囲(bbox)。オフ／proximity中心の正方形／現在の画面表示領域／オート、の4択。
// square modeはproximity未指定だと中心が無いのでoff同然（bbox無しで検索）になる。
// autoはクエリの中身(proximity.within)に依存するため、ここではまだ実際の値を計算できない
// ('auto'という文字列のままrequestBodyに載せ、query-engine.js側でL1解析後に解決する)。
function computeBbox() {
  const mode = document.querySelector('input[name="bboxMode"]:checked')?.value || 'off';
  if (mode === 'auto') return 'auto';
  if (mode === 'square') {
    if (!proximityPoint) return null;
    const half = parseFloat(document.getElementById('bboxSquareM').value) / 2;
    if (!half || half <= 0) return null;
    const { lat, lng } = proximityPoint;
    const dLng = half / (111320 * Math.cos(lat * Math.PI / 180));
    const dLat = half / 110540;
    return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
  }
  if (mode === 'viewport') {
    const b = map.getBounds();
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  }
  return null; // off
}

// bboxがオン(どのモードでも)の間、実際に検索に使われる範囲を地図上に矩形表示する。
function bboxToPolygonFeature(bbox) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  return {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [[[minLng, minLat], [maxLng, minLat], [maxLng, maxLat], [minLng, maxLat], [minLng, minLat]]],
    },
  };
}

// autoモードは検索前は実際の矩形が分からないので、直近の検索結果(meta.usedBbox)を
// 代わりに表示する。renderResults()が検索のたびに更新する。
let lastAutoBbox = null;

function updateBboxPreview() {
  const source = map.getSource('bboxPreview');
  if (!source) return; // map style not loaded yet
  const bbox = computeBbox();
  const drawBbox = bbox === 'auto' ? lastAutoBbox : bbox;
  source.setData({
    type: 'FeatureCollection',
    features: (Array.isArray(drawBbox) && drawBbox.length === 4) ? [bboxToPolygonFeature(drawBbox)] : [],
  });
}

map.on('load', () => {
  map.addSource('bboxPreview', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'bboxPreviewFill', type: 'fill', source: 'bboxPreview',
    paint: { 'fill-color': '#3887be', 'fill-opacity': 0.08 },
  });
  map.addLayer({
    id: 'bboxPreviewLine', type: 'line', source: 'bboxPreview',
    paint: { 'line-color': '#3887be', 'line-width': 2, 'line-dasharray': [2, 2] },
  });
  updateBboxPreview();

  // 検索結果：赤丸(circle)+白文字の番号(symbol)は常時表示、名前ラベル(symbol)はzoom>=15だけ。
  map.addSource('results', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'resultsCircle', type: 'circle', source: 'results',
    paint: {
      'circle-radius': 13,
      'circle-color': '#d00',
      'circle-stroke-width': 2,
      'circle-stroke-color': '#fff',
    },
  });
  map.addLayer({
    id: 'resultsRank', type: 'symbol', source: 'results',
    layout: {
      'text-field': ['get', 'rank'],
      'text-size': 12,
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: { 'text-color': '#fff' },
  });
  map.addLayer({
    id: 'resultsLabel', type: 'symbol', source: 'results',
    minzoom: RESULTS_LABEL_MINZOOM,
    layout: {
      'text-field': ['get', 'name'],
      'text-size': 12,
      'text-anchor': 'left',
      'text-offset': [1.3, 0],
      'text-optional': true,
    },
    paint: {
      'text-color': '#1f2328',
      'text-halo-color': '#fff',
      'text-halo-width': 1.5,
    },
  });

  map.on('mouseenter', 'resultsCircle', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'resultsCircle', () => { map.getCanvas().style.cursor = ''; });
  map.on('click', 'resultsCircle', (e) => {
    const f = e.features[0];
    if (resultPopup) resultPopup.remove();
    resultPopup = new mapboxgl.Popup()
      .setLngLat(f.geometry.coordinates)
      .setText(`#${f.properties.rank} ${f.properties.name || ''} (score ${Number(f.properties.score).toFixed(3)})`)
      .addTo(map);
  });
});

// viewport modeは地図を動かすたびに実際の検索範囲が変わるので、パン/ズームのたびに再描画する。
// ただしユーザー操作由来のmoveだけに限定する(e.originalEventの有無で判定) —
// 検索後のfitBounds/結果クリック時のjumpToはプログラム側の移動で、これに反応すると
// 「直前に実際に検索した範囲」と表示中の矩形がずれて見える(検索後に矩形が勝手に動くバグ)。
map.on('move', (e) => { if (e.originalEvent) updateBboxPreview(); });
// ウィンドウ/コンテナのリサイズはユーザー操作でもoriginalEvent付きのmoveでもないため上の
// フィルタで漏れる。放置すると「リサイズ後に矩形が古いviewportのまま」になるので別途監視する。
map.on('resize', updateBboxPreview);

document.querySelectorAll('input[name="bboxMode"]').forEach(el => el.addEventListener('change', updateBboxPreview));
document.getElementById('bboxSquareM').addEventListener('input', updateBboxPreview);

function renderResults(resp) {
  const box = document.getElementById('results');
  const metaBox = document.getElementById('metaBox');
  box.innerHTML = '';
  if (resultPopup) { resultPopup.remove(); resultPopup = null; }

  const { results, meta } = resp;
  metaBox.textContent = `候補 ${meta.candidateCount} 件 / ${meta.elapsedMs}ms` + (meta.error ? ` / エラー: ${meta.error}` : '') + (meta.note ? ` / ${meta.note}` : '');
  document.getElementById('usageBox').textContent = formatUsage(meta.usage);

  // autoモード用: このリクエストで実際に使われたbbox(あれば)をプレビュー矩形に反映する。
  lastAutoBbox = meta.usedBbox || null;
  updateBboxPreview();

  lastLog = meta.log || null;
  document.getElementById('logBtn').disabled = !lastLog;

  const resultsSource = map.getSource('results');
  if (!results.length) {
    box.innerHTML = '<div class="result-item">該当なし（0件）</div>';
    if (resultsSource) resultsSource.setData({ type: 'FeatureCollection', features: [] });
    return;
  }

  const bounds = new mapboxgl.LngLatBounds();
  const features = [];
  results.forEach(r => {
    const div = document.createElement('div');
    div.className = 'result-item';
    div.innerHTML = `<span class="result-rank">#${r.rank}</span>${escapeHtml(r.name || '(名前なし)')}<span class="result-score">${r.score.toFixed(3)}</span>`;
    box.appendChild(div);

    if (r.lat != null && r.lng != null) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
        properties: { rank: r.rank, name: r.name || '(名前なし)', score: r.score },
      });
      bounds.extend([r.lng, r.lat]);
      div.addEventListener('click', () => map.jumpTo({ center: [r.lng, r.lat], zoom: 16 }));
    }
  });
  if (resultsSource) resultsSource.setData({ type: 'FeatureCollection', features });
  if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 60, maxZoom: 16, animate: false });
}

// Matrix API is never called by geonator_lite (anchorScore uses straight-line distance only,
// see IMPLEMENTATION_SPEC.md) — shown as a fixed "0" for completeness, not measured.
function formatUsage(usage) {
  if (!usage) return '';
  const t = usage.tokens || {};
  const tokLine = ['L1', 'L2']
    .map(role => {
      const r = t[role] || {};
      return `${role} 入${r.inTok ?? 0}/出${r.outTok ?? 0}` + (r.cacheRead ? `(cache${r.cacheRead})` : '');
    })
    .join(' ');
  const m = usage.mapbox || {};
  const apiLine = `Search Box ${m.searchBox ?? 0}回 / Tilequery ${m.tilequery ?? 0}回 / Isochrone ${m.isochrone ?? 0}回 / Matrix ${m.matrix ?? 0}回`;
  return `トークン: ${tokLine} | ${apiLine}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function readSettings() {
  return {
    model: document.getElementById('modelSelect').value,
    judge: {
      weights: {
        relevance: parseFloat(document.getElementById('wRelevance').value),
        condition: parseFloat(document.getElementById('wCondition').value),
        anchor:    parseFloat(document.getElementById('wAnchor').value),
      },
    },
  };
}

['wRelevance', 'wCondition', 'wAnchor'].forEach(id => {
  const input = document.getElementById(id);
  const out = document.getElementById(id + 'Val');
  input.addEventListener('input', () => { out.textContent = parseFloat(input.value).toFixed(2); });
});

async function runSearch() {
  const text = document.getElementById('queryInput').value.trim();
  const errorBox = document.getElementById('errorBox');
  errorBox.style.display = 'none';
  if (!text) return;

  const settings = readSettings();
  const requestBody = {
    text,
    model: settings.model,
    judge: settings.judge,
    debugLog: document.getElementById('debugLogToggle').checked,
  };
  if (proximityPoint) requestBody.proximity = proximityPoint;
  const bbox = computeBbox();
  if (bbox) requestBody.bbox = bbox;

  document.getElementById('searchBtn').disabled = true;
  try {
    const resp = await searchPOI(requestBody);
    renderResults(resp);
  } catch (e) {
    errorBox.style.display = 'block';
    errorBox.textContent = e?.message || String(e);
  } finally {
    document.getElementById('searchBtn').disabled = false;
  }
}

document.getElementById('searchBtn').addEventListener('click', runSearch);
document.getElementById('queryInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
