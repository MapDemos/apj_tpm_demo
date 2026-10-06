/* =========================================================================
 * Static Images API Sandbox
 * https://docs.mapbox.com/api/maps/static-images/
 * ========================================================================= */

const API_BASE = 'https://api.mapbox.com/styles/v1';
const SEARCH_BASE = 'https://api.mapbox.com/search/searchbox/v1';
const TOKEN_KEY = 'mbx_static_sandbox_token';

/* Search Box は日本語 / 日本固定（type は指定しない） */
const SB_LANGUAGE = 'ja';
const SB_COUNTRY = 'jp';
const SB_LIMIT = 10;

const $ = (id) => document.getElementById(id);

const el = {
  token: $('token'),
  tokenToggle: $('tokenToggle'),
  runBtn: $('runBtn'),
  parseBtn: $('parseBtn'),

  owner: $('owner'),
  styleId: $('styleId'),

  posMode: $('posMode'),
  lon: $('lon'), lat: $('lat'), zoom: $('zoom'),
  bearing: $('bearing'), pitch: $('pitch'),
  bboxW: $('bboxW'), bboxS: $('bboxS'), bboxE: $('bboxE'), bboxN: $('bboxN'),

  width: $('width'), height: $('height'), retina: $('retina'),
  sizeHint: $('sizeHint'),

  addlayerOn: $('addlayerOn'),
  addlayerBody: $('addlayerBody'),
  layerMode: $('layerMode'),
  layerId: $('layerId'), layerType: $('layerType'), srcType: $('srcType'),
  tileset: $('tileset'), sourceLayer: $('sourceLayer'),
  layerFilter: $('layerFilter'), layerPaint: $('layerPaint'),
  layerRaw: $('layerRaw'),
  beforeLayer: $('beforeLayer'),

  filterLayerId: $('filterLayerId'), setFilter: $('setFilter'),
  overlay: $('overlay'),
  attribution: $('attribution'), logo: $('logo'), padding: $('padding'),

  urlOut: $('urlOut'), urlWarn: $('urlWarn'),
  showToken: $('showToken'),
  copyUrl: $('copyUrl'), openUrl: $('openUrl'),

  mPx: $('mPx'), mReq: $('mReq'), mSize: $('mSize'), mType: $('mType'), mTime: $('mTime'),
  fitMode: $('fitMode'),
  downloadBtn: $('downloadBtn'),
  canvasArea: $('canvasArea'),
  placeholder: $('placeholder'),
  img: $('img'),

  sbOpen: $('sbOpen'),
  sbModal: $('sbModal'),
  sbQuery: $('sbQuery'),
  sbProximity: $('sbProximity'),
  sbResults: $('sbResults'),
  sbErr: $('sbErr'),
  sbCancel: $('sbCancel'),
  sbSession: $('sbSession'),

  parseModal: $('parseModal'),
  parseInput: $('parseInput'),
  parseErr: $('parseErr'),
  parseCancel: $('parseCancel'),
  parseApply: $('parseApply'),

  toast: $('toast'),
};

let posMode = 'center';      // center | bbox | auto
let layerMode = 'form';      // form | raw
let lastBlob = null;
let lastBlobUrl = null;

/* ----------------------------------------------------------------- helpers */

function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.remove('is-hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.add('is-hidden'), 2000);
}

function num(input) {
  const v = input.value.trim();
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 小数の末尾ゼロを落としつつ数値を文字列化 */
function fmt(n) {
  return String(n);
}

/* ---------------------------------------------------------- addlayer 組立 */

function buildAddLayer() {
  if (!el.addlayerOn.checked) return { value: null };

  if (layerMode === 'raw') {
    const raw = el.layerRaw.value.trim();
    if (!raw) return { value: null };
    try {
      return { value: JSON.parse(raw) };
    } catch (e) {
      return { value: null, error: `addlayer の生JSONが不正です: ${e.message}` };
    }
  }

  const layer = {
    id: el.layerId.value.trim() || 'sandbox-layer',
    type: el.layerType.value,
    source: {
      type: el.srcType.value,
      url: el.tileset.value.trim(),
    },
  };

  const srcLayer = el.sourceLayer.value.trim();
  if (el.srcType.value === 'vector' && srcLayer) layer['source-layer'] = srcLayer;

  const filterText = el.layerFilter.value.trim();
  if (filterText) {
    try {
      layer.filter = JSON.parse(filterText);
    } catch (e) {
      return { value: null, error: `filter の JSON が不正です: ${e.message}` };
    }
  }

  const paintText = el.layerPaint.value.trim();
  if (paintText) {
    try {
      layer.paint = JSON.parse(paintText);
    } catch (e) {
      return { value: null, error: `paint の JSON が不正です: ${e.message}` };
    }
  }

  return { value: layer };
}

/** フォーム → 生JSON の片方向コピー（生JSON側は逆同期しない） */
function seedRawFromForm() {
  const built = buildAddLayer();
  if (built.value) {
    el.layerRaw.value = JSON.stringify(built.value, null, 2);
  }
}

/* ------------------------------------------- overlay → 中心点（片方向シード） */

/**
 * Google encoded polyline（Static Images API の path が使う形式）をデコードする。
 * 戻り値は [lon, lat] の配列。
 */
function decodePolyline(str, precision = 5) {
  const factor = Math.pow(10, precision);
  const coords = [];
  let index = 0, lat = 0, lng = 0;

  const readValue = () => {
    let result = 0, shift = 0, b;
    do {
      if (index >= str.length) throw new Error('polyline が途中で終わっています');
      b = str.charCodeAt(index++) - 63;
      if (b < 0 || b > 63) throw new Error('polyline に不正な文字があります');
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return (result & 1) ? ~(result >> 1) : (result >> 1);
  };

  while (index < str.length) {
    lat += readValue();
    lng += readValue();
    coords.push([lng / factor, lat / factor]);
  }
  return coords;
}

/** overlay 文字列をトップレベルのカンマで分割する（括弧 / 波括弧 / 文字列の中は無視） */
function splitOverlays(s) {
  const out = [];
  let depth = 0, inStr = false, esc = false, buf = '';
  for (const ch of s) {
    if (inStr) {
      buf += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; buf += ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    if (ch === ')' || ch === '}' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  out.push(buf);
  return out.map((v) => v.trim()).filter(Boolean);
}

/** `name(...)` の括弧の中身を返す */
function parenBody(s) {
  const open = s.indexOf('(');
  const close = s.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  return s.slice(open + 1, close);
}

/** GeoJSON を再帰的にたどって [lon, lat] を集める（bbox や properties の数値は拾わない） */
function collectGeoJSONCoords(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
      out.push([node[0], node[1]]);
    } else {
      node.forEach((n) => collectGeoJSONCoords(n, out));
    }
    return;
  }
  ['coordinates', 'geometry', 'geometries', 'features'].forEach((k) => {
    if (k in node) collectGeoJSONCoords(node[k], out);
  });
}

/** overlay 文字列に含まれる全座標を [lon, lat] の配列で返す */
function collectOverlayCoords(overlayText) {
  const coords = [];
  for (const part of splitOverlays(overlayText)) {
    const body = parenBody(part);
    if (body === null) continue;

    if (/^geojson\s*\(/i.test(part)) {
      let json = body;
      if (json.includes('%')) { try { json = decodeURIComponent(json); } catch (_) { /* そのまま */ } }
      try {
        collectGeoJSONCoords(JSON.parse(json), coords);
      } catch (_) { /* 不正な GeoJSON は無視 */ }
      continue;
    }

    if (/^path[-(]/i.test(part)) {
      let poly = body;
      if (poly.includes('%')) { try { poly = decodeURIComponent(poly); } catch (_) { /* そのまま */ } }
      try {
        coords.push(...decodePolyline(poly));
      } catch (_) { /* 壊れた polyline は無視 */ }
      continue;
    }

    /* pin-s / pin-l / url-… はいずれも末尾が (lon,lat) */
    const m = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(body);
    if (m) coords.push([Number(m[1]), Number(m[2])]);
  }
  return coords.filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
}

/** overlay の全座標の bbox 中心を返す。座標が取れなければ null */
function overlayCenter(overlayText) {
  const coords = collectOverlayCoords(overlayText);
  if (!coords.length) return null;
  const lons = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  const round = (n) => Number(n.toFixed(7));
  return {
    lon: round((Math.min(...lons) + Math.max(...lons)) / 2),
    lat: round((Math.min(...lats) + Math.max(...lats)) / 2),
    count: coords.length,
  };
}

let lastSeededOverlay = null;

/**
 * overlay の中心を Lon / Lat にシードする（片方向）。
 * セット後に Lon / Lat を手で変えても overlay 側は追従しない。
 */
function seedCenterFromOverlay() {
  const text = el.overlay.value.trim();
  if (text === lastSeededOverlay) return;
  lastSeededOverlay = text;
  if (!text) return;

  const c = overlayCenter(text);
  if (!c) { toast('overlay から座標を読み取れませんでした'); return; }

  el.lon.value = c.lon;
  el.lat.value = c.lat;
  refresh();
  toast(c.count > 1
    ? `overlay ${c.count} 点の中心 ${c.lon}, ${c.lat} をセットしました`
    : `overlay の座標 ${c.lon}, ${c.lat} をセットしました`);
}

/* ------------------------------------------------------------- URL 組立 */

function buildRequest() {
  const warnings = [];
  const owner = el.owner.value.trim();
  const styleId = el.styleId.value.trim();
  if (!owner || !styleId) warnings.push('Style の owner / ID を入力してください。');

  /* --- position --- */
  let position = 'auto';
  if (posMode === 'center') {
    const lon = num(el.lon), lat = num(el.lat), zoom = num(el.zoom);
    if (lon === null || lat === null || zoom === null) {
      warnings.push('Lon / Lat / Zoom を入力してください。');
    }
    const parts = [fmt(lon ?? 0), fmt(lat ?? 0), fmt(zoom ?? 0)];
    const bearing = num(el.bearing);
    const pitch = num(el.pitch);
    if (pitch !== null) {
      parts.push(fmt(bearing ?? 0), fmt(pitch));
    } else if (bearing !== null) {
      parts.push(fmt(bearing));
    }
    position = parts.join(',');
  } else if (posMode === 'bbox') {
    const w = num(el.bboxW), s = num(el.bboxS), e = num(el.bboxE), n = num(el.bboxN);
    if ([w, s, e, n].some((v) => v === null)) warnings.push('bbox の 4 値を入力してください。');
    position = `[${fmt(w ?? 0)},${fmt(s ?? 0)},${fmt(e ?? 0)},${fmt(n ?? 0)}]`;
  }

  /* --- size --- */
  const width = num(el.width) ?? 0;
  const height = num(el.height) ?? 0;
  const retina = el.retina.value === '2';
  if (width < 1 || height < 1 || width > 1280 || height > 1280) {
    warnings.push('Width / Height は 1〜1280 の範囲で指定してください。');
  }
  const size = `${Math.round(width)}x${Math.round(height)}${retina ? '@2x' : ''}`;

  /* --- overlay --- */
  const overlay = el.overlay.value.trim();
  if (posMode === 'auto' && !overlay) {
    warnings.push('auto モードには overlay（GeoJSON / marker / path）が必要です。');
  }

  /* --- query params --- */
  const params = [];

  const addlayer = buildAddLayer();
  if (addlayer.error) warnings.push(addlayer.error);
  if (addlayer.value) {
    params.push(['addlayer', JSON.stringify(addlayer.value)]);
    const before = el.beforeLayer.value.trim();
    if (before) params.push(['before_layer', before]);
  }

  const fLayer = el.filterLayerId.value.trim();
  const fExpr = el.setFilter.value.trim();
  if (fExpr && !fLayer) warnings.push('setfilter には layer_id が必要です。');
  if (fLayer && !fExpr) warnings.push('layer_id には setfilter が必要です。');
  if (fLayer && fExpr) {
    try {
      JSON.parse(fExpr);
    } catch (e) {
      warnings.push(`setfilter の JSON が不正です: ${e.message}`);
    }
    params.push(['setfilter', fExpr]);
    params.push(['layer_id', fLayer]);
  }

  if (el.attribution.value) params.push(['attribution', el.attribution.value]);
  if (el.logo.value) params.push(['logo', el.logo.value]);
  const padding = el.padding.value.trim();
  if (padding) params.push(['padding', padding]);

  /* --- 組み立て --- */
  const pathParts = [encodeURIComponent(owner), encodeURIComponent(styleId), 'static'];
  if (overlay) pathParts.push(overlay);
  pathParts.push(position, size);

  const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const base = `${API_BASE}/${pathParts.join('/')}`;

  const token = el.token.value.trim();
  const withToken = `${base}${query ? '?' + query + '&' : '?'}access_token=${encodeURIComponent(token)}`;
  const masked = `${base}${query ? '?' + query + '&' : '?'}access_token=${token ? '••••••••' : 'アクセストークン'}`;

  return { url: withToken, display: masked, warnings, token, size, retina, width, height };
}

/* ---------------------------------------------------------------- 表示更新 */

function refresh() {
  const req = buildRequest();
  el.urlOut.textContent = el.showToken.checked && req.token ? req.url : req.display;

  if (req.warnings.length) {
    el.urlWarn.textContent = req.warnings.join('  /  ');
    el.urlWarn.classList.remove('is-hidden');
  } else {
    el.urlWarn.classList.add('is-hidden');
  }

  const w = req.width, h = req.height, k = req.retina ? 2 : 1;
  el.sizeHint.textContent =
    `出力画素数: ${Math.round(w * k)} × ${Math.round(h * k)} px` +
    (req.retina ? '（@2x: 指定値の2倍）' : '') +
    ' / 上限 1280×1280';

  return req;
}

/* ------------------------------------------------------------------- 実行 */

async function run() {
  const req = refresh();
  if (!req.token) {
    showError('アクセストークンが未入力です', 'ヘッダーの Access token 欄に pk.… トークンを入力してください。');
    return;
  }

  el.runBtn.classList.add('is-busy');
  el.runBtn.querySelector('.btn-label').textContent = '取得中…';

  const t0 = performance.now();
  try {
    const res = await fetch(req.url);
    const elapsed = Math.round(performance.now() - t0);
    const type = res.headers.get('content-type') || '';

    if (!res.ok || !type.startsWith('image/')) {
      let detail = '';
      try {
        const text = await res.text();
        detail = text.slice(0, 1200);
      } catch (_) { /* noop */ }
      showError(`HTTP ${res.status} ${res.statusText}`, detail || '(レスポンス本文なし)');
      el.mTime.textContent = `${elapsed} ms`;
      return;
    }

    const blob = await res.blob();
    setImage(blob, type, elapsed, req);
  } catch (e) {
    showError('リクエストに失敗しました', `${e.message}\n\nCORS / ネットワークの問題か、トークンが不正な可能性があります。`);
  } finally {
    el.runBtn.classList.remove('is-busy');
    el.runBtn.querySelector('.btn-label').textContent = '実行';
  }
}

function setImage(blob, type, elapsed, req) {
  if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
  lastBlob = blob;
  lastBlobUrl = URL.createObjectURL(blob);

  el.img.onload = () => {
    el.mPx.textContent = `${el.img.naturalWidth} × ${el.img.naturalHeight} px`;
  };
  el.img.src = lastBlobUrl;
  el.img.classList.remove('is-hidden');
  el.placeholder.classList.add('is-hidden');

  el.mReq.textContent = `${Math.round(req.width)} × ${Math.round(req.height)}${req.retina ? ' @2x' : ''}`;
  el.mSize.textContent = bytes(blob.size);
  el.mType.textContent = type.replace('image/', '').toUpperCase();
  el.mTime.textContent = `${elapsed} ms`;
  el.downloadBtn.disabled = false;
}

function showError(title, detail) {
  el.img.classList.add('is-hidden');
  el.placeholder.classList.remove('is-hidden');
  el.placeholder.classList.add('is-error');
  el.placeholder.innerHTML = `
    <div class="placeholder-mark"></div>
    <p class="placeholder-title"></p>
    <p class="placeholder-sub">設定を見直して再実行してください</p>
    <pre class="placeholder-detail"></pre>`;
  el.placeholder.querySelector('.placeholder-title').textContent = title;
  el.placeholder.querySelector('.placeholder-detail').textContent = detail;

  el.mPx.textContent = el.mReq.textContent = el.mSize.textContent = el.mType.textContent = '—';
  el.downloadBtn.disabled = true;
}

/* --------------------------------------------------------------- URL パース */

function parseUrl(input) {
  const u = new URL(input.trim());
  if (!/^\/styles\/v1\//.test(u.pathname)) throw new Error('Static Images API の URL ではないようです。');

  const segs = u.pathname.replace(/^\/styles\/v1\//, '').split('/');
  const staticIdx = segs.indexOf('static');
  if (staticIdx < 2) throw new Error('パスから owner / style ID を読み取れません。');

  const owner = decodeURIComponent(segs[0]);
  const styleId = decodeURIComponent(segs.slice(1, staticIdx).join('/'));
  const rest = segs.slice(staticIdx + 1);
  if (rest.length < 2) throw new Error('position / size のセグメントが足りません。');

  const size = rest[rest.length - 1];
  const position = decodeURIComponent(rest[rest.length - 2]);
  const overlay = rest.slice(0, rest.length - 2).map(decodeURIComponent).join('/');

  /* style */
  el.owner.value = owner;
  el.styleId.value = styleId;

  /* size */
  const m = /^(\d+)x(\d+)(@2x)?$/.exec(size);
  if (m) {
    el.width.value = m[1];
    el.height.value = m[2];
    el.retina.value = m[3] ? '2' : '1';
  }

  /* position */
  if (position === 'auto') {
    setPosMode('auto');
  } else if (position.startsWith('[')) {
    const b = JSON.parse(position);
    el.bboxW.value = b[0]; el.bboxS.value = b[1]; el.bboxE.value = b[2]; el.bboxN.value = b[3];
    setPosMode('bbox');
  } else {
    const p = position.split(',');
    el.lon.value = p[0] ?? '';
    el.lat.value = p[1] ?? '';
    el.zoom.value = p[2] ?? '';
    el.bearing.value = p[3] ?? '';
    el.pitch.value = p[4] ?? '';
    setPosMode('center');
  }

  /* overlay（URL 側の position を優先するので、ここでは中心点をシードしない） */
  el.overlay.value = overlay;
  lastSeededOverlay = overlay;

  /* query params */
  const q = u.searchParams;
  const addlayer = q.get('addlayer');
  if (addlayer) {
    el.addlayerOn.checked = true;
    const layer = JSON.parse(addlayer);
    applyLayerToForm(layer);
    el.layerRaw.value = JSON.stringify(layer, null, 2);
  } else {
    el.addlayerOn.checked = false;
  }
  el.beforeLayer.value = q.get('before_layer') || '';
  el.filterLayerId.value = q.get('layer_id') || '';
  el.setFilter.value = q.get('setfilter') || '';
  el.attribution.value = q.get('attribution') || '';
  el.logo.value = q.get('logo') || '';
  el.padding.value = q.get('padding') || '';

  const tok = q.get('access_token');
  if (tok && /^pk\./.test(tok)) {
    el.token.value = tok;
    saveToken();
  }

  syncAddlayerBody();
}

/** addlayer オブジェクトをフォーム欄に展開（対応しない形は生JSONモードへ） */
function applyLayerToForm(layer) {
  const src = layer.source;
  const simple = src && typeof src === 'object' && typeof src.url === 'string';

  if (simple) {
    el.layerId.value = layer.id || '';
    if ([...el.layerType.options].some((o) => o.value === layer.type)) el.layerType.value = layer.type;
    if ([...el.srcType.options].some((o) => o.value === src.type)) el.srcType.value = src.type;
    el.tileset.value = src.url;
    el.sourceLayer.value = layer['source-layer'] || '';
    el.layerFilter.value = layer.filter ? JSON.stringify(layer.filter) : '';
    el.layerPaint.value = layer.paint ? JSON.stringify(layer.paint, null, 2) : '';
    setLayerMode('form');
  } else {
    setLayerMode('raw');
  }
}

/* ------------------------------------------------------------------ モード */

function setPosMode(mode) {
  posMode = mode;
  [...el.posMode.querySelectorAll('.seg-btn')].forEach((b) =>
    b.classList.toggle('is-active', b.dataset.mode === mode));
  document.querySelectorAll('[data-mode-body]').forEach((b) =>
    b.classList.toggle('is-hidden', b.dataset.modeBody !== mode));
  refresh();
}

function setLayerMode(mode) {
  if (mode === 'raw' && layerMode === 'form') seedRawFromForm();
  layerMode = mode;
  [...el.layerMode.querySelectorAll('.seg-btn')].forEach((b) =>
    b.classList.toggle('is-active', b.dataset.lmode === mode));
  document.querySelectorAll('[data-lmode-body]').forEach((b) =>
    b.classList.toggle('is-hidden', b.dataset.lmodeBody !== mode));
  refresh();
}

function syncAddlayerBody() {
  el.addlayerBody.style.opacity = el.addlayerOn.checked ? '1' : '.45';
  el.addlayerBody.style.pointerEvents = el.addlayerOn.checked ? '' : 'none';
  refresh();
}

/* ------------------------------------------------- Search Box (suggest) */

let sbSessionToken = null;
let sbSeq = 0;            // 競合するレスポンスを捨てるための世代カウンタ
let sbTimer = null;

function newSessionToken() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'sess-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function sbProximityValue() {
  if (!el.sbProximity.checked) return null;
  const lon = num(el.lon), lat = num(el.lat);
  if (lon === null || lat === null) return null;
  return `${lon},${lat}`;
}

/** 2点間のおおよその距離(m) — 候補の近さを表示するためだけに使う */
function roughDistance(lon1, lat1, lon2, lat2) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function sbMessage(cls, text) {
  el.sbResults.innerHTML = '';
  const p = document.createElement('p');
  p.className = cls;
  p.textContent = text;
  el.sbResults.appendChild(p);
}

function sbError(msg) {
  el.sbErr.textContent = msg;
  el.sbErr.classList.remove('is-hidden');
}

function sbOpenModal() {
  sbSessionToken = newSessionToken();
  el.sbSession.textContent = `session_token: ${sbSessionToken}`;
  el.sbErr.classList.add('is-hidden');
  el.sbQuery.value = '';
  sbMessage('sb-empty', 'キーワードを入力すると候補を表示します');
  el.sbModal.classList.remove('is-hidden');
  el.sbQuery.focus();
}

function sbCloseModal() {
  clearTimeout(sbTimer);
  sbSeq++;
  el.sbModal.classList.add('is-hidden');
}

async function sbSuggest() {
  const q = el.sbQuery.value.trim();
  const seq = ++sbSeq;

  if (!q) {
    sbMessage('sb-empty', 'キーワードを入力すると候補を表示します');
    return;
  }

  const token = el.token.value.trim();
  if (!token) {
    sbError('アクセストークンが未入力です（ヘッダーの Access token 欄）。');
    return;
  }
  el.sbErr.classList.add('is-hidden');
  sbMessage('sb-loading', '検索中…');

  const params = new URLSearchParams({
    q,
    language: SB_LANGUAGE,
    country: SB_COUNTRY,
    limit: String(SB_LIMIT),
    session_token: sbSessionToken,
    access_token: token,
  });
  const prox = sbProximityValue();
  if (prox) params.set('proximity', prox);

  try {
    const res = await fetch(`${SEARCH_BASE}/suggest?${params}`);
    if (seq !== sbSeq) return;                      // 新しい入力に追い抜かれた
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      sbError(`suggest 失敗: HTTP ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
      sbMessage('sb-empty', '—');
      return;
    }
    const json = await res.json();
    if (seq !== sbSeq) return;
    sbRender(json.suggestions || [], prox);
  } catch (e) {
    if (seq !== sbSeq) return;
    sbError(`suggest 失敗: ${e.message}`);
    sbMessage('sb-empty', '—');
  }
}

function sbRender(suggestions, prox) {
  if (!suggestions.length) {
    sbMessage('sb-empty', '候補が見つかりませんでした');
    return;
  }

  const [pLon, pLat] = prox ? prox.split(',').map(Number) : [null, null];

  el.sbResults.innerHTML = '';
  suggestions.forEach((s) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'sb-item';

    const name = document.createElement('span');
    name.className = 'sb-name';
    name.textContent = s.name_preferred || s.name || '(no name)';
    item.appendChild(name);

    const addr = document.createElement('span');
    addr.className = 'sb-addr';
    addr.textContent = s.full_address || s.place_formatted || '';
    item.appendChild(addr);

    const badges = document.createElement('span');
    badges.className = 'sb-badges';
    const tags = [];
    if (s.feature_type) tags.push(s.feature_type);
    if (s.poi_category && s.poi_category.length) tags.push(s.poi_category.slice(0, 3).join(' / '));
    if (s.distance != null) {
      tags.push(`${Math.round(s.distance)} m`);
    } else if (pLon !== null && s.coordinates) {
      tags.push(`${Math.round(roughDistance(pLon, pLat, s.coordinates.longitude, s.coordinates.latitude))} m`);
    }
    tags.forEach((t, i) => {
      const b = document.createElement('span');
      b.className = 'sb-badge' + (/\d+ m$/.test(t) && i === tags.length - 1 ? ' sb-badge--dist' : '');
      b.textContent = t;
      badges.appendChild(b);
    });
    if (tags.length) item.appendChild(badges);

    item.addEventListener('click', () => sbRetrieve(s, item));
    el.sbResults.appendChild(item);
  });
}

/** suggest の候補は座標を持たないので retrieve で確定させる */
async function sbRetrieve(suggestion, item) {
  const token = el.token.value.trim();
  if (!suggestion.mapbox_id) {
    sbError('この候補に mapbox_id がないため retrieve できません。');
    return;
  }

  item.classList.add('is-busy');
  el.sbErr.classList.add('is-hidden');

  const params = new URLSearchParams({
    language: SB_LANGUAGE,
    session_token: sbSessionToken,
    access_token: token,
  });

  try {
    const res = await fetch(`${SEARCH_BASE}/retrieve/${encodeURIComponent(suggestion.mapbox_id)}?${params}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      sbError(`retrieve 失敗: HTTP ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
      return;
    }
    const json = await res.json();
    const feature = (json.features || [])[0];
    const coords = feature && feature.geometry && feature.geometry.coordinates;
    if (!coords) {
      sbError('retrieve のレスポンスに座標が含まれていません。');
      return;
    }

    el.lon.value = coords[0];
    el.lat.value = coords[1];
    sbCloseModal();
    refresh();
    toast(`Lon/Lat をセット: ${feature.properties?.name || suggestion.name || ''}`);
  } catch (e) {
    sbError(`retrieve 失敗: ${e.message}`);
  } finally {
    item.classList.remove('is-busy');
  }
}

/* ------------------------------------------------------------------ token */

function saveToken() {
  try { localStorage.setItem(TOKEN_KEY, el.token.value.trim()); } catch (_) { /* noop */ }
}

function loadToken() {
  try {
    const t = localStorage.getItem(TOKEN_KEY);
    if (t) el.token.value = t;
  } catch (_) { /* noop */ }
}

/* ----------------------------------------------------------------- 配線 */

function wire() {
  /* 入力変更 → URL 再生成 */
  document.querySelectorAll('input, select, textarea').forEach((node) => {
    if (node === el.token) return;
    node.addEventListener('input', refresh);
    node.addEventListener('change', refresh);
  });

  el.token.addEventListener('input', () => { saveToken(); refresh(); });

  el.tokenToggle.addEventListener('click', () => {
    const show = el.token.type === 'password';
    el.token.type = show ? 'text' : 'password';
    el.tokenToggle.textContent = show ? '隠す' : '表示';
  });

  el.showToken.addEventListener('change', refresh);

  /* overlay を変更したら、その中心を Lon / Lat にシード（片方向） */
  el.overlay.addEventListener('change', seedCenterFromOverlay);

  /* モード切替 */
  el.posMode.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (btn) setPosMode(btn.dataset.mode);
  });
  el.layerMode.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (btn) setLayerMode(btn.dataset.lmode);
  });
  el.addlayerOn.addEventListener('change', syncAddlayerBody);

  /* チップ */
  document.querySelectorAll('.chip[data-style]').forEach((c) => c.addEventListener('click', () => {
    const [owner, id] = c.dataset.style.split('/');
    el.owner.value = owner;
    el.styleId.value = id;
    refresh();
  }));
  document.querySelectorAll('.chip[data-size]').forEach((c) => c.addEventListener('click', () => {
    const [w, h] = c.dataset.size.split('x');
    el.width.value = w;
    el.height.value = h;
    refresh();
  }));
  document.querySelectorAll('.chip[data-tileset]').forEach((c) => c.addEventListener('click', () => {
    const [url, srcLayer] = c.dataset.tileset.split('|');
    el.tileset.value = url;
    el.sourceLayer.value = srcLayer || '';
    refresh();
  }));
  document.querySelectorAll('.chip[data-overlay]').forEach((c) => c.addEventListener('click', () => {
    el.overlay.value = c.dataset.overlay;
    refresh();
    seedCenterFromOverlay();
  }));

  /* 実行 / コピー / 開く */
  el.runBtn.addEventListener('click', run);

  el.copyUrl.addEventListener('click', async () => {
    const { url, token } = buildRequest();
    if (!token) { toast('トークン未入力のままコピーします'); }
    try {
      await navigator.clipboard.writeText(url);
      toast('URL をコピーしました');
    } catch (_) {
      toast('コピーに失敗しました');
    }
  });

  el.openUrl.addEventListener('click', () => {
    const { url, token } = buildRequest();
    if (!token) { toast('アクセストークンを入力してください'); return; }
    window.open(url, '_blank', 'noopener');
  });

  /* 表示モード */
  el.fitMode.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    [...el.fitMode.querySelectorAll('.seg-btn')].forEach((b) =>
      b.classList.toggle('is-active', b === btn));
    const actual = btn.dataset.fit === 'actual';
    el.img.classList.toggle('fit-actual', actual);
    el.img.classList.toggle('fit-fit', !actual);
    el.canvasArea.classList.toggle('is-actual', actual);
  });

  /* ダウンロード */
  el.downloadBtn.addEventListener('click', () => {
    if (!lastBlob || !lastBlobUrl) return;
    const ext = (lastBlob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const a = document.createElement('a');
    a.href = lastBlobUrl;
    a.download = `static_${el.styleId.value.trim() || 'map'}_${el.img.naturalWidth}x${el.img.naturalHeight}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  /* Search Box 検索ダイアログ */
  el.sbOpen.addEventListener('click', sbOpenModal);
  el.sbCancel.addEventListener('click', sbCloseModal);
  el.sbModal.addEventListener('click', (e) => {
    if (e.target === el.sbModal) sbCloseModal();
  });
  el.sbQuery.addEventListener('input', () => {
    clearTimeout(sbTimer);
    sbTimer = setTimeout(sbSuggest, 300);
  });
  el.sbQuery.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(sbTimer); sbSuggest(); }
  });
  el.sbProximity.addEventListener('change', () => {
    if (el.sbQuery.value.trim()) sbSuggest();
  });

  /* URL 読み込みダイアログ */
  el.parseBtn.addEventListener('click', () => {
    el.parseErr.classList.add('is-hidden');
    el.parseModal.classList.remove('is-hidden');
    el.parseInput.focus();
  });
  el.parseCancel.addEventListener('click', () => el.parseModal.classList.add('is-hidden'));
  el.parseModal.addEventListener('click', (e) => {
    if (e.target === el.parseModal) el.parseModal.classList.add('is-hidden');
  });
  el.parseApply.addEventListener('click', () => {
    try {
      parseUrl(el.parseInput.value);
      el.parseModal.classList.add('is-hidden');
      refresh();
      toast('URL を読み込みました');
    } catch (e) {
      el.parseErr.textContent = `読み込めませんでした: ${e.message}`;
      el.parseErr.classList.remove('is-hidden');
    }
  });

  /* ⌘/Ctrl + Enter で実行 */
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    if (e.key === 'Escape') {
      el.parseModal.classList.add('is-hidden');
      if (!el.sbModal.classList.contains('is-hidden')) sbCloseModal();
    }
  });
}

/* ------------------------------------------------------------------- init */

el.img.classList.add('fit-fit');
loadToken();
wire();
seedRawFromForm();
refresh();
