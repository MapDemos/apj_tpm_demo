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

// コンソール(旧サイドバー)はハンバーガーで開閉するオーバーレイ。地図上にはヘッダー・検索ボックス・
// ハンバーガーだけを常時表示し、それ以外(proximity/bbox/設定/結果一覧/ログ)はここに隠す。
// ズーム/方角ボタン(NavigationControl)は廃止（ピンチ/スクロールでズーム操作は可能）。
const consoleEl = document.getElementById('console');
const consoleBackdrop = document.getElementById('consoleBackdrop');
function setConsoleOpen(open) {
  consoleEl.classList.toggle('open', open);
  consoleBackdrop.classList.toggle('open', open);
}
document.getElementById('consoleToggle').addEventListener('click', () => setConsoleOpen(!consoleEl.classList.contains('open')));
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
// bboxMode/bboxSquareMは引数で受け取る（DOM直読みにしない）——設定がJSON編集モードの
// 時は、非表示のGUI input要素ではなくJSONの値を正としたいため（readSettings()参照）。
function computeBbox(bboxMode, bboxSquareM) {
  const mode = bboxMode || 'off';
  if (mode === 'auto') return 'auto';
  if (mode === 'square') {
    if (!proximityPoint) return null;
    const half = (parseFloat(bboxSquareM) || 0) / 2;
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
// ※表示するかどうかは「bboxを地図上に表示する」設定(既定オフ)で別途ゲートする——
// これはbboxMode自体（実際の検索に使うbbox値。requestBody.bboxに載る）とは独立した、
// 純粋にUI側の可視化トグル。オフでもbboxMode('auto'等)による検索自体の絞り込みは動く。
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
  const showPreview = document.getElementById('showBboxPreview').checked;
  let bbox = null;
  if (showPreview) {
    // JSON編集中に構文が壊れていることがあるので、プレビュー更新では例外を投げず単に
    // 何も描かない(検索実行時のエラー表示はrunSearch/openRequestModal側の責務)。
    try {
      const settings = readSettings();
      bbox = computeBbox(settings.bboxMode, settings.bboxSquareM);
    } catch (e) { bbox = null; }
  }
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
    const scoreText = f.properties.score != null ? ` (score ${Number(f.properties.score).toFixed(3)})` : '';
    resultPopup = new mapboxgl.Popup()
      .setLngLat(f.geometry.coordinates)
      .setText(`#${f.properties.rank} ${f.properties.name || ''}${scoreText}`)
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
document.getElementById('showBboxPreview').addEventListener('change', updateBboxPreview);

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
    const scoreHtml = r.score != null ? `<span class="result-score">${r.score.toFixed(3)}</span>` : '';
    div.innerHTML = `<span class="result-rank">#${r.rank}</span>${escapeHtml(r.name || '(名前なし)')}${scoreHtml}`;
    box.appendChild(div);

    if (r.lat != null && r.lng != null) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
        properties: { rank: r.rank, name: r.name || '(名前なし)', score: r.score ?? null },
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

// 「リクエストパラメータ」タブはGUI(スライダー等)とJSON(直接編集)の2ビューを切り替えられる。
// どちらも同じreadSettings()の戻り値の形(proximity/model/judge.weights/bboxMode/bboxSquareM
// /debugLog——いずれもrequestBody構築に使う値。「UI設定」タブのshowBboxPreviewは含まない、
// あれはリクエストに載らないUI専用の値のため)を表現する。値の実体は常にGUI側のinput要素・
// proximityPoint変数に持たせ、JSONビューはその読み書き用の別表現として扱う(GUI→JSON切り替え
// 時にシリアライズ、JSON→GUI切り替え時にパースしてGUIへ反映)。
function readSettingsFromGui() {
  return {
    proximity: proximityPoint ? { lat: proximityPoint.lat, lng: proximityPoint.lng } : null,
    model: document.getElementById('modelSelect').value,
    judge: {
      weights: {
        relevance: parseFloat(document.getElementById('wRelevance').value),
        condition: parseFloat(document.getElementById('wCondition').value),
        anchor:    parseFloat(document.getElementById('wAnchor').value),
      },
    },
    bboxMode: document.querySelector('input[name="bboxMode"]:checked')?.value || 'off',
    bboxSquareM: parseFloat(document.getElementById('bboxSquareM').value) || 2000,
    debugLog: document.getElementById('debugLogToggle').checked,
  };
}

/** JSONの値をGUI側のinput要素に反映する。想定外の形は例外を投げる(呼び出し側でエラー表示)。 */
function applySettingsToGui(settings) {
  if (!settings || typeof settings !== 'object') throw new Error('設定はオブジェクトである必要があります');
  const modelSelect = document.getElementById('modelSelect');
  if (settings.model != null) {
    if (![...modelSelect.options].some(o => o.value === settings.model)) {
      throw new Error(`model の値が不正です: ${settings.model}`);
    }
    modelSelect.value = settings.model;
  }
  if (settings.bboxMode != null) {
    const validModes = ['off', 'square', 'viewport', 'auto'];
    if (!validModes.includes(settings.bboxMode)) throw new Error(`bboxMode の値が不正です: ${settings.bboxMode}`);
    const radio = document.querySelector(`input[name="bboxMode"][value="${settings.bboxMode}"]`);
    if (radio) radio.checked = true;
  }
  if (settings.bboxSquareM != null) {
    const n = Number(settings.bboxSquareM);
    if (!Number.isFinite(n) || n <= 0) throw new Error('bboxSquareM は正の数値である必要があります');
    document.getElementById('bboxSquareM').value = n;
  }
  if (settings.debugLog != null) {
    document.getElementById('debugLogToggle').checked = !!settings.debugLog;
  }
  if ('proximity' in settings) {
    if (settings.proximity == null) {
      clearProximityPoint();
    } else {
      const { lat, lng } = settings.proximity;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('proximity は {lat, lng} の数値である必要があります');
      setProximityPoint({ lat, lng });
    }
  }
  const w = settings.judge?.weights || {};
  for (const [key, id] of [['relevance', 'wRelevance'], ['condition', 'wCondition'], ['anchor', 'wAnchor']]) {
    if (w[key] == null) continue;
    const n = Number(w[key]);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`judge.weights.${key} は0〜1の数値である必要があります`);
    document.getElementById(id).value = n;
    document.getElementById(id + 'Val').textContent = n.toFixed(2);
  }
}

const settingsGuiView = document.getElementById('settingsGuiView');
const settingsJsonView = document.getElementById('settingsJsonView');
const settingsModeGuiBtn = document.getElementById('settingsModeGuiBtn');
const settingsModeJsonBtn = document.getElementById('settingsModeJsonBtn');
const settingsJsonInput = document.getElementById('settingsJsonInput');
const settingsJsonError = document.getElementById('settingsJsonError');
let settingsMode = 'gui';

function showSettingsJsonError(msg) {
  settingsJsonError.textContent = msg;
  settingsJsonError.style.display = msg ? 'block' : 'none';
}

function switchToJsonView() {
  settingsJsonInput.value = JSON.stringify(readSettingsFromGui(), null, 2);
  showSettingsJsonError('');
  settingsMode = 'json';
  settingsGuiView.style.display = 'none';
  settingsJsonView.style.display = '';
  settingsModeGuiBtn.classList.remove('active');
  settingsModeJsonBtn.classList.add('active');
}

/** @returns {boolean} 成功したか(JSONが不正なら失敗しGUIに戻らない) */
function switchToGuiView() {
  let parsed;
  try {
    parsed = JSON.parse(settingsJsonInput.value);
  } catch (e) {
    showSettingsJsonError(`JSONとして読めません: ${e.message}`);
    return false;
  }
  try {
    applySettingsToGui(parsed);
  } catch (e) {
    showSettingsJsonError(e.message);
    return false;
  }
  showSettingsJsonError('');
  settingsMode = 'gui';
  settingsGuiView.style.display = '';
  settingsJsonView.style.display = 'none';
  settingsModeJsonBtn.classList.remove('active');
  settingsModeGuiBtn.classList.add('active');
  return true;
}

settingsModeJsonBtn.addEventListener('click', () => { if (settingsMode !== 'json') switchToJsonView(); });
settingsModeGuiBtn.addEventListener('click', () => { if (settingsMode === 'json') switchToGuiView(); });

// 設定タブ：「検索結果」(debugLogToggleのような結果表示・ログ記録の値。リクエストには載らない)、
// 「リクエストパラメータ」(searchPOI()のrequestBodyに載る値。上のGUI/JSON切替対象)、
// 「UI設定」(showBboxPreviewのようなUI専用の値。リクエストには載らない)の3つを分ける。
const settingsTabResult = document.getElementById('settingsTabResult');
const settingsTabRequest = document.getElementById('settingsTabRequest');
const settingsTabFrontend = document.getElementById('settingsTabFrontend');
const settingsTopTabResultBtn = document.getElementById('settingsTopTabResultBtn');
const settingsTopTabRequestBtn = document.getElementById('settingsTopTabRequestBtn');
const settingsTopTabFrontendBtn = document.getElementById('settingsTopTabFrontendBtn');

const settingsTopTabs = [
  { btn: settingsTopTabResultBtn, panel: settingsTabResult },
  { btn: settingsTopTabRequestBtn, panel: settingsTabRequest },
  { btn: settingsTopTabFrontendBtn, panel: settingsTabFrontend },
];
function activateSettingsTopTab(active) {
  for (const { btn, panel } of settingsTopTabs) {
    const isActive = btn === active;
    panel.style.display = isActive ? '' : 'none';
    btn.classList.toggle('active', isActive);
  }
}
settingsTopTabResultBtn.addEventListener('click', () => activateSettingsTopTab(settingsTopTabResultBtn));
settingsTopTabRequestBtn.addEventListener('click', () => activateSettingsTopTab(settingsTopTabRequestBtn));
settingsTopTabFrontendBtn.addEventListener('click', () => activateSettingsTopTab(settingsTopTabFrontendBtn));

/** 検索実行時に読む設定値。JSONビュー中は編集中のテキストをその場でパースする
 * (GUIに戻さずJSONのまま検索できるようにするため)。不正なら例外を投げる。 */
function readSettings() {
  if (settingsMode === 'json') {
    let parsed;
    try {
      parsed = JSON.parse(settingsJsonInput.value);
    } catch (e) {
      throw new Error(`設定JSONが不正です: ${e.message}`);
    }
    return parsed;
  }
  return readSettingsFromGui();
}

['wRelevance', 'wCondition', 'wAnchor'].forEach(id => {
  const input = document.getElementById(id);
  const out = document.getElementById(id + 'Val');
  input.addEventListener('input', () => { out.textContent = parseFloat(input.value).toFixed(2); });
});

/** searchPOI()に渡すrequestBody全文を組み立てる。runSearch()と「リクエスト全文を見る」
 * モーダルの両方から使う共通ロジック——設定JSONが不正なら例外を投げる(呼び出し側で処理)。 */
function buildRequestBody(text) {
  const settings = readSettings();
  const requestBody = {
    text,
    model: settings.model,
    judge: settings.judge,
    debugLog: !!settings.debugLog,
  };
  if (proximityPoint) requestBody.proximity = proximityPoint;
  const bbox = computeBbox(settings.bboxMode, settings.bboxSquareM);
  if (bbox) requestBody.bbox = bbox;
  return requestBody;
}

function openRequestModal() {
  const errBox = document.getElementById('requestModalError');
  const content = document.getElementById('requestModalContent');
  const text = document.getElementById('queryInput').value.trim() || '(検索テキスト未入力)';
  try {
    const body = searchMode === 'normal'
      ? { note: '通常検索: Search Box forwardのみ（L1/L2/bbox/judgeなし）', q: text, language: 'ja', country: 'jp', limit: 30, proximity: proximityPoint || null }
      : buildRequestBody(text);
    content.textContent = JSON.stringify(body, null, 2);
    errBox.style.display = 'none';
  } catch (e) {
    content.textContent = '';
    errBox.style.display = 'block';
    errBox.textContent = e?.message || String(e);
  }
  document.getElementById('requestModal').style.display = 'block';
}
function closeRequestModal() { document.getElementById('requestModal').style.display = 'none'; }
document.getElementById('viewRequestBtn').addEventListener('click', openRequestModal);
document.getElementById('requestModalClose').addEventListener('click', closeRequestModal);
document.getElementById('requestModal').addEventListener('click', (e) => { if (e.target.id === 'requestModal') closeRequestModal(); });

async function runSearch() {
  const text = document.getElementById('queryInput').value.trim();
  const errorBox = document.getElementById('errorBox');
  errorBox.style.display = 'none';
  if (!text) return;

  document.getElementById('searchBtn').disabled = true;
  try {
    const resp = searchMode === 'normal' ? await runPlainSearch(text) : await searchPOI(buildRequestBody(text));
    renderResults(resp);
  } catch (e) {
    errorBox.style.display = 'block';
    errorBox.textContent = e?.message || String(e);
  } finally {
    document.getElementById('searchBtn').disabled = false;
  }
}

// AI検索(既定)/通常検索の切替。通常検索はgeonator_liteの処理(L1/L2/bbox自動計算/judgeスコア)を
// 一切介さず、Search Box forwardをq=検索テキストそのまま・固定パラメータで叩くだけ
// (proximityだけはON検索と同じ地図クリック地点を使う。それ以外は一切設定を反映しない)。
let searchMode = 'ai';
const searchModeAiBtn = document.getElementById('searchModeAiBtn');
const searchModeNormalBtn = document.getElementById('searchModeNormalBtn');
function setSearchMode(mode) {
  searchMode = mode;
  searchModeAiBtn.classList.toggle('active', mode === 'ai');
  searchModeNormalBtn.classList.toggle('active', mode === 'normal');
}
searchModeAiBtn.addEventListener('click', () => setSearchMode('ai'));
searchModeNormalBtn.addEventListener('click', () => setSearchMode('normal'));

/** 通常検索モード: Search Box forwardのみを固定パラメータで呼ぶ。renderResults()が読む
 * {results, meta}の形はAI検索と揃えるが、score(judgeスコア)は存在しないためnullのまま渡す。 */
async function runPlainSearch(text) {
  const params = new URLSearchParams({
    q: text,
    language: 'ja',
    country: 'jp',
    limit: '30',
    access_token: CONFIG.MAPBOX_ACCESS_TOKEN,
  });
  if (proximityPoint) params.set('proximity', `${proximityPoint.lng},${proximityPoint.lat}`);
  const url = `${CONFIG.SEARCH_BOX_API}?${params.toString()}`;

  const t0 = performance.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Search Box APIエラー: HTTP ${res.status}`);
  const data = await res.json();
  const items = MapboxMCPClient._mapSearchBoxFeatures(data);
  const elapsedMs = Math.round(performance.now() - t0);

  return {
    results: items.map((it, i) => ({
      rank: i + 1,
      name: it.name || it.full_address,
      lat: it.latitude,
      lng: it.longitude,
      score: null,
    })),
    meta: {
      candidateCount: items.length,
      elapsedMs,
      note: '通常検索（Search Box APIのみ・L1/L2/bbox/judgeなし）',
    },
  };
}

document.getElementById('searchBtn').addEventListener('click', runSearch);
document.getElementById('queryInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
