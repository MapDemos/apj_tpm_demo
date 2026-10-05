/* =========================================================================
 * Static Images API Sandbox
 * https://docs.mapbox.com/api/maps/static-images/
 * ========================================================================= */

const API_BASE = 'https://api.mapbox.com/styles/v1';
const TOKEN_KEY = 'mbx_static_sandbox_token';

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

  /* overlay */
  el.overlay.value = overlay;

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
    if (e.key === 'Escape') el.parseModal.classList.add('is-hidden');
  });
}

/* ------------------------------------------------------------------- init */

el.img.classList.add('fit-fit');
loadToken();
wire();
seedRawFromForm();
refresh();
