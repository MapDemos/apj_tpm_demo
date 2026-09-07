// ---- Mapbox設定（トークン・スタイルは既存デモ(poi_density)と同じものを指定） ----
const MAPBOX_ACCESS_TOKEN = "pk.eyJ1IjoiMTBkYTAzMnkiLCJhIjoiY21wYzUxZmc3MDRzaDJxczczb25qbW9reSJ9.xU6N9Srt9xw2U2HZbHubSw";
const MAPBOX_STYLE_URL = "mapbox://styles/10da032y/cmtqqkuoa00hc01sqdgoph4ke";

const TOKYO_STATION = {
  longitude: 139.7660833337572,
  latitude: 35.681380555894634
};

const INITIAL_ZOOM = 16;
const DEFAULT_COUNT = 10;

const GEOJSON_SOURCE_PATH = "./data/starbucks_locations.geojson";

// フレームはスタイルのスプライトではなく、穴が完全な正円になるよう作り直した
// ローカルSVG(assets/rainy_pin.svg)を使う。この見た目はいずれStudio側のスタイルに
// アップロードされ、gemini-svg (2)を置き換える予定。
const FRAME_IMAGE_PATH = "./assets/rainy_pin.svg";

// finished icon canvas spec: assets/rainy_pin.svg has viewBox 0 0 200 280,
// rendered at 2x (400x560). Its hole is defined as an exact <circle
// cx="100" cy="155" r="43"/> in viewBox units, i.e. (200, 310) r=86 at 2x.
const ICON_PIXEL_RATIO = 2;
const ICON_CANVAS_W = 400;
const ICON_CANVAS_H = 560;
const HOLE_CENTER_X = 200;
const HOLE_CENTER_Y = 310;
const HOLE_RADIUS = 86;
const ICON_SIZE = 0.28; // displayed height ≈ 280 * 0.28 = 78px

mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN;

// Workaround for a style-authoring bug in this style (same one worked around in
// poi_density/index.html): some layers' icon-image expressions pass a bare
// {"params": {...}} object where the spec requires ["literal", {...}], which
// Mapbox GL JS rejects at style-parse time ("Bare objects invalid" / "Secondary
// image variant is not a string") -- before 'load' ever fires, so patching the
// layer after load (e.g. removeLayer) is too late. Instead we fetch the style
// JSON ourselves, strip the broken variant arg, and hand the map the pre-fixed object.
function fixBrokenIconImageExpressions(styleJson) {
  styleJson.layers.forEach((l) => {
    const iconImage = l.layout && l.layout["icon-image"];
    if (Array.isArray(iconImage) && iconImage[0] === "image" && typeof iconImage[2] === "object" && iconImage[2] !== null && !Array.isArray(iconImage[2])) {
      l.layout["icon-image"] = ["image", iconImage[1]];
    }
  });
  return styleJson;
}

const STYLE_BASE_URL = MAPBOX_STYLE_URL.replace("mapbox://styles/", "https://api.mapbox.com/styles/v1/");

let map = null;
let storeCount = 0;

async function createMap() {
  const styleUrl = `${STYLE_BASE_URL}?access_token=${MAPBOX_ACCESS_TOKEN}`;
  const res = await fetch(styleUrl);
  const styleJson = fixBrokenIconImageExpressions(await res.json());

  map = new mapboxgl.Map({
    container: "map",
    style: styleJson,
    center: [TOKYO_STATION.longitude, TOKYO_STATION.latitude],
    zoom: INITIAL_ZOOM
  });

  map.on("load", () => {
    init().catch((err) => console.error(err));
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err);
    img.src = src;
  });
}

// 店舗画像を円形にcover相当でクリップして描画
function drawCoverCircle(ctx, img, cx, cy, radius) {
  const scale = Math.max((radius * 2) / img.width, (radius * 2) / img.height);
  const drawW = img.width * scale;
  const drawH = img.height * scale;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(img, cx - drawW / 2, cy - drawH / 2, drawW, drawH);
  ctx.restore();
}

// 店舗画像 + ピン枠 を1枚のCanvasへ合成し、getImageData()でmap.addImage()用データを作る
function composeIcon(storeImg, frameImg) {
  const canvas = document.createElement("canvas");
  canvas.width = ICON_CANVAS_W;
  canvas.height = ICON_CANVAS_H;
  const ctx = canvas.getContext("2d");

  drawCoverCircle(ctx, storeImg, HOLE_CENTER_X, HOLE_CENTER_Y, HOLE_RADIUS);
  ctx.drawImage(frameImg, 0, 0, ICON_CANVAS_W, ICON_CANVAS_H);

  return ctx.getImageData(0, 0, ICON_CANVAS_W, ICON_CANVAS_H);
}

async function loadStoreGeojson() {
  const res = await fetch(GEOJSON_SOURCE_PATH);
  return res.json();
}

async function init() {
  const [frameImg, geojson] = await Promise.all([
    loadImage(FRAME_IMAGE_PATH),
    loadStoreGeojson()
  ]).catch((err) => {
    console.error("画像またはデータの読み込みに失敗しました", err);
    throw err;
  });

  const features = geojson.features;

  // properties.images[0] で参照される画像ごとに、フレーム合成済みアイコンを1つだけ生成する
  // （同じ画像を使う店舗が何件あってもaddImageは1回で済む）
  const uniqueImagePaths = [...new Set(features.map((f) => f.properties.images[0]))];
  const storeImages = await Promise.all(uniqueImagePaths.map(loadImage));

  const iconIdByImagePath = new Map();
  uniqueImagePaths.forEach((path, i) => {
    const iconId = `store-icon-${i}`;
    const iconData = composeIcon(storeImages[i], frameImg);
    map.addImage(iconId, iconData, { pixelRatio: ICON_PIXEL_RATIO });
    iconIdByImagePath.set(path, iconId);
  });

  features.forEach((feature, i) => {
    feature.properties.index = i;
    feature.properties.iconId = iconIdByImagePath.get(feature.properties.images[0]);
  });

  storeCount = features.length;

  map.addSource("stores", {
    type: "geojson",
    data: geojson
  });

  map.addLayer({
    id: "store-pins",
    type: "symbol",
    source: "stores",
    layout: {
      "icon-image": ["get", "iconId"],
      "icon-anchor": "bottom",
      "icon-size": ICON_SIZE,
      "icon-allow-overlap": true
    }
  });

  map.addLayer({
    id: "store-labels",
    type: "symbol",
    source: "stores",
    layout: {
      "text-field": ["get", "name"],
      "text-size": 11,
      "text-anchor": "top",
      "text-offset": [0, 0.3],
      "visibility": "none"
    },
    paint: {
      "text-halo-color": "#ffffff",
      "text-halo-width": 1.2
    }
  });

  setupCountControls(storeCount);
  setVisibleCount(Math.min(DEFAULT_COUNT, storeCount));
}

function setVisibleCount(count) {
  map.setFilter("store-pins", ["<", ["get", "index"], count]);
  map.setFilter("store-labels", ["<", ["get", "index"], count]);
  // 件数が少ないときだけ店舗名を表示（多いと文字が過密になるため）
  map.setLayoutProperty("store-labels", "visibility", count <= 20 ? "visible" : "none");
}

createMap().catch((err) => console.error("マップの初期化に失敗しました", err));

// ---- UI: Range SliderとNumber Inputの双方向同期 ----
const countSlider = document.getElementById("countSlider");
const countInput = document.getElementById("countInput");
const countLabel = document.getElementById("countLabel");
const resetButton = document.getElementById("resetButton");

function setupCountControls(maxCount) {
  countSlider.max = maxCount;
  countInput.max = maxCount;
}

function applyCount(value) {
  const clamped = Math.min(storeCount, Math.max(0, Number(value) || 0));
  countSlider.value = clamped;
  countInput.value = clamped;
  countLabel.textContent = clamped;
  if (map && map.getLayer("store-pins")) {
    setVisibleCount(clamped);
  }
}

countSlider.addEventListener("input", (e) => applyCount(e.target.value));
countInput.addEventListener("input", (e) => applyCount(e.target.value));

resetButton.addEventListener("click", () => {
  if (!map) return;
  map.jumpTo({
    center: [TOKYO_STATION.longitude, TOKYO_STATION.latitude],
    zoom: INITIAL_ZOOM
  });
});
