// ============================================================
// TOKENS
// ============================================================
let GOOGLE_API_KEY = '';
let MAPBOX_TOKEN   = '';
let AI_PROXY_URL   = '';
const LS_GKEY      = 'apc_google_api_key';
const LS_MBTOKEN   = 'apc_mapbox_token';
const LS_AIPROXY   = 'apc_ai_proxy_url';
const MAPBOX_STYLE = 'mapbox://styles/10da032y/cmq4kcm10005001rfh7jb79cx';
const PRESET_MAPBOX_TOKEN = "pk.eyJ1IjoiMTBkYTAzMnkiLCJhIjoiY21wYzUxZmc3MDRzaDJxczczb25qbW9reSJ9.xU6N9Srt9xw2U2HZbHubSw";
const PRESET_AI_PROXY_URL = "https://okqfpyxf4oe6htegrlcgrwdssa0yoxcr.lambda-url.us-east-1.on.aws/";
const AI_MODEL = 'claude-haiku-4-5-20251001';

// ============================================================
// SETUP MODAL
// ============================================================
function toggleVis(inputId, btn) {
  const input = document.getElementById(inputId);
  input.type = input.type === 'password' ? 'text' : 'password';
  btn.textContent = input.type === 'password' ? '表示' : '隠す';
}

function initSetup() {
  const gInput = document.getElementById('setup-google-key');
  const mInput = document.getElementById('setup-mapbox-token');
  const aInput = document.getElementById('setup-ai-proxy');
  const startBtn = document.getElementById('setup-start');
  const clearBtn = document.getElementById('setup-clear');

  // Google は従来通り localStorage から復元（プリセットなし）
  gInput.value = localStorage.getItem(LS_GKEY) ?? '';

  // ▼ Mapbox / AI Proxy は「localStorageに保存済みならそれを優先」「未保存(初回)ならプリセット」
  // (プリセット優先だと、保存してもリロード時に常にプリセットで上書きされ、保存が反映されなくなるため)
  const isPk  = (t) => typeof t === 'string' && t.trim().startsWith('pk.');
  const isUrl = (t) => typeof t === 'string' && /^https?:\/\//.test(t.trim());
  mInput.value = localStorage.getItem(LS_MBTOKEN) ?? (isPk(PRESET_MAPBOX_TOKEN)  ? PRESET_MAPBOX_TOKEN  : '');
  aInput.value = localStorage.getItem(LS_AIPROXY) ?? (isUrl(PRESET_AI_PROXY_URL) ? PRESET_AI_PROXY_URL : '');

  const validate = () => { startBtn.disabled = !(gInput.value.trim() && mInput.value.trim() && aInput.value.trim()); };
  gInput.addEventListener('input', validate);
  mInput.addEventListener('input', validate);
  aInput.addEventListener('input', validate);
  validate();

  startBtn.addEventListener('click', () => {
    GOOGLE_API_KEY = gInput.value.trim();
    MAPBOX_TOKEN   = mInput.value.trim();
    AI_PROXY_URL   = aInput.value.trim();
    localStorage.setItem(LS_GKEY,    GOOGLE_API_KEY);
    localStorage.setItem(LS_MBTOKEN, MAPBOX_TOKEN);
    localStorage.setItem(LS_AIPROXY, AI_PROXY_URL);
    document.getElementById('setup-overlay').style.display = 'none';
    startApp();
  });

  clearBtn.addEventListener('click', () => {
    localStorage.removeItem(LS_GKEY);
    localStorage.removeItem(LS_MBTOKEN);
    localStorage.removeItem(LS_AIPROXY);
    gInput.value = '';
    mInput.value = isPk(PRESET_MAPBOX_TOKEN)  ? PRESET_MAPBOX_TOKEN  : '';
    aInput.value = isUrl(PRESET_AI_PROXY_URL) ? PRESET_AI_PROXY_URL : '';
    validate();
    clearBtn.textContent = '✅ 削除しました';
    setTimeout(() => clearBtn.textContent = '保存済みトークンを削除', 2000);
  });

  [gInput, mInput, aInput].forEach(el => {
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !startBtn.disabled) startBtn.click(); });
  });
}

function openTokenModal() {
  document.getElementById('setup-google-key').value  = GOOGLE_API_KEY;
  document.getElementById('setup-mapbox-token').value = MAPBOX_TOKEN;
  document.getElementById('setup-ai-proxy').value     = AI_PROXY_URL;
  document.getElementById('setup-start').disabled = false;
  document.getElementById('setup-overlay').style.display = 'flex';
}

// ============================================================
// AI PROXY (Anthropic Messages API 互換 Lambda プロキシ)
// ============================================================
function extractClaudeText(data) {
  return Array.isArray(data?.content)
    ? data.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('')
    : (data?.content?.[0]?.text ?? '');
}

// Anthropic Messages APIのレスポンス全体(usage含む)が欲しい呼び出し元向け。
// thinking: disabledを明示している。プロキシ側がSonnet系で拡張思考を有効にする挙動があり、
// thinkingトークンにmax_tokens予算の大半を消費されてJSON本文が途中で打ち切られる不具合があったため
// (このアプリの用途は構造化JSON出力の厳密な生成が最優先で、自由な長考は必要ない)
async function callClaudeRaw(system, messages, maxTokens = 1024, model = AI_MODEL) {
  const res = await fetch(AI_PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages, thinking: { type: 'disabled' } }),
  });
  if (!res.ok) throw new Error(`AI proxy error: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function callClaude(system, messages, maxTokens = 1024, model = AI_MODEL) {
  const data = await callClaudeRaw(system, messages, maxTokens, model);
  return extractClaudeText(data);
}

// ============================================================
// HARDCODED PARAMETER ENUMS / SCHEMAS
// ============================================================
const LANGUAGE_CODES = ['ja','en','ko','zh','zh-Hant','fr','de','es','pt','it','ru','th','vi','id','ms','ar','hi'];
const COUNTRY_CODES  = ['jp','us','kr','cn','tw','hk','gb','fr','de','es','it','au','ca','sg','th','vn','id','my','in','br'];
const MAPBOX_TYPES   = ['country','region','postcode','district','place','city','locality','neighborhood','block','street','address','poi','category'];

// Google Places API "Table A" place types (公式ドキュメントより。includedType / type で使用)
const GOOGLE_PLACE_TYPES = [
  // Automotive
  'car_dealer','car_rental','car_repair','car_wash','ebike_charging_station','electric_vehicle_charging_station','gas_station','parking','parking_garage','parking_lot','rest_stop','tire_shop','truck_dealer',
  // Business
  'business_center','corporate_office','coworking_space','farm','manufacturer','ranch','supplier','television_studio',
  // Culture
  'art_gallery','art_museum','art_studio','auditorium','castle','cultural_landmark','fountain','historical_place','history_museum','monument','museum','performing_arts_theater','sculpture',
  // Education
  'academic_department','educational_institution','library','preschool','primary_school','research_institute','school','secondary_school','university',
  // Entertainment and Recreation
  'adventure_sports_center','amphitheatre','amusement_center','amusement_park','aquarium','banquet_hall','barbecue_area','botanical_garden','bowling_alley','casino','childrens_camp','city_park','comedy_club','community_center','concert_hall','convention_center','cultural_center','cycling_park','dance_hall','dog_park','event_venue','ferris_wheel','garden','go_karting_venue','hiking_area','historical_landmark','indoor_playground','internet_cafe','karaoke','live_music_venue','marina','miniature_golf_course','movie_rental','movie_theater','national_park','night_club','observation_deck','off_roading_area','opera_house','paintball_center','park','philharmonic_hall','picnic_ground','planetarium','plaza','roller_coaster','skateboard_park','state_park','tourist_attraction','video_arcade','vineyard','visitor_center','water_park','wedding_venue','wildlife_park','wildlife_refuge','zoo',
  // Facilities
  'public_bath','public_bathroom','stable',
  // Finance
  'accounting','atm','bank',
  // Food and Drink
  'acai_shop','afghani_restaurant','african_restaurant','american_restaurant','argentinian_restaurant','asian_fusion_restaurant','asian_restaurant','australian_restaurant','austrian_restaurant','bagel_shop','bakery','bangladeshi_restaurant','bar','bar_and_grill','barbecue_restaurant','basque_restaurant','bavarian_restaurant','beer_garden','belgian_restaurant','bistro','brazilian_restaurant','breakfast_restaurant','brewery','brewpub','british_restaurant','brunch_restaurant','buffet_restaurant','burmese_restaurant','burrito_restaurant','cafe','cafeteria','cajun_restaurant','cake_shop','californian_restaurant','cambodian_restaurant','candy_store','cantonese_restaurant','caribbean_restaurant','cat_cafe','chicken_restaurant','chicken_wings_restaurant','chilean_restaurant','chinese_noodle_restaurant','chinese_restaurant','chocolate_factory','chocolate_shop','cocktail_bar','coffee_roastery','coffee_shop','coffee_stand','colombian_restaurant','confectionery','croatian_restaurant','cuban_restaurant','czech_restaurant','danish_restaurant','deli','dessert_restaurant','dessert_shop','dim_sum_restaurant','diner','dog_cafe','donut_shop','dumpling_restaurant','dutch_restaurant','eastern_european_restaurant','ethiopian_restaurant','european_restaurant','falafel_restaurant','family_restaurant','fast_food_restaurant','filipino_restaurant','fine_dining_restaurant','fish_and_chips_restaurant','fondue_restaurant','food_court','french_restaurant','fusion_restaurant','gastropub','german_restaurant','greek_restaurant','gyro_restaurant','halal_restaurant','hamburger_restaurant','hawaiian_restaurant','hookah_bar','hot_dog_restaurant','hot_dog_stand','hot_pot_restaurant','hungarian_restaurant','ice_cream_shop','indian_restaurant','indonesian_restaurant','irish_pub','irish_restaurant','israeli_restaurant','italian_restaurant','japanese_curry_restaurant','japanese_izakaya_restaurant','japanese_restaurant','juice_shop','kebab_shop','korean_barbecue_restaurant','korean_restaurant','latin_american_restaurant','lebanese_restaurant','lounge_bar','malaysian_restaurant','meal_delivery','meal_takeaway','mediterranean_restaurant','mexican_restaurant','middle_eastern_restaurant','mongolian_barbecue_restaurant','moroccan_restaurant','noodle_shop','north_indian_restaurant','oyster_bar_restaurant','pakistani_restaurant','pastry_shop','persian_restaurant','peruvian_restaurant','pizza_delivery','pizza_restaurant','polish_restaurant','portuguese_restaurant','pub','ramen_restaurant','restaurant','romanian_restaurant','russian_restaurant','salad_shop','sandwich_shop','scandinavian_restaurant','seafood_restaurant','shawarma_restaurant','snack_bar','soul_food_restaurant','soup_restaurant','south_american_restaurant','south_indian_restaurant','southwestern_us_restaurant','spanish_restaurant','sports_bar','sri_lankan_restaurant','steak_house','sushi_restaurant','swiss_restaurant','taco_restaurant','taiwanese_restaurant','tapas_restaurant','tea_house','tex_mex_restaurant','thai_restaurant','tibetan_restaurant','tonkatsu_restaurant','turkish_restaurant','ukrainian_restaurant','vegan_restaurant','vegetarian_restaurant','vietnamese_restaurant','western_restaurant','wine_bar','winery','yakiniku_restaurant','yakitori_restaurant',
  // Geographical Areas
  'administrative_area_level_1','administrative_area_level_2','country','locality','postal_code','school_district',
  // Government
  'city_hall','courthouse','embassy','fire_station','government_office','local_government_office','neighborhood_police_station','police','post_office',
  // Health and Wellness
  'chiropractor','dental_clinic','dentist','doctor','drugstore','general_hospital','hospital','massage','massage_spa','medical_center','medical_clinic','medical_lab','pharmacy','physiotherapist','sauna','skin_care_clinic','spa','tanning_studio','wellness_center','yoga_studio',
  // Housing
  'apartment_building','apartment_complex','condominium_complex','housing_complex',
  // Lodging
  'bed_and_breakfast','budget_japanese_inn','campground','camping_cabin','cottage','extended_stay_hotel','farmstay','guest_house','hostel','hotel','inn','japanese_inn','lodging','mobile_home_park','motel','private_guest_room','resort_hotel','rv_park',
  // Natural Features
  'beach','island','lake','mountain_peak','nature_preserve','river','scenic_spot','woods',
  // Places of Worship
  'buddhist_temple','church','hindu_temple','mosque','shinto_shrine','synagogue',
  // Services
  'aircraft_rental_service','association_or_organization','astrologer','barber_shop','beautician','beauty_salon','body_art_service','catering_service','cemetery','chauffeur_service','child_care_agency','consultant','courier_service','electrician','employment_agency','florist','food_delivery','foot_care','funeral_home','hair_care','hair_salon','insurance_agency','laundry','lawyer','locksmith','makeup_artist','marketing_consultant','moving_company','nail_salon','non_profit_organization','painter','pet_boarding_service','pet_care','plumber','psychic','real_estate_agency','roofing_contractor','service','shipping_service','storage','summer_camp_organizer','tailor','telecommunications_service_provider','tour_agency','tourist_information_center','travel_agency','veterinary_care',
  // Shopping
  'asian_grocery_store','auto_parts_store','bicycle_store','book_store','building_materials_store','butcher_shop','cell_phone_store','clothing_store','convenience_store','cosmetics_store','department_store','discount_store','discount_supermarket','electronics_store','farmers_market','flea_market','food_store','furniture_store','garden_center','general_store','gift_shop','grocery_store','hardware_store','health_food_store','home_goods_store','home_improvement_store','hypermarket','jewelry_store','liquor_store','market','pet_store','shoe_store','shopping_mall','sporting_goods_store','sportswear_store','store','supermarket','tea_store','thrift_store','toy_store','warehouse_store','wholesaler','womens_clothing_store',
  // Sports
  'arena','athletic_field','fishing_charter','fishing_pier','fishing_pond','fitness_center','golf_course','gym','ice_skating_rink','indoor_golf_course','playground','race_course','ski_resort','sports_activity_location','sports_club','sports_coaching','sports_complex','sports_school','stadium','swimming_pool','tennis_court',
  // Transportation
  'airport','airstrip','bike_sharing_station','bridge','bus_station','bus_stop','ferry_service','ferry_terminal','heliport','international_airport','light_rail_station','park_and_ride','subway_station','taxi_service','taxi_stand','toll_station','train_station','train_ticket_office','tram_stop','transit_depot','transit_station','transit_stop','transportation_service','truck_stop',
];

// dot-path 経由の get/set（配列インデックスも文字列キーで統一的に扱える）
function getPath(obj, path) { return path.split('.').reduce((o,k) => (o == null ? undefined : o[k]), obj); }
function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i], nextIsIndex = /^\d+$/.test(keys[i+1]);
    if (cur[k] == null) cur[k] = nextIsIndex ? [] : {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

const GOOGLE_LEGACY_FIELDS = [
  { path:'language', label:'language', widget:'datalist', options: LANGUAGE_CODES },
  { path:'region',   label:'region',   widget:'datalist', options: COUNTRY_CODES },
  { path:'location.lat', label:'location.lat', widget:'number', step:0.000001 },
  { path:'location.lng', label:'location.lng', widget:'number', step:0.000001 },
  { path:'radius',   label:'radius (m, ≤50000)', widget:'number', min:0, max:50000 },
  { path:'types',    label:'type', widget:'array-first-datalist', options: GOOGLE_PLACE_TYPES },
  { path:'minprice', label:'minprice', widget:'select', options:[0,1,2,3,4] },
  { path:'maxprice', label:'maxprice', widget:'select', options:[0,1,2,3,4] },
  { path:'opennow',  label:'opennow', widget:'checkbox' },
];

const GOOGLE_NEW_FIELDS = [
  { path:'languageCode', label:'languageCode', widget:'datalist', options: LANGUAGE_CODES },
  { path:'regionCode',   label:'regionCode',   widget:'datalist', options: COUNTRY_CODES },
  { path:'includedType', label:'includedType', widget:'datalist', options: GOOGLE_PLACE_TYPES },
  { path:'rankPreference', label:'rankPreference', widget:'select', options:['RELEVANCE','DISTANCE'] },
  { path:'locationRestriction.rectangle.low.latitude',   label:'rect.low.lat',  widget:'number', step:0.000001 },
  { path:'locationRestriction.rectangle.low.longitude',  label:'rect.low.lng',  widget:'number', step:0.000001 },
  { path:'locationRestriction.rectangle.high.latitude',  label:'rect.high.lat', widget:'number', step:0.000001 },
  { path:'locationRestriction.rectangle.high.longitude', label:'rect.high.lng', widget:'number', step:0.000001 },
  { path:'priceLevels', label:'priceLevels', widget:'multiselect', options:['PRICE_LEVEL_FREE','PRICE_LEVEL_INEXPENSIVE','PRICE_LEVEL_MODERATE','PRICE_LEVEL_EXPENSIVE','PRICE_LEVEL_VERY_EXPENSIVE'] },
  { path:'openNow',   label:'openNow',   widget:'checkbox' },
  { path:'minRating', label:'minRating (0-5, 0.5刻み)', widget:'number', min:0, max:5, step:0.5 },
  { path:'pageSize',  label:'pageSize (1-20)', widget:'number', min:1, max:20 },
];

const MAPBOX_FIELDS = [
  { path:'proximity.lat', label:'proximity.lat', widget:'number', step:0.000001 },
  { path:'proximity.lng', label:'proximity.lng', widget:'number', step:0.000001 },
  { path:'bbox.0', label:'bbox.west',  widget:'number', step:0.000001 },
  { path:'bbox.1', label:'bbox.south', widget:'number', step:0.000001 },
  { path:'bbox.2', label:'bbox.east',  widget:'number', step:0.000001 },
  { path:'bbox.3', label:'bbox.north', widget:'number', step:0.000001 },
  { path:'types',  label:'types', widget:'multiselect', options: MAPBOX_TYPES },
  { path:'poi_category', label:'poi_category', widget:'text-array' },
  { path:'poi_category_exclusion', label:'poi_category_exclusion', widget:'text-array' },
  { path:'limit', label:'limit (≤30, private beta)', widget:'number', min:1, max:30 },
  { path:'language', label:'language', widget:'datalist', options: LANGUAGE_CODES },
  { path:'country',  label:'country',  widget:'datalist', options: COUNTRY_CODES },
  { path:'near', label:'near', widget:'text' },
  { path:'navigation_profile', label:'navigation_profile', widget:'select', options:['driving','walking','cycling'] },
];

function getEngineFields(engine) {
  if (engine === 'mapbox') return MAPBOX_FIELDS;
  return googleApiMode === 'new' ? GOOGLE_NEW_FIELDS : GOOGLE_LEGACY_FIELDS;
}

// スキーマ駆動の汎用パラメータフォームレンダラ
function renderParamForm(container, fields, stateObj, onChange) {
  container.innerHTML = '';
  fields.forEach(f => {
    const row = document.createElement('div');
    row.className = 'param-row';
    const label = document.createElement('label');
    label.textContent = f.label || f.path;
    row.appendChild(label);
    const rawVal = getPath(stateObj, f.path);
    let input;

    if (f.widget === 'select') {
      input = document.createElement('select');
      input.innerHTML = `<option value="">(none)</option>` + f.options.map(o => `<option value="${o}">${o}</option>`).join('');
      input.value = rawVal ?? '';
      input.addEventListener('change', () => { setPath(stateObj, f.path, input.value === '' ? undefined : input.value); onChange(f.path); });
    } else if (f.widget === 'multiselect') {
      input = document.createElement('div');
      input.className = 'param-multiselect';
      const current = Array.isArray(rawVal) ? rawVal : [];
      input.innerHTML = f.options.map(o => `<label><input type="checkbox" data-opt="${o}" ${current.includes(o) ? 'checked' : ''}/> ${o}</label>`).join('');
      input.addEventListener('change', () => {
        const checked = Array.from(input.querySelectorAll('input:checked')).map(c => c.dataset.opt);
        setPath(stateObj, f.path, checked); onChange(f.path);
      });
    } else if (f.widget === 'text-array') {
      input = document.createElement('input'); input.type = 'text';
      // CSV等から%エンコード済みの値が入ってくることがあるため、表示前にデコードする(壊れたシーケンスは元の値のまま)
      const decodeSafe = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
      input.value = Array.isArray(rawVal) ? rawVal.map(decodeSafe).join(',') : (rawVal ?? '');
      input.placeholder = 'カンマ区切り';
      input.addEventListener('change', () => {
        const arr = input.value.split(',').map(s => s.trim()).filter(Boolean);
        setPath(stateObj, f.path, arr); onChange(f.path);
      });
    } else if (f.widget === 'datalist') {
      const listId = `dl_${f.path}`.replace(/[^a-zA-Z0-9]/g, '_');
      input = document.createElement('input'); input.type = 'text'; input.setAttribute('list', listId);
      input.value = rawVal ?? '';
      const dl = document.createElement('datalist'); dl.id = listId;
      dl.innerHTML = f.options.map(o => `<option value="${o}">`).join('');
      row.appendChild(dl);
      input.addEventListener('change', () => { setPath(stateObj, f.path, input.value === '' ? undefined : input.value); onChange(f.path); });
    } else if (f.widget === 'array-first-datalist') {
      const listId = `dl_${f.path}`.replace(/[^a-zA-Z0-9]/g, '_');
      input = document.createElement('input'); input.type = 'text'; input.setAttribute('list', listId);
      const arr = Array.isArray(rawVal) ? rawVal : [];
      input.value = arr[0] ?? '';
      const dl = document.createElement('datalist'); dl.id = listId;
      dl.innerHTML = f.options.map(o => `<option value="${o}">`).join('');
      row.appendChild(dl);
      input.addEventListener('change', () => { setPath(stateObj, f.path, input.value ? [input.value] : []); onChange(f.path); });
    } else if (f.widget === 'number') {
      input = document.createElement('input'); input.type = 'number';
      if (f.min != null) input.min = f.min;
      if (f.max != null) input.max = f.max;
      if (f.step != null) input.step = f.step;
      input.value = rawVal ?? '';
      input.addEventListener('change', () => {
        const v = input.value === '' ? undefined : Number(input.value);
        setPath(stateObj, f.path, v);
        // proximity/bbox手動編集フラグの反映はApply時にqueryDialogTouchedを見て行う(ここではドラフトを触るだけ)
        onChange(f.path);
      });
    } else if (f.widget === 'checkbox') {
      input = document.createElement('input'); input.type = 'checkbox';
      input.checked = !!rawVal;
      input.addEventListener('change', () => { setPath(stateObj, f.path, input.checked || undefined); onChange(f.path); });
    } else {
      input = document.createElement('input'); input.type = 'text';
      input.value = rawVal ?? '';
      input.addEventListener('change', () => { setPath(stateObj, f.path, input.value === '' ? undefined : input.value); onChange(f.path); });
    }

    row.appendChild(input);
    container.appendChild(row);
  });
}

// ============================================================
// CONSTANTS
// ============================================================
const DEFAULT_LAT    = 35.6631696325232;
const DEFAULT_LNG    = 139.75565770549306;
const DEFAULT_RADIUS = 2000;

const DEFAULT_GOOGLE_PARAMS_NEW = {
  languageCode: 'ja', regionCode: 'jp', pageSize: 10,
  locationRestriction: {
    rectangle: {
      low:  { latitude:  DEFAULT_LAT - DEFAULT_RADIUS/111000, longitude: DEFAULT_LNG - DEFAULT_RADIUS/111000 },
      high: { latitude:  DEFAULT_LAT + DEFAULT_RADIUS/111000, longitude: DEFAULT_LNG + DEFAULT_RADIUS/111000 },
    },
  },
  includedType: '', rankPreference: 'RELEVANCE',
};

const DEFAULT_GOOGLE_PARAMS_LEGACY = {
  language: 'ja', region: 'jp',
  location: { lat: DEFAULT_LAT, lng: DEFAULT_LNG },
  radius: DEFAULT_RADIUS, types: [],
};

const DEFAULT_MAPBOX_PARAMS = {
  language: 'ja', country: 'jp',
  proximity: { lng: DEFAULT_LNG, lat: DEFAULT_LAT },
  limit: 10, types: [],
  // navigation_profileはデフォルトなし(none)。フォームで明示的に選択された場合のみ付与
  // bboxはデフォルトなし。BBOXボタンで有効化
};

// ============================================================
// STATE
// ============================================================
let googleApiMode = 'legacy';
let state = {
  query: '',
  googleParams: structuredClone(DEFAULT_GOOGLE_PARAMS_LEGACY),
  mapboxParams:  structuredClone(DEFAULT_MAPBOX_PARAMS),
};

// proximity/bboxをFormで直接編集した場合、地図ピン操作やCSV行選択による自動追従で上書きされないようにするフラグ。
// setLocationPin()(地図クリック/ドラッグ、CSV行のlat/lng)またはmapboxパラメータのResetでfalseに戻る(=自動追従を復活させる)
let mapboxProximityManual = false;
let mapboxBboxManual      = false;

// proximity/bbox以外のパラメータ(types, poi_category, limit, language, country, near, navigation_profile等)を
// Form/JSONエディタで手動編集した場合、CSV行選択(applyCsvRowToState)による無条件上書きから保護するためのフィールド集合。
// (bbox/proximityと違って「行が変わったら自動でリセット」ではなく、Resetボタンを押すまで保持し続ける)
let manualMapboxFields = new Set();
let manualGoogleFields = new Set();
function markFieldManual(engine, path) {
  (engine === 'mapbox' ? manualMapboxFields : manualGoogleFields).add(path);
}

// ============================================================
// CSV STATE
// ============================================================
let csvHeaders    = [];   // 元CSVのヘッダー配列
let csvRawRows    = [];   // [{header: value, ...}, ...]
let csvIndex      = -1;
let csvMapping    = null; // { columns: [{header, mapboxRole, googleRole}] }
let currentCsvFileName = '';
let currentCsvFileId   = ''; // ファイル名+内容ハッシュ。同じファイルの再読込を検知するためのキー

// CSV読み込み中のクエリにのみ有効な、実際のMapbox検索パラメータからbbox/navigation_profileを
// 丸ごと除外する単純なオーバーライド(手動クエリでは無視・AI自動診断ロジックとは無関係)
let csvIgnoreBbox       = false;
let csvIgnoreNavProfile = false;

// query_type列(CSVマッピング確認モーダルでMapbox/Googleどちらの役割でもない列として選択。#の右隣に表示し、ヘッダークリックでチェックボックスフィルタを開く)
let csvQueryTypeColumn   = null;   // 選択されたCSV列名。未選択/(none)ならnull
let csvHasQueryType      = false;
let csvQueryTypeValues   = [];      // 出現するユニーク値(初出順、空文字も1値として含む)
let csvQueryTypeSelected = new Set(); // 適用中の選択(全件選択時はフィルタなしとして扱う)
let csvQueryTypePending  = new Set(); // モーダル編集中の一時選択(Cancelで破棄)

// query_count列(query_typeと同様にMapbox/Googleの役割ではない列として選択。#の右隣に表示)
// ヘッダークリックでソート(昇順/降順)+ n以上フィルタのモーダルを開く
let csvQueryCountColumn = null;   // 選択されたCSV列名。未選択/(none)ならnull
let csvHasQueryCount    = false;
let csvQueryCountMin    = null;   // 適用中のしきい値(n以上のみ表示)。nullはフィルタなし
let csvQueryCountMinPending = null; // モーダル編集中の一時値(Cancelで破棄)

// 行の並び順。sortField: null(元の順序) | 'index'(#列クリック) | 'querycount'(query_countモーダルで適用)
// 直近に確定した方が優先される(片方しか同時に有効にならない)
let csvSortField = null;
let csvSortDir   = 'asc'; // 'asc' | 'desc'

// ============================================================
// FEEDBACK (検索結果への 👍/👎 評価)
// ============================================================
const FEEDBACK_REASONS = [
  { category: 'Coverage', items: ['poi coverage', 'poi coverage (bus)', 'poi coverage (brand)', 'poi freshness', 'poi coverage (parking lot)', 'address coverage'] },
  { category: 'Fuzzy Search', items: ['synonym coverage', 'wrong synonym', 'prefix match', 'subsequence match', 'suffix match', 'edit distance match', 'alphabet for kana', 'different kana for alphabet', 'hyphen for kana', 'ignore letter size', 'multiple reading', 'ignore space'] },
  { category: 'Bug', items: ['poi duplication', 'wrong poi', 'wrong address'] },
  { category: 'Others', items: ['location intent', 'category intent', 'prominence score'] },
];
// GOODを押した際の内訳(順位まで含めて精度を見る方針のため、1位での正解/正解はしているが1位ではない、を区別する)。
// Conditionalは「今のパラメータ設定ではNGだが、パラメータを直せば通る」ケース(テスト設定のミスと製品側の
// 実力不足を切り分けるため、bad扱いにはしない)。選択時のみ追加でCONDITIONAL_GOOD_PRESETS+自由入力を聞く
const CONDITIONAL_GOOD_REASON = 'Conditional (would pass with a param fix)';
const GOOD_REASONS = ['Perfect (Correct POI at top)', 'Almost! (Correct POI but not ranked at top)', CONDITIONAL_GOOD_REASON];
// Conditionalを選んだ時のプリセットチェックボックス(複数選択可・自由入力と併用)
const CONDITIONAL_GOOD_PRESETS = ['Types filter excluded correct type'];
// 判定結果は3分類(good/bad/unclear)。旧not_hit_both(Mapbox/Google両方ヒットせず)は独立カテゴリとして扱わず、
// 「Is google result ok?」のNoで表現する(ツールの目的はSearch Box自体の品質検証で、Google側の結果も
// 無かったというのはあくまで補足情報のため)
// unclearの内訳: クエリ自体が壊れている/意味不明ならunknown query、クエリは読み取れるが粒度不足で
// 複数の実在候補に分かれ特定できない場合はtoo ambiguous query
const UNCLEAR_REASONS = ['unknown query', 'too ambiguous query'];
function resultIconOf(result) {
  if (result === 'good') return '👍';
  if (result === 'unclear') return 'Unclear';
  if (result === 'bad') return '👎';
  return result || '';
}

// ============================================================
// 手動フィードバック v2: 「1クエリ = nチケット」データモデル
// テスト結果は per-query で以下の3状態のいずれかに終端する:
//   no_issue(問題なし) / out_of_scope(クエリ自体がテスト対象外) / problem(n件のチケット)
// GOOD内訳(Perfect/Almost!/Conditional)とIs google result ok?軸は手動フロー・AI診断フローの
// 両方から撤去済み(GOOD_REASONS/CONDITIONAL_GOOD_REASON等の定数とtryTypesMismatchRescue関数自体は、
// 呼び出し元が無くなった状態のまま参照用に残置している)
// ============================================================
// データの問題(Mapboxのデータそのものの不備)。poi_missingだけdataSubtypeで下位分類を持つ。
// ラベルは旧FEEDBACK_REASONSの用語をそのまま使う(poi coverage/wrong poi/poi duplication/address coverage/wrong address)。
// 住所側はPOIと非対称で「重複」という概念自体が無い(address_duplicateは存在しない、wrong addressのみ)
const DATA_ISSUES = [
  { value: 'poi_missing',         label: 'poi coverage' },
  { value: 'poi_attribute_wrong', label: 'wrong poi' },
  { value: 'poi_duplicate',       label: 'poi duplication' },
  { value: 'address_missing',     label: 'address coverage' },
  { value: 'address_wrong',       label: 'wrong address' },
];
// 旧Coverageのbus/brand/parking lotの粒度を温存(poi_missingを選んだ時だけ聞く)
const POI_MISSING_SUBTYPES = [
  { value: 'general',     label: 'General' },
  { value: 'bus',         label: 'Bus stop' },
  { value: 'brand',       label: 'Brand' },
  { value: 'parking_lot', label: 'Parking lot' },
];
const DATA_ACTIONS = [
  { value: 'add',    label: 'Add' },
  { value: 'fix',    label: 'Fix' },
  { value: 'delete', label: 'Delete' },
];
// データ問題の種別ごとの初期アクション(AI診断からの自動変換専用。手動フローでは単に選択肢として並べるだけ)
const DEFAULT_ACTION_FOR_DATA_ISSUE = {
  poi_missing: 'add', poi_attribute_wrong: 'fix', poi_duplicate: 'delete',
  address_missing: 'add', address_wrong: 'fix',
};
// 検索エンジンの問題は既存のFuzzy Search/Othersの項目群をそのまま複数選択の選択肢として流用する
const SEARCH_ENGINE_ISSUE_GROUPS = FEEDBACK_REASONS.filter(g => g.category === 'Fuzzy Search' || g.category === 'Others');
// テスト対象外(旧unclear)のreasonは既存のUNCLEAR_REASONSをそのまま使う

const LS_FEEDBACK = 'apc_feedback_log';
function loadFeedbackLog() { try { return JSON.parse(localStorage.getItem(LS_FEEDBACK) || '[]'); } catch { return []; } }
function saveFeedbackLog(log) { localStorage.setItem(LS_FEEDBACK, JSON.stringify(log)); }
let feedbackLog = loadFeedbackLog();

// 簡易ハッシュ(djb2系)。CSVの中身が同じかどうかの判定用(暗号強度は不要)
function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function feedbackKey(ctx) {
  return ctx.fileId ? `${ctx.fileId}::${ctx.rowIndex}` : `manual::${ctx.query}`;
}

// v2エントリ(type: 'ticket'|'state'を持つもの)だけを対象に、指定keyの最新ラウンド(roundId)を特定する。
// レガシー(v1, typeを持たない)エントリは無視する(feedbackLogには残り続けエクスポート可能だが、
// 行の現在状態には出さない)
function getLatestRoundId(key) {
  for (let i = feedbackLog.length - 1; i >= 0; i--) {
    const e = feedbackLog[i];
    if (e.key === key && e.roundId) return e.roundId;
  }
  return null;
}

// 行の現在状態を返す。{ state: 'no_issue'|'out_of_scope'|'problem', reason, tickets } または未テストならnull
function getRowFeedback(rowIdx) {
  if (!currentCsvFileId) return null;
  const key = `${currentCsvFileId}::${rowIdx}`;
  const roundId = getLatestRoundId(key);
  if (!roundId) return null;
  const entries = feedbackLog.filter(e => e.key === key && e.roundId === roundId);
  const stateEntry = entries.find(e => e.type === 'state');
  const tickets = entries.filter(e => e.type === 'ticket');
  if (stateEntry) return { state: stateEntry.state, reason: stateEntry.reason || null, tickets: [] };
  if (tickets.length) return { state: 'problem', reason: null, tickets };
  return null;
}

// 新規テストラウンド開始時に払い出すID。再テスト時に前回ラウンドのチケットと混ざらないようにするための識別子
function newRoundId() {
  return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

// クエリ全体の終端ステート(no_issue/out_of_scope)を記録する。1ラウンドにつき1件のみ
function recordState(ctx, state, reason) {
  const entry = {
    type: 'state', key: feedbackKey(ctx), roundId: ctx.roundId, state, reason: reason || null,
    query: ctx.query, fileName: ctx.fileName || null, rowIndex: ctx.rowIndex ?? null,
    timestamp: new Date().toISOString(),
  };
  feedbackLog.push(entry);
  saveFeedbackLog(feedbackLog);
  return entry;
}

// 個別チケットを記録する。1ラウンドにつきn件追加できる
function recordTicket(ctx, ticket) {
  const entry = {
    id: newRoundId(), // 同一msecでの連続追加でもtimestampが衝突しないよう、削除時の識別には専用idを使う
    type: 'ticket', key: feedbackKey(ctx), roundId: ctx.roundId,
    problemType: ticket.problemType,
    dataIssue: ticket.dataIssue || null, dataSubtype: ticket.dataSubtype || null, action: ticket.action || null,
    searchEngineIssues: (ticket.searchEngineIssues && ticket.searchEngineIssues.length) ? ticket.searchEngineIssues : null,
    note: ticket.note || null,
    query: ctx.query, fileName: ctx.fileName || null, rowIndex: ctx.rowIndex ?? null,
    timestamp: new Date().toISOString(),
  };
  feedbackLog.push(entry);
  saveFeedbackLog(feedbackLog);
  return entry;
}

// 現在のラウンドで既に記録済みのチケット一覧(パネルの「追加済みチケット」表示用)
function getRoundTickets(ctx) {
  if (!ctx || !ctx.roundId) return [];
  const key = feedbackKey(ctx);
  return feedbackLog.filter(e => e.type === 'ticket' && e.key === key && e.roundId === ctx.roundId);
}

// 追加直後のチケットを取り消す(送信前の訂正用。ラウンド確定後の取り消しは対象外)
function removeTicket(ctx, id) {
  const key = feedbackKey(ctx);
  const idx = feedbackLog.findIndex(e => e.type === 'ticket' && e.key === key && e.roundId === ctx.roundId && e.id === id);
  if (idx !== -1) { feedbackLog.splice(idx, 1); saveFeedbackLog(feedbackLog); }
}

// 行ステータスの表示バッジ(CSV一覧・状態アイコン+チケット件数)
function rowStatusBadge(fb) {
  if (!fb) return '';
  if (fb.state === 'no_issue') return '✅';
  if (fb.state === 'out_of_scope') return '➖';
  if (fb.state === 'problem') return `🐞×${fb.tickets.length}`;
  return '';
}

let feedbackContext  = null;   // { fileId, fileName, rowIndex, query, roundId } —直近の検索がどのクエリ/行に対するものか
// 'idle' | 'start' | 'add_ticket' | 'out_of_scope_reason'
let feedbackPanelMode = 'idle';
// 'add_ticket'モード中の入力途中のチケット下書き。Add押下でrecordTicketされクリアされる
let feedbackTicketDraft = null; // { problemType, dataIssue, dataSubtype, action, searchEngineIssues, note }

// タブは廃止し、単一パネルにした。AIテスト実行中(aiDiagStateがidle以外)はAIカードを、
// それ以外は通常のチケット入力画面(renderManualFeedbackPanel)を表示する
function renderFeedbackPanel() {
  if (aiDiagState !== 'idle') { renderAiDiagPanel(); return; }
  renderManualFeedbackPanel();
}

// ラウンド確定(No Issue/Out of scope/Doneのいずれか)の共通後処理
function closeRound() {
  feedbackPanelMode = 'idle';
  feedbackTicketDraft = null;
  feedbackContext = null;
  aiDiagState = 'idle'; aiDiagProposal = null;
  renderFeedbackPanel();
  if (currentCsvFileId) renderCSVViewport(); // このクエリがCSV行に紐づく場合、行ステータスに反映

  // ファイル読み込み中で次の行があれば自動遷移
  if (csvMapping && csvIndex >= 0 && csvIndex < csvRawRows.length - 1) {
    jumpToCSVRow(csvIndex + 1);
  }
}

function finalizeNoIssue() {
  if (!feedbackContext) return;
  recordState(feedbackContext, 'no_issue', null);
  closeRound();
}

function finalizeOutOfScope(reason) {
  if (!feedbackContext) return;
  recordState(feedbackContext, 'out_of_scope', reason);
  closeRound();
}

function startAddTicket() {
  feedbackTicketDraft = { problemType: null, dataIssue: null, dataSubtype: null, action: null };
  feedbackPanelMode = 'add_ticket';
  renderFeedbackPanel();
}

function submitTicketDraft() {
  const d = feedbackTicketDraft;
  if (!d || !feedbackContext) return;
  const noteEl = document.getElementById('fb-ticket-note');
  const note = noteEl ? noteEl.value.trim() : '';
  if (d.problemType === 'data') {
    if (!d.dataIssue || !d.action) return;
    recordTicket(feedbackContext, {
      problemType: 'data', dataIssue: d.dataIssue,
      dataSubtype: d.dataIssue === 'poi_missing' ? (d.dataSubtype || 'general') : null,
      action: d.action, note,
    });
  } else if (d.problemType === 'search_engine') {
    const checked = [...document.querySelectorAll('.fb-se-checkbox:checked')].map(c => c.value);
    if (!checked.length) return;
    recordTicket(feedbackContext, { problemType: 'search_engine', searchEngineIssues: checked, note });
  } else {
    return;
  }
  feedbackTicketDraft = null;
  feedbackPanelMode = 'start';
  renderFeedbackPanel();
}

// チケット1件を「行の要約行」用の短いラベルにする(Data issue → action / Search engineの選択項目)
function ticketSummaryLabel(t) {
  if (t.problemType === 'data') {
    const issue = DATA_ISSUES.find(x => x.value === t.dataIssue);
    const subtype = (t.dataSubtype && t.dataSubtype !== 'general') ? POI_MISSING_SUBTYPES.find(x => x.value === t.dataSubtype) : null;
    const action = DATA_ACTIONS.find(x => x.value === t.action);
    return `${issue?.label || t.dataIssue}${subtype ? `(${subtype.label})` : ''} → ${action?.label || t.action}`;
  }
  return (t.searchEngineIssues || []).join(', ');
}

function renderManualFeedbackPanel() {
  const body = document.getElementById('feedback-body');

  if (feedbackPanelMode === 'start') {
    const tickets = getRoundTickets(feedbackContext);
    const ticketListHtml = tickets.length ? `
      <div class="fb-ticket-list">
        ${tickets.map(t => `
          <div class="fb-ticket-item">
            <span class="fb-ticket-item-label">${esc(ticketSummaryLabel(t))}</span>
            <button class="fb-ticket-item-remove" data-id="${esc(t.id)}" title="削除">✕</button>
          </div>`).join('')}
      </div>` : '';
    body.innerHTML = `
      ${ticketListHtml}
      <div class="fb-buttons">
        ${tickets.length === 0 ? `
          <button class="btn btn-secondary fb-btn fb-btn-text" id="fb-no-issue-btn">No Issue</button>
          <button class="btn btn-secondary fb-btn fb-btn-text" id="fb-out-of-scope-btn">Out of scope</button>` : ''}
        <button class="btn btn-secondary fb-btn fb-btn-text" id="fb-add-ticket-btn">+ Add Issue</button>
        <button class="btn btn-secondary fb-btn fb-btn-text" id="fb-ai-test-btn">AI Test (Only Data)</button>
        ${tickets.length > 0 ? `<button class="btn btn-primary fb-btn fb-btn-text" id="fb-done-btn">Done</button>` : ''}
      </div>`;
    if (tickets.length === 0) {
      document.getElementById('fb-no-issue-btn').addEventListener('click', finalizeNoIssue);
      document.getElementById('fb-out-of-scope-btn').addEventListener('click', () => { feedbackPanelMode = 'out_of_scope_reason'; renderFeedbackPanel(); });
    } else {
      document.getElementById('fb-done-btn').addEventListener('click', closeRound);
    }
    document.getElementById('fb-add-ticket-btn').addEventListener('click', startAddTicket);
    document.getElementById('fb-ai-test-btn').addEventListener('click', runAiDiagnosis);
    body.querySelectorAll('.fb-ticket-item-remove').forEach(btn => {
      btn.addEventListener('click', () => { removeTicket(feedbackContext, btn.dataset.id); renderFeedbackPanel(); });
    });
    return;
  }

  if (feedbackPanelMode === 'out_of_scope_reason') {
    body.innerHTML = `
      <button class="btn btn-secondary fb-back-btn" id="fb-back-btn">← Back</button>
      <div class="fb-reason-list">
        ${UNCLEAR_REASONS.map(label => `<button class="btn btn-secondary fb-reason-btn" data-reason="${esc(label)}">${esc(label)}</button>`).join('')}
      </div>`;
    document.getElementById('fb-back-btn').addEventListener('click', () => { feedbackPanelMode = 'start'; renderFeedbackPanel(); });
    body.querySelectorAll('.fb-reason-btn').forEach(btn => {
      btn.addEventListener('click', () => finalizeOutOfScope(btn.dataset.reason));
    });
    return;
  }

  if (feedbackPanelMode === 'add_ticket' && feedbackTicketDraft) {
    const d = feedbackTicketDraft;
    const dataSection = d.problemType === 'data' ? `
      <div class="fb-reason-group">Data issue</div>
      <div class="fb-reason-list">
        ${DATA_ISSUES.map(x => `<button class="btn btn-secondary fb-reason-btn ${d.dataIssue === x.value ? 'fb-selected' : ''}" data-dataissue="${esc(x.value)}">${esc(x.label)}</button>`).join('')}
      </div>
      ${d.dataIssue === 'poi_missing' ? `
        <div class="fb-reason-group">Subtype</div>
        <div class="fb-reason-list">
          ${POI_MISSING_SUBTYPES.map(x => `<button class="btn btn-secondary fb-reason-btn ${(d.dataSubtype || 'general') === x.value ? 'fb-selected' : ''}" data-subtype="${esc(x.value)}">${esc(x.label)}</button>`).join('')}
        </div>` : ''}
      ${d.dataIssue ? `
        <div class="fb-reason-group">Action</div>
        <div class="fb-reason-list">
          ${DATA_ACTIONS.map(x => `<button class="btn btn-secondary fb-reason-btn ${d.action === x.value ? 'fb-selected' : ''}" data-action="${esc(x.value)}">${esc(x.label)}</button>`).join('')}
        </div>` : ''}` : '';
    const searchEngineSection = d.problemType === 'search_engine' ? SEARCH_ENGINE_ISSUE_GROUPS.map(g => `
      <div class="fb-reason-group">${esc(g.category)}</div>
      <div class="fb-reason-list">
        ${g.items.map(label => `<label class="fb-checkbox-label"><input type="checkbox" class="fb-se-checkbox" value="${esc(label)}" /> ${esc(label)}</label>`).join('')}
      </div>`).join('') : '';
    const showNoteAndSubmit = (d.problemType === 'data' && d.dataIssue) || d.problemType === 'search_engine';
    body.innerHTML = `
      <button class="btn btn-secondary fb-back-btn" id="fb-back-btn">← Back</button>
      <div class="fb-reason-group">Problem type</div>
      <div class="fb-buttons fb-buttons-row">
        <button class="btn btn-secondary fb-btn fb-btn-text ${d.problemType === 'data' ? 'fb-selected' : ''}" id="fb-type-data-btn">Data</button>
        <button class="btn btn-secondary fb-btn fb-btn-text ${d.problemType === 'search_engine' ? 'fb-selected' : ''}" id="fb-type-se-btn">Search Engine</button>
      </div>
      ${dataSection}
      ${searchEngineSection}
      ${showNoteAndSubmit ? `
        <textarea id="fb-ticket-note" class="fb-note-textarea" placeholder="Note (optional)"></textarea>
        <button class="btn btn-primary" id="fb-ticket-add-btn" style="width:100%;margin-top:10px;">Add Ticket</button>` : ''}`;

    document.getElementById('fb-back-btn').addEventListener('click', () => { feedbackTicketDraft = null; feedbackPanelMode = 'start'; renderFeedbackPanel(); });
    document.getElementById('fb-type-data-btn').addEventListener('click', () => { d.problemType = 'data'; renderFeedbackPanel(); });
    document.getElementById('fb-type-se-btn').addEventListener('click', () => { d.problemType = 'search_engine'; renderFeedbackPanel(); });
    body.querySelectorAll('[data-dataissue]').forEach(btn => {
      btn.addEventListener('click', () => {
        d.dataIssue = btn.dataset.dataissue;
        if (d.dataIssue !== 'poi_missing') d.dataSubtype = null;
        d.action = DEFAULT_ACTION_FOR_DATA_ISSUE[d.dataIssue] || null; // 選びやすいよう初期値を入れるが、下のActionボタンで変更可能
        renderFeedbackPanel();
      });
    });
    body.querySelectorAll('[data-subtype]').forEach(btn => {
      btn.addEventListener('click', () => { d.dataSubtype = btn.dataset.subtype; renderFeedbackPanel(); });
    });
    body.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => { d.action = btn.dataset.action; renderFeedbackPanel(); });
    });
    const submitBtn = document.getElementById('fb-ticket-add-btn');
    if (submitBtn) submitBtn.addEventListener('click', submitTicketDraft);
    return;
  }

  body.innerHTML = `<p class="status-msg" style="padding:0;">Run a search first</p>`;
}

// ============================================================
// AI DIAGNOSIS (「AIによる評価」タブ。Mapboxがクエリに適切な結果を返せているかをAIに判定させ、
// 人がAccept/Declineして確定させるアシスト機能。自動ログ記録はしない)
// ============================================================
const AI_DIAG_MODEL_IDS = { haiku: 'claude-haiku-4-5-20251001', sonnet: 'claude-sonnet-5' };
const AI_DIAG_MODEL_LABELS = { haiku: 'Haiku 4.5', sonnet: 'Sonnet 5' };
// 概算コスト表示用(Anthropic公式の$/MTok単価。要:最新価格での裏取り) と概算USD→JPYレート
const AI_DIAG_PRICING_USD_PER_MTOK = {
  haiku:  { input: 1,  output: 5  },
  sonnet: { input: 3,  output: 15 },
};
const AI_DIAG_USD_TO_JPY = 155; // 概算レート。厳密な費用計算には使わないこと
// Prompt Caching(cache_control)使用時の単価倍率(概算)。書き込みは通常入力より割高、読み込みは大幅に安い
const AI_DIAG_CACHE_WRITE_MULTIPLIER = 1.25;
const AI_DIAG_CACHE_READ_MULTIPLIER  = 0.1;
function estimateAiDiagCostJpy(model, usage) {
  const p = AI_DIAG_PRICING_USD_PER_MTOK[model] || AI_DIAG_PRICING_USD_PER_MTOK.haiku;
  const usd = ((usage.inputTokens ?? 0) / 1e6) * p.input
    + ((usage.cacheCreationInputTokens ?? 0) / 1e6) * p.input * AI_DIAG_CACHE_WRITE_MULTIPLIER
    + ((usage.cacheReadInputTokens ?? 0) / 1e6) * p.input * AI_DIAG_CACHE_READ_MULTIPLIER
    + ((usage.outputTokens ?? 0) / 1e6) * p.output;
  return usd * AI_DIAG_USD_TO_JPY;
}
const LS_AI_DIAG_MODEL          = 'apc_ai_diag_model';
const LS_AI_DIAG_IGNORE_BBOX    = 'apc_ai_diag_ignore_bbox';
const LS_AI_DIAG_LOG          = 'apc_ai_diagnosis_log';

let aiDiagSettings = {
  model: localStorage.getItem(LS_AI_DIAG_MODEL) || 'haiku',
  ignoreBbox: localStorage.getItem(LS_AI_DIAG_IGNORE_BBOX) === 'true',
};
function saveAiDiagSettings() {
  localStorage.setItem(LS_AI_DIAG_MODEL, aiDiagSettings.model);
  localStorage.setItem(LS_AI_DIAG_IGNORE_BBOX, String(aiDiagSettings.ignoreBbox));
}

// CSVファイル読み込み時の列自動マッピング(analyzeCsvColumns)用のモデル設定。
// 診断/Ask AIとは別軸の設定だが、ヘッダーの「⚙️ AI Settings」に統一表示する
const LS_CSV_SCAN_MODEL = 'apc_csv_scan_model';
let csvScanModel = localStorage.getItem(LS_CSV_SCAN_MODEL) || 'haiku';
function saveCsvScanModel() {
  localStorage.setItem(LS_CSV_SCAN_MODEL, csvScanModel);
}

// Ask AI(単体POIチェック)用のモデル設定。低頻度・精度優先の性質上デフォルトはsonnetだが、
// コストを抑えたい場合のためにhaikuも選択できるようにする
const LS_ASK_AI_MODEL = 'apc_ask_ai_model';
let askAiModel = localStorage.getItem(LS_ASK_AI_MODEL) || 'sonnet';
function saveAskAiModel() {
  localStorage.setItem(LS_ASK_AI_MODEL, askAiModel);
}

function loadAiDiagLog() { try { return JSON.parse(localStorage.getItem(LS_AI_DIAG_LOG) || '[]'); } catch { return []; } }
function saveAiDiagLog(log) { localStorage.setItem(LS_AI_DIAG_LOG, JSON.stringify(log)); }
let aiDiagLog = loadAiDiagLog();

function recordAiDiagLog(entry) {
  aiDiagLog.push({ ...entry, timestamp: new Date().toISOString() });
  saveAiDiagLog(aiDiagLog);
}

let aiDiagState    = 'idle'; // 'idle' | 'analyzing' | 'proposal' | 'decline_input' | 'error'
let aiDiagProposal = null;   // { scope:'in_scope'|'out_of_scope', outOfScopeReason, tickets:[...], reasoning, usage }
let aiDiagError    = '';

// ============================================================
// AI診断: 4つの専用プロンプト(分類 / Mapbox単独判定 / Google単独判定 / カバレッジ判定)
// 1本の会話を複数ターンに分けるのではなく、それぞれ独立した単発呼び出しにする。
// 理由: 会話を繋げると前のターンのやり取り(空振り応答含む)を毎回丸ごと再送信する必要があり、
// ターンが進むほどinトークンが増えてしまう。独立呼び出しなら各回で必要な情報だけを渡せばよく、
// かつそのステップで使わないルール/タグ一覧を含めずに済む(例: Mapbox単独判定にBADタグ一覧は不要)。
// ============================================================

// address/region/place/locality/neighborhoodは「答えが1つに定まる地名・住所系」として同じグループ(粒度違い)。
// フロー分岐(specific flow行き)・types不整合チェックの対象判定は全てこの配列を参照する
const ADDRESS_LIKE_TYPES = ['address', 'region', 'place', 'locality', 'neighborhood'];
// 分類結果ごとに期待されるMapbox `types`値へのマッピング(types不整合チェックで使う。
// poi_brand/poi_category/others/unknownは単一のtypes値に対応しないため対象外)
const MAPBOX_TYPE_EXPECTATION = { poi: 'poi', address: 'address', region: 'region', place: 'place', locality: 'locality', neighborhood: 'neighborhood' };
const AI_DIAG_QUERY_TYPES = ['poi', ...ADDRESS_LIKE_TYPES, 'poi_brand', 'poi_category', 'others', 'unknown'];

// クエリの分類(唯一の正解があるPOI/住所・地名か、カバレッジが問題になるカテゴリ/ブランドか)
const AI_DIAG_CLASSIFY_PROMPT = `あなたはタクシー配車業務等で使われる地図検索クエリの分類器です。
渡されたクエリ文字列を、次の10種類のうち最も適切な1つに分類してください。

「答えが1つに定まる」タイプ(固有名詞・住所・地名。粒度が違うだけで同じグループ):
- poi: 固有の1つの場所を指すPOI名(例: 東京タワー、〇〇内科クリニック)
- address: 番地まで含む純粋な住所文字列(例: 東京都渋谷区渋谷2-1-1)。市区町村・町名等の地名だけのクエリはここに含めないこと
- region: 都道府県(例: 神奈川県)
- place: 市区町村(例: 鎌倉市)
- locality: 町名(例: 台東区入谷)
- neighborhood: 丁目まで(例: 鎌倉市常盤四丁目)

「答えが1つに定まらない」タイプ:
- poi_brand: 特定のチェーン/ブランド名の指定(例: セブンイレブン、スターバックス)。同一ブランドの店舗が複数存在し、正解が1つに定まらない(近くの店舗が複数該当し得る)
- poi_category: 業種・カテゴリでの指定(例: カフェ、コンビニ、病院)。同様に複数の店舗/施設が該当し得る

その他:
- others: 上記のいずれにも当てはまらないが、クエリの意図自体は読み取れる場合
- unknown: クエリが壊れている(文字が欠落・意味不明な断片等)、または曖昧すぎて何を探しているのか判断できない場合

出力は必ず以下のJSON形式のみ。前置きの説明や確認の文章は一切書かず、コードブロックのマークダウンも付けず、必ず"{"から書き始めること。
{"type": "poi" | "address" | "region" | "place" | "locality" | "neighborhood" | "poi_brand" | "poi_category" | "others" | "unknown", "reasoning": "日本語で1文の短い理由"}`;

// specific(poi/address/region/place/locality/neighborhood/others)フロー: ステップ1、
// Mapbox候補だけを見て判定する(Google側はまだ見せない)
const AI_DIAG_MAPBOX_PROMPT = `あなたはタクシー配車業務等で使われる地図検索(Mapbox Search Box API)の品質診断アシスタントです。
これから渡されるクエリは「固有の1つの答えがある」タイプ(POI名・住所・地名等)です。Mapboxの検索結果(候補群mb)の中に、クエリが意図した対象と一致する候補があるかどうかだけを判定してください(Google側の結果はこの時点ではまだ見えません)。

入力は次の省略形式のJSON:
{"q": "クエリ文字列", "prox": "緯度,経度"|null, "bbox": "minLng,minLat,maxLng,maxLat"|null, "bboxIgnored": boolean, "mb": ["name|posMatch|distance", ...]}
mbの各要素の"name|posMatch|distance"は:
- name: 候補の名称
- posMatch: address(座標が近いGoogle候補[非表示]がある) | none(無い) ※あくまで座標だけの機械的な近さ判定。名前が一致するかどうかの判断には使わず、必ずクエリの意味とcandidateのnameから自分で判断すること
- distance: proxからの距離。mまたはkm表記(例:320m, 4.2km)。空文字なら不明
mbの配列の並び順=Mapbox検索結果の順位(先頭が1位)。

判定ルール:
- 最終判断はクエリの意味とcandidateのnameから行うこと。posMatch/distanceは座標の近さのヒントに留める
- 注意(同名候補が複数ある場合): mb内に名前が(ほぼ)同一の候補が複数ある場合、配列の順位だけで判断しないこと。順位が上位にあるという理由だけで正解と決めつけてはいけない。そのうちdistanceが最も近い候補を実際の正解候補として優先し、rankの値もその候補の配列上の順位を使うこと(同名異place、例えば同名の駅・店舗が全国に複数存在するケースで、遠方の候補が偶然上位に来ることがあるため)
- 注意(距離が極端に近い場合の救済): 候補の名前がクエリと完全には一致しなくても、地名の一部・業種・同音異字表記等の部分的な符合が最低限あり、かつdistanceが極端に小さい場合は、クエリが意図した対象である可能性が高いと判断してよい(例: 「広 双葉病院」に対し、「地方独立行政法人広島県立病院機構県立二葉の里病院」という長い正式名称の候補が極端に近い場合。「二葉」と「双葉」は同音のため正当な一致とみなせる)。ただし名称に全く関連性が見出せない場合は、近いというだけで一致とみなさないこと。
  「極端に近い」の許容距離は候補の種類によって相対的に判断すること: コンビニ・チェーン店・個人商店のような小さく高密度に存在する施設は狭め(目安50〜100m)、病院・駅・大学・商業施設・工場のような大規模な敷地を持つ施設は広め(目安300〜500m、敷地の広さやジオコーディングの精度上この程度の誤差は正当にあり得る)に取る。候補名から施設の種類を推測し、上記を目安にスケールさせること。

出力は必ず以下のJSON形式のみ。前置きの説明や確認の文章は一切書かず、必ず"{"から書き始めること。
{"matched": true | false, "rank": number | null (matched=trueの時、その候補の配列上の順位。1始まり), "reasoning": "日本語で1文の短い理由"}`;

// AI診断は「data(Mapboxのデータそのものの不備)」だけを対象にする(search_engine系の判定はAIには任せない)。
// FEEDBACK_REASONSのうちCoverage/Bugがdataに相当する項目群
const AI_DIAG_DATA_BAD_TAGS = FEEDBACK_REASONS.filter(g => g.category === 'Coverage' || g.category === 'Bug').flatMap(g => g.items);

// specific(poi/address/others)フロー: ステップ2、Mapboxで一致が見つからなかった場合にGoogle候補だけを見て判定する
const AI_DIAG_GOOGLE_PROMPT = `あなたはタクシー配車業務等で使われる地図検索(Mapbox Search Box API)の品質診断アシスタントです。
これから渡されるクエリは「固有の1つの答えがある」タイプ(POI名・住所・地名等)ですが、Mapbox側の候補では一致する候補が見つかりませんでした。Google Places側の検索結果(候補群gg)の中に、クエリが意図した対象と一致する候補があるかどうかを判定してください。

入力は次の省略形式のJSON:
{"q": "クエリ文字列", "gg": ["name|posMatch|distance", ...]}
ggの各要素の"name|posMatch|distance"は:
- name: 候補の名称
- posMatch: address(座標が近いMapbox候補[今回は一致しなかった候補群]がある) | none(無い) ※あくまで座標だけの機械的な近さ判定。名前が一致するかどうかの判断には使わないこと
- distance: proxからの距離。mまたはkm表記。空文字なら不明
ggの配列の並び順=Google検索結果の順位(先頭が1位)。

判定ルール:
- Mapbox側の判定と同じ厳しさで判定すること。こじつけ的な一致(読みが違う、部分一致のみ等)は有効な一致とみなさないこと
- 注意(同名候補が複数ある場合): ggに名前が(ほぼ)同一の候補が複数ある場合、配列の順位だけで判断せず、distanceが最も近い候補を優先すること
- 注意(距離が極端に近い場合の救済): 候補の名前がクエリと完全には一致しなくても、地名の一部・業種・同音異字表記等の部分的な符合が最低限あり、かつdistanceが極端に小さい場合は、クエリが意図した対象である可能性が高いと判断してよい。「極端に近い」の許容距離は施設の種類で相対的に判断すること(コンビニ等の小規模施設は目安50〜100m、病院・駅等の大規模施設は目安300〜500m)

一致が見つかった場合、matched=trueとし、badTagに以下のタグ一覧(Mapboxのデータそのものの不備のみ)から最も近いものを1つだけ選んでください:
${AI_DIAG_DATA_BAD_TAGS.join(', ')}

出力は必ず以下のJSON形式のみ。前置きの説明や確認の文章は一切書かず、必ず"{"から書き始めること。
{"matched": true | false, "badTag": string | null, "reasoning": "日本語で1文の短い理由"}`;

// specificフロー: 存在チェック(A-1/A-2)がGoodだった場合だけ実行する付随問題チェック(住所系クエリ専用、0〜1件)。
// POI側の同種チェックはAI_DIAG_POI_QUALITY_PROMPT(名前クラスタ+座標ヒント+Google突合)に統合したため、
// ここは「住所は非対称(重複という概念が無い)」の専用ルートとしてのみ残す
// 「正しい候補は見つかっているが1位ではない」だけでは問題として扱わない(Almost!相当の復活を避けるため明示的に除外)
const AI_DIAG_ATTRIBUTE_PROMPT = `あなたはタクシー配車業務等で使われる地図検索(Mapbox Search Box API)の品質診断アシスタントです。
クエリが意図した対象として既に確定済みのMapbox候補(1件、住所系)について、name/住所/tag等が明らかに間違っている、または古い(閉店・移転済み等)かどうかだけを判定してください。

入力は次の省略形式のJSON:
{"q": "クエリ文字列", "matched": "name|posMatch|distance"}
matchedは既に確定済みの正解候補。

注意:
- 「正しい候補は見つかっているが1位ではない」という理由**だけ**では問題として扱わないこと(順位の良し悪しはこのチェックの対象外)
- 明確な根拠が無ければ無理に問題を作らないこと

出力は必ず以下のJSON形式のみ。前置きの説明や確認の文章は一切書かず、必ず"{"から書き始めること。
{"attributeWrong": true | false, "reasoning": "日本語で1文の短い理由"}`;

// POI品質統合チェック(重複検査+POI側属性チェックを1本化)。クエリの正解が見つかった/見つからなかったに
// 関係なく、Specific/Coverageどちらのフローでもtype=poiの候補が2件以上あれば常に実行する。
// 「近い」は決定的な理由にせず、まず名前の意味的な近さを優先根拠にする(近いが別ブランドの店/
// 名前は同じだが移転で離れている、等の誤検知を避けるため)。Googleは判断が難しい場合のground truthとして使う
const AI_DIAG_POI_NEARBY_THRESHOLD_KM = 0.2; // 200m。重複の確定根拠ではなく、あくまでAIへのヒント
const AI_DIAG_POI_QUALITY_PROMPT = `あなたはタクシー配車業務等で使われる地図検索(Mapbox Search Box API)の品質診断アシスタントです。
渡されるMapbox候補リスト(POIのみに絞り込み済み)について、以下の2種類の問題が無いか判定してください。クエリの正解かどうかは問わず、リスト内のどの候補も対象です。

判定する2種類の問題:
1. duplicate(重複): 名前が同じ/意味的に近い(ブランド名のみ表記・店舗名+地名表記・ローマ字表記等の表記ゆれを含む)候補が複数あり、かつ座標も近い(nearbyヒントに含まれる)場合、それらは同じPOIの重複である可能性が高い
2. wrong_poi(データ間違い): 以下のいずれかに該当する候補
   - 名前は同じ/近いが座標が離れている(nearbyヒントに含まれない)候補ペア。移転等で片方が古い/間違っている可能性が高く、これは重複ではなくwrong_poiとして扱う
   - 名前クラスタとは無関係に、単独で明らかにname/住所/tagが間違っている、または古い(閉店・移転済み等)候補

判断の優先順位(重要):
- 座標が近いという情報(nearbyヒント)だけで重複と決めつけないこと。まず名前の意味的な近さを最優先の判断根拠にすること
- Google候補(gg)をground truthとして使い、Mapbox内だけでは判断が難しい場合の裏付けにすること(例: Googleに実在候補が1件しか見当たらなければ、対応する複数のMapbox候補は重複の可能性が高い。Googleに離れた場所の候補が両方実在すれば、移転ではなく別々の正当な店舗の可能性が高い)
- 1つの候補がduplicateGroupsとwrongPoiIndexesの両方に登場することは無い前提で判定すること

入力は次の省略形式のJSON:
{"q": "クエリ文字列", "mb": [{"i": number, "name": "候補名", "nearby": [number, ...]}, ...], "gg": ["name|posMatch|distance", ...]}
mb.nearbyは、その候補から見て座標が近い(目安200m以内)他のmb候補のインデックス一覧(機械的な計算によるヒントであり、重複の確定根拠ではない)。
ggはGoogle検索結果(全件、正解の可能性がある参考情報)。

出力は必ず以下のJSON形式のみ。前置きの説明や確認の文章は一切書かず、必ず"{"から書き始めること。
{"duplicateGroups": [{"indexes": [number, ...], "reasoning": "日本語で1文の短い理由"}, ...], "wrongPoiIndexes": [{"index": number, "reasoning": "日本語で1文の短い理由"}, ...]}
(該当が無ければそれぞれ空配列にすること)`;

// poi_brand/poi_categoryフロー: Googleをground truthとみなし、Google候補それぞれにMapbox側の対応候補があるか(カバレッジ)を判定する
const AI_DIAG_COVERAGE_PROMPT = `あなたはタクシー配車業務等で使われる地図検索(Mapbox Search Box API)の品質診断アシスタントです。
これから渡されるクエリは「カテゴリ/ブランド」タイプ(例: カフェ、セブンイレブン)で、正解が1つに定まらず、適切な候補がどれだけ見つかるか(カバレッジ)が問題になります。
Google Placesの検索結果をground truth(正解の基準)とみなし、Google候補(gg)それぞれについて、Mapbox候補(mb)の中に対応するものがあるかを判定してください。

入力は次の省略形式のJSON:
{"q": "クエリ文字列", "mb": ["name|posMatch|distance", ...], "gg": ["name|posMatch|distance", ...]}
各要素の"name|posMatch|distance"のposMatchは、mb/gg間の座標が近いかどうかだけを機械的に判定した結果(address=近い候補あり|none=なし)。名前が一致するかどうかの判断にはこの値を使わず、必ずAI自身の意味理解(表記ゆれ・同音異字等を含む)で行うこと。

gg配列のうち、Mapbox側(mb)に対応する候補が無いと判断したものの配列インデックス(0始まり)を全てuncoveredIndexesに列挙してください。1つも無ければ空配列にしてください。

出力は必ず以下のJSON形式のみ。前置きの説明や確認の文章は一切書かず、必ず"{"から書き始めること。
{"uncoveredIndexes": [number, ...], "reasoning": "日本語で1〜2文の短い説明"}`;

// runAiDiagnosis実行中に裏で発生する追加API呼び出し数(bbox無視の再検索・types不整合の再検索・
// poi_brand/poi_category個別検証など)を数えるカウンタ。実行開始時にresetAiDiagApiCallCounts()でリセットする。
// GoogleはAI診断中に再フェッチすることが無いため常に0(カード表示の透明性のため明示的に持たせておく)
let aiDiagApiCallCounts = { mapbox: 0, google: 0 };
function resetAiDiagApiCallCounts() { aiDiagApiCallCounts = { mapbox: 0, google: 0 }; }

// 診断専用の再検索の共通ヘルパー。dropBbox(bbox無視トグル)とtypesOverride(types不整合チェック時、
// その1値だけに絞って再検索)のどちらか/両方を指定できる。画面表示中のmapboxRawResultsは変更しない。
async function searchMapboxDiag(query, { dropBbox = false, typesOverride = null } = {}) {
  const params = new URLSearchParams({ q: query });
  for (const [k, v] of Object.entries(state.mapboxParams)) {
    if (dropBbox && k === 'bbox') continue;
    if (typesOverride && k === 'types') continue;
    const s = serializeMapboxParam(v);
    if (s !== null) params.set(k, s);
  }
  if (typesOverride) params.set('types', typesOverride);
  params.set('access_token', MAPBOX_TOKEN);
  aiDiagApiCallCounts.mapbox++;
  const res = await fetch(`https://api.mapbox.com/search/searchbox/v1/forward?${params}`);
  if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
  const data = await res.json();
  return (data.features ?? []).map(f => ({
    ...f.properties,
    coordinates: { longitude: f.geometry?.coordinates?.[0] ?? 0, latitude: f.geometry?.coordinates?.[1] ?? 0 },
  }));
}
// bbox無視トグルON時、診断専用にMapboxをbbox無しで再検索する。
// poi_brand/poi_categoryフローの追加検証(該当POI名での個別検索)にも同じ関数を使う
function searchMapboxIgnoringBbox(query) { return searchMapboxDiag(query, { dropBbox: true }); }
// types不整合チェック時、期待されるtypes値1つだけに絞って再検索する
function searchMapboxWithTypesOverride(query, expectedType) { return searchMapboxDiag(query, { typesOverride: expectedType }); }

// proximity/locationからの距離を診断プロンプト向けの短い文字列に変換する(空/不明なら空文字)
function formatDiagDistance(center, lat, lng) {
  return formatDistanceCompact(nearProximityInfo(center?.lat, center?.lng, lat, lng).km) ?? '';
}

// AI診断に必要な素材(Mapbox/Google生データ・突き合わせ結果・行フォーマット済み文字列)をまとめて用意する。
// 各行とも「proximity・座標近似ステータス・name・距離」だけに絞る(住所・生座標は渡さない)。
// トークン節約のため、候補はJSON object配列ではなく"name|posMatch|distance"のパイプ区切り文字列配列にする
async function buildAiDiagContext(query) {
  let mList = Array.isArray(mapboxRawResults) ? mapboxRawResults : [];
  let bboxIgnoredForDiagnosis = false;
  if (aiDiagSettings.ignoreBbox && Array.isArray(state.mapboxParams.bbox) && state.mapboxParams.bbox.length === 4) {
    mList = await searchMapboxIgnoringBbox(query);
    bboxIgnoredForDiagnosis = true;
  }
  const gList = Array.isArray(googleRawResults) ? googleRawResults : [];

  const gName = r => r.name, gCoord = r => ({ lat: r.geometry?.location?.lat, lng: r.geometry?.location?.lng }), gAddr = r => r.formatted_address;
  const mName = r => r.name, mCoord = r => ({ lat: r.coordinates?.latitude, lng: r.coordinates?.longitude }), mAddr = r => r.full_address;
  const treatNameAsAddress = isCurrentQueryAddressType();

  // posMatchはMapbox↔Google間の座標近似だけを見た結果であり、両リストが無いと計算できないため、ここで両方まとめて計算する。
  // name一致はAI自身の意味理解に委ねる方針のため、ここでは計算しない(computeAddressMatchOnly参照)
  const mPosMatch = computeAddressMatchOnly(mList, mCoord, mAddr, gList, gCoord, gAddr);
  const gPosMatch = computeAddressMatchOnly(gList, gCoord, gAddr, mList, mCoord, mAddr);

  // MapboxのproximityとGoogleのlocationは常に同一の値を使っている前提のため、1つに統合する
  const center = state.mapboxParams.proximity ?? state.googleParams.location ?? null;
  const proxStr = (center?.lat != null && center?.lng != null) ? `${center.lat},${center.lng}` : null;
  const distanceOf = (lat, lng) => formatDiagDistance(center, lat, lng);

  const toRow = (name, posMatch, distance) => [name ?? '', posMatch, distance].join('|');
  const mapboxRows = mList.map((r, i) => toRow(r.name, mPosMatch[i], distanceOf(r.coordinates?.latitude, r.coordinates?.longitude)));
  const googleRows = gList.map((r, i) => toRow(r.name, gPosMatch[i], distanceOf(r.geometry?.location?.lat, r.geometry?.location?.lng)));

  const bboxStr = (!bboxIgnoredForDiagnosis && Array.isArray(state.mapboxParams.bbox) && state.mapboxParams.bbox.length === 4)
    ? state.mapboxParams.bbox.join(',') : null;

  return {
    query, mList, gList, mPosMatch, gPosMatch, mapboxRows, googleRows,
    proxStr, bboxStr, bboxIgnored: bboxIgnoredForDiagnosis,
    mName, mCoord, mAddr, gName, gCoord, gAddr, treatNameAsAddress, center,
  };
}

// AIの応答テキストからJSONを抜き出してparseする。見つからなければエラー(呼び出し元でaiDiagStateをerrorにする)。
// dataは診断用(任意): 生のAPIレスポンス全体を渡しておくと、失敗時にstop_reason/contentのブロック種別・
// 生テキストをコンソールに出力できる(thinkingブロックだけで打ち切られた等の切り分けに使う)
function parseAiJson(raw, label, data) {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error(`[AI診断] JSONが見つかりませんでした (${label})`, {
      stopReason: data?.stop_reason,
      contentBlockTypes: data?.content?.map(b => b?.type),
      rawTextLength: raw.length,
      rawText: raw,
    });
    throw new Error(`AI response was not valid JSON (${label})`);
  }
  return JSON.parse(match[0]);
}

// poi_brand/poi_categoryフローで「Mapbox側に対応候補が無い」と判定されたGoogle候補について、
// そのPOI名で個別にMapbox Search Box forwardを実行し、本当に無いのか、ランキング外に埋もれているだけなのかを検証する。
// (見つかった場合の座標近似判定は、既存のcoordinatesMatchより少し広め(200m)にしている。
//  名前一致という強い手がかりで検索した上での座標確認なので、多少の座標ズレは許容してよいと判断)
const AI_DIAG_COVERAGE_VERIFY_THRESHOLD_KM = 0.2;
async function verifyMapboxHasPoi(googleItem) {
  const name = googleItem?.name;
  const gLat = googleItem?.geometry?.location?.lat, gLng = googleItem?.geometry?.location?.lng;
  if (!name || gLat == null || gLng == null) return false;
  let results;
  try { results = await searchMapboxIgnoringBbox(name); } catch { return false; }
  return results.some(r => {
    const km = haversineDistanceKm(gLat, gLng, r.coordinates?.latitude, r.coordinates?.longitude);
    return isFinite(km) && km <= AI_DIAG_COVERAGE_VERIFY_THRESHOLD_KM;
  });
}

// types不整合チェック: 分類結果の粒度が期待するMapbox `types`値と食い違っている場合(typesが指定されていて、
// かつその値を含んでいない場合のみ)、期待値1つだけに絞って再検索し、もう一度Mapbox単独判定をやり直す。
// ヒットすればConditional good(パラメータを直せば通る)として返す。mParsed/mDataは元の1st pass判定結果
// (再検証が空振りだった場合、そちらのreasoningをフォールバックとして使う)
async function tryTypesMismatchRescue(ctx, modelId, addUsage, qType) {
  const expectedType = MAPBOX_TYPE_EXPECTATION[qType];
  const currentTypes = Array.isArray(state.mapboxParams.types) ? state.mapboxParams.types : [];
  if (!expectedType || currentTypes.length === 0 || currentTypes.includes(expectedType)) return null;

  const fixedMList = await searchMapboxWithTypesOverride(ctx.query, expectedType);
  const fixedPosMatch = computeAddressMatchOnly(fixedMList, ctx.mCoord, ctx.mAddr, ctx.gList, ctx.gCoord, ctx.gAddr);
  const fixedRows = fixedMList.map((r, i) => [r.name ?? '', fixedPosMatch[i], formatDiagDistance(ctx.center, r.coordinates?.latitude, r.coordinates?.longitude)].join('|'));
  const fixedPayload = { q: ctx.query, prox: ctx.proxStr, bbox: ctx.bboxStr, bboxIgnored: ctx.bboxIgnored, mb: fixedRows };
  const fixedData = await callClaudeRaw(AI_DIAG_MAPBOX_PROMPT, [{ role: 'user', content: JSON.stringify(fixedPayload) }], 600, modelId);
  addUsage(fixedData);
  const fixedParsed = parseAiJson(extractClaudeText(fixedData), 'mapbox-types-fix', fixedData);
  if (!fixedParsed.matched) return null;
  return {
    category: 'good', reason: CONDITIONAL_GOOD_REASON,
    conditionalReasons: ['Types filter excluded correct type'],
    rank: fixedParsed.rank ?? null,
    reasoning: `Re-searched with types=${expectedType} only: ${fixedParsed.reasoning || ''}`,
  };
}

// specific(poi/address/region/place/locality/neighborhood/others)フロー本体。
// 存在チェック(A-1/A-2/A-4)は早期リターンではなく「見つかった候補のindex」を確定させるところまでとし、
// 見つかった場合はAttribute Check(A-5)を追加実行して0〜1件のticketにまとめる。
// (重複検査は正解の有無に関わらず常時実行の別ステップに切り出したため、ここでは呼ばない。runAiDiagnosis参照)
// A-3(types救済)はConditional Goodという特別扱いが無くなったため呼び出しから外した(tryTypesMismatchRescue関数自体は残置)
async function runAiDiagSpecificFlow(ctx, modelId, addUsage, qType) {
  const { mList, gList, mName, treatNameAsAddress } = ctx;
  let matchedIndex = -1;
  let existenceReasoning = '';

  // A-1: JS側だけで判定できる無料のレスキュー: Googleの1位候補と名前が一致するMapbox候補があれば、
  // AIを呼ばずに即マッチ確定する(この一致自体はcomputeMatchCategoriesと同じ機械的な正規化比較のため、AI判断は不要)
  if (gList.length) {
    const topGoogleName = ctx.gName(gList[0]);
    for (let i = 0; i < mList.length; i++) {
      if (namesMatch(mName(mList[i]), topGoogleName, treatNameAsAddress)) {
        matchedIndex = i;
        existenceReasoning = `Google's top result is corroborated by a name-matching Mapbox candidate at rank ${i + 1} (mechanical cross-check, no AI call needed for this).`;
        break;
      }
    }
  }

  // A-2: Mapbox候補だけで判定(A-1で決着しなかった場合のみ)
  if (matchedIndex === -1) {
    const mapboxPayload = { q: ctx.query, prox: ctx.proxStr, bbox: ctx.bboxStr, bboxIgnored: ctx.bboxIgnored, mb: ctx.mapboxRows };
    const mData = await callClaudeRaw(AI_DIAG_MAPBOX_PROMPT, [{ role: 'user', content: JSON.stringify(mapboxPayload) }], 600, modelId);
    addUsage(mData);
    const mParsed = parseAiJson(extractClaudeText(mData), 'mapbox', mData);
    if (mParsed.matched && mParsed.rank) {
      matchedIndex = mParsed.rank - 1;
      existenceReasoning = mParsed.reasoning || '';
    }
  }

  if (matchedIndex !== -1) {
    // A-5: 属性チェック(住所系クエリのみ。POI側は別途runAiDiagPoiQualityCheckが担当する)
    const tickets = ctx.treatNameAsAddress ? await runAiDiagAttributeCheck(ctx, modelId, addUsage, matchedIndex) : [];
    return { scope: 'in_scope', outOfScopeReason: null, tickets, reasoning: existenceReasoning };
  }

  // A-4: Mapboxで見つからなかった場合、Google候補だけで判定
  const googlePayload = { q: ctx.query, gg: ctx.googleRows };
  const gData = await callClaudeRaw(AI_DIAG_GOOGLE_PROMPT, [{ role: 'user', content: JSON.stringify(googlePayload) }], 600, modelId);
  addUsage(gData);
  const gParsed = parseAiJson(extractClaudeText(gData), 'google', gData);
  const ticket = convertAiReasonToTicket(gParsed.matched ? (gParsed.badTag || null) : null);
  ticket.reasoning = gParsed.reasoning || '';
  return { scope: 'in_scope', outOfScopeReason: null, tickets: [ticket], reasoning: gParsed.reasoning || '' };
}

// A-5: 存在チェックで確定した住所系候補について、属性間違いだけを追加チェックする(0〜1件のticketを返す)。
// POI側は呼び出し元(runAiDiagSpecificFlow)がtreatNameAsAddressの時だけこの関数を呼ぶので、常にaddress_wrongでよい
async function runAiDiagAttributeCheck(ctx, modelId, addUsage, matchedIndex) {
  const matchedRow = ctx.mapboxRows[matchedIndex];
  if (!matchedRow) return [];
  const payload = { q: ctx.query, matched: matchedRow };
  const data = await callClaudeRaw(AI_DIAG_ATTRIBUTE_PROMPT, [{ role: 'user', content: JSON.stringify(payload) }], 600, modelId);
  addUsage(data);
  const parsed = parseAiJson(extractClaudeText(data), 'attribute', data);
  if (!parsed.attributeWrong) return [];
  return [{
    problemType: 'data', dataIssue: 'address_wrong', dataSubtype: null,
    action: DEFAULT_ACTION_FOR_DATA_ISSUE.address_wrong,
    note: 'AI diagnosis (attribute check)', reasoning: parsed.reasoning || '',
  }];
}

// type=poiの候補同士で、座標が近い(閾値以内)他候補のインデックス一覧を機械的に計算する。
// あくまでAIへの参考ヒントであり、重複の確定根拠にはしない(名前の意味的な近さが優先根拠)
function computeNearbyPoiIndexes(mList) {
  const poiIndexes = mList.map((r, i) => (r.feature_type === 'poi' ? i : null)).filter(i => i !== null);
  const nearby = {};
  for (const i of poiIndexes) nearby[i] = [];
  for (let a = 0; a < poiIndexes.length; a++) {
    for (let b = a + 1; b < poiIndexes.length; b++) {
      const i = poiIndexes[a], j = poiIndexes[b];
      const ri = mList[i], rj = mList[j];
      const km = haversineDistanceKm(ri.coordinates?.latitude, ri.coordinates?.longitude, rj.coordinates?.latitude, rj.coordinates?.longitude);
      if (isFinite(km) && km <= AI_DIAG_POI_NEARBY_THRESHOLD_KM) {
        nearby[i].push(j);
        nearby[j].push(i);
      }
    }
  }
  return { poiIndexes, nearby };
}

// POI品質統合チェック(重複+POI側属性間違いを1本化)。クエリの正解が見つかった/見つからなかったに関わらず、
// type=poiの候補が2件以上あれば常に実行する(runAiDiagnosisから呼ぶ、Specific/Coverage共通)。
// 1件以下(比較対象が無い)場合は判定不能なのでAI呼び出し自体を省略する
async function runAiDiagPoiQualityCheck(ctx, modelId, addUsage) {
  const { poiIndexes, nearby } = computeNearbyPoiIndexes(ctx.mList);
  if (poiIndexes.length < 2) return [];

  const mbPayload = poiIndexes.map(i => ({ i, name: ctx.mList[i]?.name ?? '', nearby: nearby[i] }));
  const payload = { q: ctx.query, mb: mbPayload, gg: ctx.googleRows };
  // グループ/個別指摘それぞれに理由文を持たせるため、候補数が多いクエリだと他のチェック(300トークン)より
  // 出力が伸びやすい。打ち切られて不正なJSONになるのを防ぐため余裕を持たせる
  const data = await callClaudeRaw(AI_DIAG_POI_QUALITY_PROMPT, [{ role: 'user', content: JSON.stringify(payload) }], 900, modelId);
  addUsage(data);
  const parsed = parseAiJson(extractClaudeText(data), 'poi-quality', data);

  const poiIndexSet = new Set(poiIndexes);
  const duplicateGroups = Array.isArray(parsed.duplicateGroups) ? parsed.duplicateGroups : [];
  const wrongPoiIndexes = Array.isArray(parsed.wrongPoiIndexes) ? parsed.wrongPoiIndexes : [];

  const duplicateTickets = duplicateGroups
    // プロンプトでtype=poi限定を指示しているが、念のためコード側でも非poi候補混入時は除外する(二重の保険)
    .map(group => (group && Array.isArray(group.indexes))
      ? { ...group, indexes: group.indexes.filter(i => poiIndexSet.has(i)) }
      : group)
    .filter(g => g && Array.isArray(g.indexes) && g.indexes.length > 1)
    .map(group => {
      const names = group.indexes.map(i => ctx.mList[i]?.name).filter(Boolean);
      return {
        problemType: 'data', dataIssue: 'poi_duplicate', dataSubtype: null,
        action: DEFAULT_ACTION_FOR_DATA_ISSUE.poi_duplicate,
        note: `AI diagnosis (poi quality check): ${names.join(' / ')}`,
        reasoning: group.reasoning || '',
      };
    });

  const wrongPoiTickets = wrongPoiIndexes
    .filter(w => w && poiIndexSet.has(w.index))
    .map(w => ({
      problemType: 'data', dataIssue: 'poi_attribute_wrong', dataSubtype: null,
      action: DEFAULT_ACTION_FOR_DATA_ISSUE.poi_attribute_wrong,
      note: `AI diagnosis (poi quality check): ${ctx.mList[w.index]?.name ?? ''}`,
      reasoning: w.reasoning || '',
    }));

  return [...duplicateTickets, ...wrongPoiTickets];
}

// poi_brand/poi_categoryフロー本体(カバレッジ判定)。未カバーの候補1件につき1チケットにする(集約しない)
async function runAiDiagCoverageFlow(ctx, modelId, addUsage, qType) {
  const payload = { q: ctx.query, mb: ctx.mapboxRows, gg: ctx.googleRows };
  const data = await callClaudeRaw(AI_DIAG_COVERAGE_PROMPT, [{ role: 'user', content: JSON.stringify(payload) }], 700, modelId);
  addUsage(data);
  const parsed = parseAiJson(extractClaudeText(data), 'coverage', data);
  const uncoveredIndexes = Array.isArray(parsed.uncoveredIndexes) ? parsed.uncoveredIndexes : [];

  // 未カバー判定された候補は、AI呼び出し無しでMapbox Search Box forwardによる個別検証を行う
  // (ランキング外に埋もれているだけの可能性を排除するため。件数上限は設けない)
  const stillMissing = [];
  await Promise.all(uncoveredIndexes.map(async (idx) => {
    const gItem = ctx.gList[idx];
    if (!gItem) return;
    const found = await verifyMapboxHasPoi(gItem);
    if (!found) stillMissing.push(gItem.name);
  }));

  const dataSubtype = qType === 'poi_brand' ? 'brand' : 'general';
  const tickets = stillMissing.map(name => ({
    problemType: 'data', dataIssue: 'poi_missing', dataSubtype, action: DEFAULT_ACTION_FOR_DATA_ISSUE.poi_missing,
    note: `AI diagnosis (coverage): missing "${name}"`,
    reasoning: `Verified via a dedicated Mapbox search: "${name}" not found.`,
  }));
  return {
    scope: 'in_scope', outOfScopeReason: null, tickets,
    reasoning: tickets.length
      ? (parsed.reasoning || '')
      : (parsed.reasoning || 'All Google-listed candidates for this category/brand are also present in Mapbox (directly or confirmed via a dedicated search).'),
  };
}

// mapboxApiLabel: このusageで数えているMapbox API呼び出しの種類を表す表示ラベル(呼び出し元によって異なるため引数で渡す)
function formatAiDiagUsage(usage, mapboxApiLabel = 'Search Box forward') {
  if (!usage) return '';
  const modelLabel = AI_DIAG_MODEL_LABELS[usage.model] || usage.model;
  const parts = [];
  if (usage.inputTokens != null) parts.push(`in ${usage.inputTokens}`);
  // 0でも「キャッシュが効いているか」を目視確認したいので、値が無い(null)場合だけ非表示にする
  if (usage.cacheReadInputTokens != null)     parts.push(`cache read ${usage.cacheReadInputTokens}`);
  if (usage.cacheCreationInputTokens != null) parts.push(`cache write ${usage.cacheCreationInputTokens}`);
  if (usage.outputTokens != null) parts.push(`out ${usage.outputTokens}`);
  const tokens = parts.length ? `${parts.join(' / ')} tok` : 'token count unknown';
  const cost = usage.costJpy != null ? ` / ≈¥${usage.costJpy < 0.01 ? '<0.01' : usage.costJpy.toFixed(2)}` : '';
  const apiCalls = ` / Mapbox API calls: ${usage.mapboxApiCalls ?? 0} (${mapboxApiLabel}) / Google API calls: ${usage.googleApiCalls ?? 0}`;
  return `${modelLabel} / ${tokens}${cost}${apiCalls}`;
}

function renderAiDiagPanel() {
  const body = document.getElementById('feedback-body');
  if (!feedbackContext) {
    body.innerHTML = `<p class="status-msg" style="padding:0;">Run a search first</p>`;
    return;
  }
  if (aiDiagState === 'analyzing') {
    body.innerHTML = `<div class="ai-diag-analyzing">Analyzing...</div>`;
    return;
  }
  if (aiDiagState === 'error') {
    body.innerHTML = `
      <button class="btn btn-secondary fb-back-btn" id="ai-diag-back-btn">← Back</button>
      <div class="ai-diag-toolbar">
        <button class="btn btn-primary" id="ai-diag-run-btn">▶ Retry</button>
      </div>
      <p class="status-msg status-error" style="padding:0;">${esc(aiDiagError)}</p>`;
    document.getElementById('ai-diag-back-btn').addEventListener('click', () => { aiDiagState = 'idle'; renderFeedbackPanel(); });
    document.getElementById('ai-diag-run-btn').addEventListener('click', runAiDiagnosis);
    return;
  }
  if (aiDiagState === 'proposal' && aiDiagProposal) {
    const p = aiDiagProposal;
    let catLabel, catCls;
    if (p.scope === 'out_of_scope') { catLabel = 'Out of scope'; catCls = 'cat-unclear'; }
    else if (p.tickets.length === 0) { catLabel = 'No Issue'; catCls = 'cat-good'; }
    else { catLabel = `${p.tickets.length} Issue${p.tickets.length > 1 ? 's' : ''} Found`; catCls = 'cat-bad'; }

    const ticketsHtml = p.tickets.map(t => `
      <div class="ai-diag-card-ticket">
        <div class="ai-diag-card-ticket-label">${esc(ticketSummaryLabel(t))}</div>
        ${t.reasoning ? `<div class="ai-diag-card-ticket-reasoning">${esc(t.reasoning)}</div>` : ''}
      </div>`).join('');

    body.innerHTML = `
      <div class="ai-diag-card">
        <div class="ai-diag-card-cat ${catCls}">${esc(catLabel)}</div>
        ${p.scope === 'out_of_scope' && p.outOfScopeReason ? `<div class="ai-diag-card-tag">Reason: ${esc(p.outOfScopeReason)}</div>` : ''}
        ${ticketsHtml}
        <div class="ai-diag-card-reason">${esc(p.reasoning || '')}</div>
        <div class="ai-diag-card-usage">${esc(formatAiDiagUsage(p.usage))}</div>
        <div class="ai-diag-card-actions">
          <button class="btn btn-secondary" id="ai-diag-accept-btn">Accept${p.tickets.length > 1 ? ' All' : ''}</button>
          <button class="btn btn-secondary" id="ai-diag-decline-btn">Decline</button>
        </div>
      </div>`;
    document.getElementById('ai-diag-accept-btn').addEventListener('click', acceptAiProposal);
    document.getElementById('ai-diag-decline-btn').addEventListener('click', () => { aiDiagState = 'decline_input'; renderAiDiagPanel(); });
    return;
  }
  if (aiDiagState === 'decline_input' && aiDiagProposal) {
    body.innerHTML = `
      <div class="ai-diag-card">
        <div class="ai-diag-card-cat">Decline AI Suggestion</div>
        <textarea id="ai-diag-decline-reason" placeholder="Enter reason for declining"></textarea>
        <div class="ai-diag-card-actions">
          <button class="btn btn-secondary" id="ai-diag-decline-submit-btn">Submit</button>
          <button class="btn btn-secondary" id="ai-diag-decline-cancel-btn">Cancel</button>
        </div>
      </div>`;
    document.getElementById('ai-diag-decline-submit-btn').addEventListener('click', () => {
      const reasonText = document.getElementById('ai-diag-decline-reason').value.trim();
      submitAiDiagDecision('decline', reasonText);
    });
    document.getElementById('ai-diag-decline-cancel-btn').addEventListener('click', () => { aiDiagState = 'proposal'; renderAiDiagPanel(); });
    return;
  }
  // idleはここに来ない(renderFeedbackPanelがaiDiagState==='idle'ならrenderManualFeedbackPanelに振り分けるため)
}

async function runAiDiagnosis() {
  if (!feedbackContext) return;
  aiDiagState = 'analyzing';
  renderAiDiagPanel();
  resetAiDiagApiCallCounts();
  try {
    const query = feedbackContext.query;
    const modelKey = aiDiagSettings.model;
    const modelId = AI_DIAG_MODEL_IDS[modelKey] || AI_DIAG_MODEL_IDS.haiku;
    const usage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    const addUsage = (data) => {
      usage.inputTokens              += data?.usage?.input_tokens               ?? 0;
      usage.outputTokens             += data?.usage?.output_tokens              ?? 0;
      usage.cacheCreationInputTokens += data?.usage?.cache_creation_input_tokens ?? 0;
      usage.cacheReadInputTokens     += data?.usage?.cache_read_input_tokens     ?? 0;
    };

    // ステップ0: クエリの分類(専用の最小プロンプトで単発呼び出し)。
    // poi/address/region/place/locality/neighborhood/others → 唯一の正解を探すフロー、
    // poi_brand/poi_category → カバレッジを見るフロー、unknown → 即unclear確定
    const classifyData = await callClaudeRaw(AI_DIAG_CLASSIFY_PROMPT, [{ role: 'user', content: JSON.stringify({ q: query }) }], 400, modelId);
    addUsage(classifyData);
    const classifyParsed = parseAiJson(extractClaudeText(classifyData), 'classify', classifyData);
    const qType = classifyParsed.type;
    if (!AI_DIAG_QUERY_TYPES.includes(qType)) {
      throw new Error('AI returned an invalid query type');
    }

    let result;
    if (qType === 'unknown') {
      result = { scope: 'out_of_scope', outOfScopeReason: UNCLEAR_REASONS[0], tickets: [], reasoning: classifyParsed.reasoning || '' };
    } else {
      const ctx = await buildAiDiagContext(query);
      result = (qType === 'poi_brand' || qType === 'poi_category')
        ? await runAiDiagCoverageFlow(ctx, modelId, addUsage, qType)
        : await runAiDiagSpecificFlow(ctx, modelId, addUsage, qType);
      // POI品質統合チェック(重複+属性)はSpecific/Coverage共通・正解の有無に関わらず常時実行(runAiDiagPoiQualityCheck参照)
      const poiQualityTickets = await runAiDiagPoiQualityCheck(ctx, modelId, addUsage);
      result.tickets = [...result.tickets, ...poiQualityTickets];
    }

    usage.model = modelKey;
    usage.costJpy = estimateAiDiagCostJpy(modelKey, usage);
    usage.mapboxApiCalls = aiDiagApiCallCounts.mapbox;
    usage.googleApiCalls = aiDiagApiCallCounts.google;
    result.usage = usage;
    aiDiagProposal = result;
    aiDiagState = 'proposal';
  } catch (err) {
    aiDiagError = String(err.message || err);
    aiDiagState = 'error';
  }
  renderAiDiagPanel();
}

// AI診断のbadTagはAI_DIAG_DATA_BAD_TAGS(Coverage/Bugの9項目)に制限しているため、ここのキーもその9項目のみで足りる。
// ここでv2のticketスキーマに変換する(Coverage系→data/poi_missing、Bug系→data/属性間違い)
const AI_REASON_TICKET_MAP = {
  'poi coverage':               { dataIssue: 'poi_missing', dataSubtype: 'general' },
  'poi coverage (bus)':         { dataIssue: 'poi_missing', dataSubtype: 'bus' },
  'poi coverage (brand)':       { dataIssue: 'poi_missing', dataSubtype: 'brand' },
  'poi coverage (parking lot)': { dataIssue: 'poi_missing', dataSubtype: 'parking_lot' },
  'poi freshness':              { dataIssue: 'poi_attribute_wrong' },
  'address coverage':           { dataIssue: 'address_missing' },
  'poi duplication':            { dataIssue: 'poi_duplicate' },
  'wrong poi':                  { dataIssue: 'poi_attribute_wrong' },
  'wrong address':              { dataIssue: 'address_wrong' },
};
function convertAiReasonToTicket(reason) {
  const mapped = reason ? AI_REASON_TICKET_MAP[reason] : null;
  if (mapped) {
    return {
      problemType: 'data', dataIssue: mapped.dataIssue, dataSubtype: mapped.dataSubtype || null,
      action: DEFAULT_ACTION_FOR_DATA_ISSUE[mapped.dataIssue],
      note: 'AI diagnosis',
    };
  }
  if (reason) {
    // AI_DIAG_DATA_BAD_TAGSに制限しているため通常は通らないが、想定外のタグが返ってきた場合の保険
    return { problemType: 'search_engine', searchEngineIssues: [reason], note: 'AI diagnosis (unexpected tag)' };
  }
  // reasonなし = Mapbox/Google両方とも一致候補が見つからなかったケース(旧not_hit_both)。
  // 大半はデータが存在しないケースのため、POI欠損として記録する
  return { problemType: 'data', dataIssue: 'poi_missing', dataSubtype: 'general', action: 'add', note: 'AI diagnosis: no match on either Mapbox or Google' };
}

function acceptAiProposal() {
  submitAiDiagDecision('accept', null);
}

function submitAiDiagDecision(decision, declineReason) {
  const p = aiDiagProposal;
  recordAiDiagLog({
    query: feedbackContext?.query ?? null, fileName: feedbackContext?.fileName ?? null, rowIndex: feedbackContext?.rowIndex ?? null,
    model: aiDiagSettings.model, ignoreBbox: aiDiagSettings.ignoreBbox,
    proposal: p, decision, declineReason: declineReason || null,
  });
  if (decision === 'accept' && feedbackContext) {
    if (!feedbackContext.roundId) feedbackContext.roundId = newRoundId();
    if (p.scope === 'out_of_scope') {
      recordState(feedbackContext, 'out_of_scope', p.outOfScopeReason || UNCLEAR_REASONS[0]);
    } else if (p.tickets.length === 0) {
      recordState(feedbackContext, 'no_issue', null);
    } else {
      p.tickets.forEach(t => recordTicket(feedbackContext, t));
    }
    if (currentCsvFileId) renderCSVViewport();
  }
  aiDiagState = 'idle';
  aiDiagProposal = null;
  renderFeedbackPanel(); // aiDiagStateがidleに戻ったので、マニュアルパネル(start画面)へ戻る
}

// CSV Scan/AI Evaluation/Ask AIの3設定をヘッダーの1エントリに統一したダイアログ。
// Ask AIはSonnet 5固定(選択不可)のため、ここでは表示のみで読み書きしない
function openAiSettings() {
  document.getElementById('csv-scan-model-select').value = csvScanModel;
  document.getElementById('ai-diag-model-select').value = aiDiagSettings.model;
  document.getElementById('ai-diag-ignore-bbox-checkbox').checked = aiDiagSettings.ignoreBbox;
  document.getElementById('ask-ai-model-select').value = askAiModel;
  document.getElementById('ai-settings-dialog').classList.add('open');
}
document.getElementById('open-ai-settings-btn').addEventListener('click', openAiSettings);
document.getElementById('ai-settings-save').addEventListener('click', () => {
  csvScanModel = document.getElementById('csv-scan-model-select').value;
  saveCsvScanModel();
  aiDiagSettings = {
    model: document.getElementById('ai-diag-model-select').value,
    ignoreBbox: document.getElementById('ai-diag-ignore-bbox-checkbox').checked,
  };
  saveAiDiagSettings();
  askAiModel = document.getElementById('ask-ai-model-select').value;
  saveAskAiModel();
  closeDialog('ai-settings-dialog');
});

// ============================================================
// QUERY HISTORY (↑/↓キーで遡る。最大100件)
// ============================================================
const LS_QUERY_HISTORY = 'apc_query_history';
function loadQueryHistory() { try { return JSON.parse(localStorage.getItem(LS_QUERY_HISTORY) || '[]'); } catch { return []; } }
function saveQueryHistory(arr) { localStorage.setItem(LS_QUERY_HISTORY, JSON.stringify(arr)); }
let queryHistory = loadQueryHistory(); // 先頭が最新
let queryHistoryPos = -1;              // -1 = 履歴を辿っていない(入力中の下書き)
let queryHistoryDraft = '';

function pushQueryHistory(q) {
  if (!q) return;
  queryHistory = queryHistory.filter(x => x !== q);
  queryHistory.unshift(q);
  if (queryHistory.length > 100) queryHistory.length = 100;
  saveQueryHistory(queryHistory);
}

// ============================================================
// LOCATION HELPERS
// ============================================================
function getCurrentLocation() {
  if (googleApiMode === 'new') {
    const rect = state.googleParams.locationRestriction?.rectangle;
    if (rect) return { lat: (rect.low.latitude + rect.high.latitude) / 2, lng: (rect.low.longitude + rect.high.longitude) / 2 };
    return { lat: DEFAULT_LAT, lng: DEFAULT_LNG };
  } else {
    return state.googleParams.location ?? { lat: DEFAULT_LAT, lng: DEFAULT_LNG };
  }
}

function getCurrentRadius() {
  if (googleApiMode === 'new') {
    const rect = state.googleParams.locationRestriction?.rectangle;
    if (rect) return ((rect.high.latitude - rect.low.latitude) / 2) * 111000;
    return DEFAULT_RADIUS;
  } else {
    return state.googleParams.radius ?? DEFAULT_RADIUS;
  }
}

function setLocationToState(lat, lng) {
  if (googleApiMode === 'new') {
    const radius = getCurrentRadius(), offset = radius / 111000;
    state.googleParams.locationRestriction = {
      rectangle: {
        low:  { latitude: lat - offset, longitude: lng - offset },
        high: { latitude: lat + offset, longitude: lng + offset },
      },
    };
  } else {
    state.googleParams.location = { lat, lng };
  }
}

// ============================================================
// RADIUS CONTROL
// ============================================================
function applyRadius(radius) {
  const { lat, lng } = getCurrentLocation();
  const offset = radius / 111000;
  if (googleApiMode === 'legacy') state.googleParams.radius = radius;
  if (googleApiMode === 'new') {
    state.googleParams.locationRestriction = {
      rectangle: { low: { latitude: lat - offset, longitude: lng - offset }, high: { latitude: lat + offset, longitude: lng + offset } },
    };
  }
  state.mapboxParams.bbox = [+(lng-offset).toFixed(6), +(lat-offset).toFixed(6), +(lng+offset).toFixed(6), +(lat+offset).toFixed(6)];
  refreshParamUI('google'); refreshParamUI('mapbox'); updateBboxBtn();
  writeToURL(); drawRangeOverlays();
}

// ============================================================
// URL SYNC
// ============================================================
function encodeState(s) {
  return LZString.compressToEncodedURIComponent(JSON.stringify({ q: s.query, g: s.googleParams, m: s.mapboxParams, mode: googleApiMode }));
}

function decodeState(encoded) {
  try {
    const p = JSON.parse(LZString.decompressFromEncodedURIComponent(encoded));
    if (p.mode) googleApiMode = p.mode;
    const defaultG = googleApiMode === 'new' ? DEFAULT_GOOGLE_PARAMS_NEW : DEFAULT_GOOGLE_PARAMS_LEGACY;
    return { query: p.q ?? '', googleParams: { ...structuredClone(defaultG), ...p.g }, mapboxParams: { ...structuredClone(DEFAULT_MAPBOX_PARAMS), ...p.m } };
  } catch { return null; }
}

function readFromURL() {
  const encoded = new URLSearchParams(window.location.search).get('state');
  if (!encoded) return false;
  const decoded = decodeState(encoded);
  if (decoded) { state = decoded; return true; }
  return false;
}

function writeToURL() {
  // proximityをFormで手動編集した直後は、ここでの自動追従上書きをスキップする(でないと入力した値がその場で消える)
  if (!mapboxProximityManual) state.mapboxParams.proximity = getCurrentLocation();
  const url = new URL(window.location.href);
  url.searchParams.set('state', encodeState(state));
  window.history.replaceState(null, '', url.toString());
}

// ============================================================
// LAST RESULT PERSISTENCE (localStorage)
// ============================================================
const LS_LAST_RESULT = 'apc_last_search_result';

function persistLastResult() {
  try {
    localStorage.setItem(LS_LAST_RESULT, JSON.stringify({
      query: state.query, mode: googleApiMode,
      googleParams: state.googleParams, mapboxParams: state.mapboxParams,
      googleRawResults, mapboxRawResults, savedAt: new Date().toISOString(),
    }));
  } catch (e) { console.warn('[persistLastResult] failed:', e); }
}

function loadLastResult() {
  try { return JSON.parse(localStorage.getItem(LS_LAST_RESULT) || 'null'); } catch { return null; }
}

// ============================================================
// RESIZERS
// ============================================================
function makeResizer(resizerId, topEl, getContainer, onResize) {
  const resizer = document.getElementById(resizerId);
  let dragging = false, startY = 0, startTopH = 0;
  resizer.addEventListener('mousedown', (e) => {
    dragging = true; startY = e.clientY; startTopH = topEl.offsetHeight;
    resizer.classList.add('dragging'); document.body.style.userSelect = 'none'; document.body.style.cursor = 'row-resize';
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const container = getContainer();
    let totalResizerH = 0; container.querySelectorAll('.resizer').forEach(r => totalResizerH += r.offsetHeight);
    const newTopH = Math.max(60, Math.min(container.clientHeight - totalResizerH - 60, startTopH + e.clientY - startY));
    topEl.style.height = newTopH + 'px'; topEl.style.flex = 'none';
    if (onResize) onResize();
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return; dragging = false; resizer.classList.remove('dragging');
    document.body.style.userSelect = ''; document.body.style.cursor = '';
  });
}

function initResizers() {
  const layout = document.getElementById('layout'), mapRow = document.getElementById('map-row');
  const available = layout.clientHeight - 5;
  mapRow.style.height = Math.floor(available * 0.5) + 'px'; mapRow.style.flex = 'none';
  const resize = () => { if (googleMap) google.maps.event.trigger(googleMap, 'resize'); if (mapboxMap) mapboxMap.resize(); };
  makeResizer('resizer-map-results', mapRow, () => layout, resize);
  const csvPanel = document.getElementById('csv-panel');
  makeResizer('resizer-csv-layout', csvPanel, () => document.body, resize);
}

// ============================================================
// GOOGLE MAPS
// ============================================================
let googleMap = null, googleMarkers = [], googleServiceReady = false, placesService = null;

let googleMapsLoadPromise = null;

function loadGoogleMaps() {
  if (googleMapsLoadPromise) return googleMapsLoadPromise;
  if (window.google?.maps) return Promise.resolve();

  googleMapsLoadPromise = new Promise((resolve, reject) => {
    const savedDefine  = window.define;
    const savedRequire = window.require;
    window.define  = undefined;
    window.require = undefined;

    const script = document.createElement('script');
    script.src   = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_API_KEY}&libraries=places`;
    script.async  = true;
    script.onload = () => {
      window.define  = savedDefine;
      window.require = savedRequire;
      resolve();
    };
    script.onerror = () => {
      window.define  = savedDefine;
      window.require = savedRequire;
      reject(new Error('Google Maps load failed'));
    };
    document.head.appendChild(script);
  });

  return googleMapsLoadPromise;
}

async function initGoogleMap() {
  await loadGoogleMaps();
  const loc = getCurrentLocation();
  googleMap = new google.maps.Map(document.getElementById('google-map'), { center: loc, zoom: 12 });
  placesService = new google.maps.places.PlacesService(document.createElement('div'));
  googleServiceReady = true;
  googleMap.addListener('idle', syncFromGoogle);
  googleMap.addListener('click', (e) => setLocationPin(e.latLng.lat(), e.latLng.lng()));
  setLocationPin(loc.lat, loc.lng);
  drawGoogleOverlay();
}

function plotGoogleMarkers(results) {
  googleMarkers.forEach(m => m.setMap(null)); googleMarkers = [];
  results.forEach((r, i) => {
    const marker = new google.maps.Marker({
      position: { lat: r.geometry.location.lat, lng: r.geometry.location.lng },
      map: googleMap,
      title: r.name,
      label: { text: String(i + 1), color: '#fff', fontSize: '10px', fontWeight: 'bold' },
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 12, fillColor: '#1a73e8', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
    });
    googleMarkers.push(marker);
  });
}

async function searchGoogleLegacy(query) {
  if (!googleServiceReady) await initGoogleMap();

  const request = { query };
  for (const [k, v] of Object.entries(state.googleParams)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;

    if (k === 'location' && v?.lat != null && v?.lng != null) {
      request.location = new google.maps.LatLng(v.lat, v.lng);
    } else if (k === 'types' && Array.isArray(v)) {
      request.type = v[0]; // Legacyは1つのみ
    } else {
      request[k] = v;
    }
  }

  return new Promise((resolve) => {
    placesService.textSearch(request, (results, status) => {
      if (status === google.maps.places.PlacesServiceStatus.OK && results) {
        resolve(results.map(r => ({
          place_id: r.place_id ?? '',
          name: r.name ?? '',
          formatted_address: r.formatted_address ?? '',
          geometry: { location: { lat: r.geometry?.location?.lat() ?? 0, lng: r.geometry?.location?.lng() ?? 0 } },
          types: r.types ?? [],
        })));
      } else {
        resolve({ error: `Places API error: ${status}` });
      }
    });
  });
}

function buildGoogleNewBody(query) {
  const body = {};
  for (const [k, v] of Object.entries(state.googleParams)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    body[k] = v;
  }
  body.textQuery = query;
  return body;
}

async function searchGoogleNew(query) {
  const body = buildGoogleNewBody(query);
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_API_KEY,
      'X-Goog-FieldMask':
        'places.id,places.displayName,places.formattedAddress,places.location,places.types',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Places API (New) error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.places ?? []).map(p => ({
    place_id: p.id ?? '',
    name: p.displayName?.text ?? '',
    formatted_address: p.formattedAddress ?? '',
    geometry: { location: { lat: p.location?.latitude ?? 0, lng: p.location?.longitude ?? 0 } },
    types: p.types ?? [],
  }));
}

async function searchGoogle(query) {
  return googleApiMode === 'new' ? searchGoogleNew(query) : searchGoogleLegacy(query);
}

// ============================================================
// MAPBOX
// ============================================================
let mapboxMap = null, mapboxMarkers = [];

function initMapboxMap() {
  mapboxgl.accessToken = MAPBOX_TOKEN;
  const center = state.mapboxParams.proximity;
  mapboxMap = new mapboxgl.Map({ container: 'mapbox-map', style: MAPBOX_STYLE, center: [center.lng, center.lat], zoom: 12 });
  mapboxMap.on('load', () => { mapboxMap.resize(); drawMapboxBbox(); applyPoiDensity(1); });
  mapboxMap.on('moveend', syncFromMapbox);
  mapboxMap.on('click', (e) => setLocationPin(e.lngLat.lat, e.lngLat.lng));
}

function plotMapboxMarkers(results) {
  mapboxMarkers.forEach(m => m.remove()); mapboxMarkers = [];
  if (!results.length || !mapboxMap) return;
  results.forEach((r, i) => {
    const el = document.createElement('div');
    Object.assign(el.style, {
      width: '24px', height: '24px', background: '#e74c3c', borderRadius: '50%',
      color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '10px', fontWeight: 'bold', border: '2px solid white',
      boxShadow: '0 2px 4px rgba(0,0,0,0.4)', cursor: 'pointer',
    });
    el.textContent = String(i + 1);
    const marker = new mapboxgl.Marker({ element: el })
      .setLngLat([r.coordinates.longitude, r.coordinates.latitude])
      .setPopup(new mapboxgl.Popup({ offset: 16 })
        .setHTML(`<b>${r.name}</b><br/><span style="font-size:11px">${r.full_address}</span>`))
      .addTo(mapboxMap);
    marker._customEl = el;
    mapboxMarkers.push(marker);
  });
}

function serializeMapboxParam(value) {
  if (value == null || value === '') return null;
  if (Array.isArray(value)) {
    return value.length === 0 ? null : value.join(',');
  }
  if (typeof value === 'object') {
    if (value.lng != null && value.lat != null) return `${value.lng},${value.lat}`;
    return JSON.stringify(value);
  }
  return String(value);
}

function buildMapboxParams(query, includeToken) {
  const params = new URLSearchParams({ q: query });
  // csv-toolbarのIgnore bbox/nav profileチェックボックスは、CSV読み込み中のクエリにのみ適用する
  const isCsvQuery = !!currentCsvFileId && csvIndex >= 0;
  for (const [k, v] of Object.entries(state.mapboxParams)) {
    if (isCsvQuery && csvIgnoreBbox && k === 'bbox') continue;
    if (isCsvQuery && csvIgnoreNavProfile && k === 'navigation_profile') continue;
    const s = serializeMapboxParam(v);
    if (s !== null) params.set(k, s);
  }
  params.set('access_token', includeToken ? MAPBOX_TOKEN : '****');
  return params;
}

async function searchMapbox(query) {
  const params = buildMapboxParams(query, true);
  const res = await fetch(`https://api.mapbox.com/search/searchbox/v1/forward?${params}`);
  if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
  const data = await res.json();
  return (data.features ?? []).map(f => ({
    ...f.properties,
    coordinates: {
      longitude: f.geometry?.coordinates?.[0] ?? 0,
      latitude:  f.geometry?.coordinates?.[1] ?? 0,
    },
  }));
}

// ============================================================
// RENDER
// ============================================================
// 2点間の距離をhaversine公式で概算(km)。proximity/locationからの近さの目安表示にのみ使うので厳密な測地線計算はしない。
const EARTH_RADIUS_KM = 6371;
function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
const NEAR_PROXIMITY_KM = 5;
// proximity(Mapbox)/location(Google)からresultまでの距離を常に計算し、
// { badge: 🅿️マークのHTML(NEAR_PROXIMITY_KM以内の時だけ), tooltip: 吹き出し用テキスト(距離が分かれば常に付く), km: 距離(km、不明ならnull) } を返す
function nearProximityInfo(centerLat, centerLng, resultLat, resultLng) {
  if (centerLat == null || centerLng == null || resultLat == null || resultLng == null) return { badge: '', tooltip: '', km: null };
  if (!isFinite(centerLat) || !isFinite(centerLng) || !isFinite(resultLat) || !isFinite(resultLng)) return { badge: '', tooltip: '', km: null };
  const km = haversineDistanceKm(centerLat, centerLng, resultLat, resultLng);
  if (km > NEAR_PROXIMITY_KM) return { badge: '', tooltip: `proximity/locationから${km.toFixed(1)}km(${NEAR_PROXIMITY_KM}km超)`, km };
  return { badge: `<span class="proximity-badge">P</span>`, tooltip: `proximity/locationから${km.toFixed(1)}km(${NEAR_PROXIMITY_KM}km以内)`, km };
}
// AIに渡す用の距離コンパクト表記(1km未満はm、以上はkm小数点1桁)
function formatDistanceCompact(km) {
  if (km == null || !isFinite(km)) return null;
  return km < 1 ? `${Math.round(km * 1000)}m` : `${km.toFixed(1)}km`;
}

function renderGoogleResults(data) {
  const el = document.getElementById('google-results'), countEl = document.getElementById('google-count');
  if (data.error) { el.innerHTML = `<p class="status-msg status-error">${data.error}</p>`; countEl.textContent = ''; return; }
  if (!data.length) { el.innerHTML = `<p class="status-msg">No results</p>`; countEl.textContent = ''; return; }
  countEl.textContent = `${data.length} results`;
  el.innerHTML = data.map((r, i) => `
    <div class="result-item" style="cursor:pointer;"
         data-lat="${r.geometry.location.lat}" data-lng="${r.geometry.location.lng}">
      <div class="result-index google-index">${i+1}</div>
      <div>
        <div class="result-name">${r.name}</div>
        <div class="result-address">${r.formatted_address}</div>
        <div class="result-type">${r.types.join(', ')}</div>
      </div>
    </div>`).join('');

  el.querySelectorAll('.result-item').forEach((item, i) => {
    item.addEventListener('click', () => {
      const lat = parseFloat(item.dataset.lat);
      const lng = parseFloat(item.dataset.lng);
      centerMapsTo(lat, lng);
      highlightGoogleMarker(i);
    });
  });
}

function renderMapboxResults(data) {
  const el = document.getElementById('mapbox-results'), countEl = document.getElementById('mapbox-count');
  if (data.error) { el.innerHTML = `<p class="status-msg status-error">${data.error}</p>`; countEl.textContent = ''; return; }
  if (!data.length) { el.innerHTML = `<p class="status-msg">No results</p>`; countEl.textContent = ''; return; }
  countEl.textContent = `${data.length} results`;

  // 候補内重複チェック: namesMatchのうち「name側」の判定ロジック(normalizeNameForMatchによるNFKC+空白除去+完全一致)だけを使う。
  // treatAsAddress=trueの前方/後方一致は緩すぎて(住所の一部が他の住所の末尾と偶然一致する等)誤検出が多いため使わない
  const duplicateMatchIndexes = data.map((r, i) =>
    data.map((other, j) => (i !== j && namesMatch(r.name, other.name, false)) ? j + 1 : null).filter(n => n != null));

  el.innerHTML = data.map((r, i) => `
    <div class="result-item" style="cursor:pointer;"
         data-lat="${r.coordinates.latitude}" data-lng="${r.coordinates.longitude}">
      <div class="result-index mapbox-index">${i+1}</div>
      <div>
        <div class="result-name">${r.name??''}${duplicateMatchIndexes[i].length ? ` <span class="duplicate-badge">duplicated with ${duplicateMatchIndexes[i].map(n => `#${n}`).join(', ')}</span>` : ''}</div>
        <div class="result-address">${r.full_address??''}</div>
        <div class="result-type">${[r.feature_type,...(r.poi_category??[])].filter(Boolean).join(' · ')}</div>
      </div>
      <div class="result-actions">
        <button type="button" class="result-copy-btn" data-idx="${i}" title="Copy name/address/id">Copy</button>
        <button type="button" class="result-ask-ai-btn" data-idx="${i}" title="Ask AI to check this result">Ask AI</button>
      </div>
    </div>`).join('');

  el.querySelectorAll('.result-item').forEach((item, i) => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.result-actions')) return;
      const lat = parseFloat(item.dataset.lat);
      const lng = parseFloat(item.dataset.lng);
      centerMapsTo(lat, lng);
      highlightMapboxMarker(i);
    });
  });

  el.querySelectorAll('.result-ask-ai-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = data[parseInt(btn.dataset.idx, 10)];
      openAskAiModal(r);
    });
  });

  el.querySelectorAll('.result-copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = data[parseInt(btn.dataset.idx, 10)];
      const text = `name:${r.name ?? ''}\naddress:${r.full_address ?? ''}\nid:${r.mapbox_id ?? ''}`;
      navigator.clipboard.writeText(text);
      const orig = btn.textContent;
      btn.textContent = '✅';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    });
  });
}

// ============================================================
// ASK AI (Mapbox結果1件についてPOIの実在/最新性/タグ正確性をAIの世界知識でチェックさせ、
// 住所と緯度経度の整合だけはAIに頼らずMapbox Temporary Geocoding API(reverse)で機械的に検証する)
// モデルはAI診断のバッチ設定(aiDiagSettings.model)から独立させ、常にSonnet 5固定にする。
// (Ask AIは1件ずつ手動で呼ぶ低頻度の操作でコストがほぼ問題にならない一方、実在性等の判定は
//  モデルの世界知識の量そのものに依存するため、Haikuでは精度不足になりやすい)
// ステートレスな単発呼び出し
// ============================================================
// temperatureは変更しない: モデルの知識量はtemperatureと無関係(学習時点で固定)で、上げてもJSON出力が
// 崩れたり事実でない内容を断定しやすくなるリスクがあるだけ。「知識があれば断定してよい」はプロンプト文言側で担保する
//
// 【重要な限界】このAPI呼び出しはツール(Web検索等)を一切使わない素のMessages API呼び出しであり、
// モデルは学習時点で凍結された知識だけで判断する。つまり「学習カットオフ以降に実際に起きた
// 閉店・改名・住所変更」はどれだけプロンプトを工夫しても原理的に知り得ない。
// ここでのプロンプト強化は「知っている範囲の精度(誤って過信/過小評価しない)」を上げるためのものであり、
// 「今現在の状態を確実に言い当てられるようにする」ものではない。
// Mapbox Search Box APIのpoi_category canonical_id一覧(日本、285件)。
// 出典: geonator_lite/data/category-taxonomy.js (CATEGORY_TAXONOMY)。プロジェクトを跨いだimportはできないため
// 手動コピー。">"は親>子の階層(トップカテゴリのみの行、トップ>サブの行がそれぞれ独立したcanonical_id)。
// tags_correctチェックで「poi_categoryがこの一覧の中でベストマッチか」を判定させるために使う
const CATEGORY_TAXONOMY = [
  "ショップ","ショップ>おもちゃ","ショップ>たばこ","ショップ>アウトドア用品","ショップ>アウトレット","ショップ>カメラ",
  "ショップ>カー用品","ショップ>コンビニ","ショップ>ゴルフ用品","ショップ>ショッピングセンター","ショップ>ジュエリー",
  "ショップ>スキー用品","ショップ>スポーツ用品","ショップ>スーパー","ショップ>チケット販売","ショップ>ディスカウントショップ",
  "ショップ>ハンドバッグ","ショップ>バイク販売","ショップ>ファッション(女性)","ショップ>ファッション(男性)","ショップ>ブライダル",
  "ショップ>ベッド","ショップ>ベビー用品","ショップ>ペット用品","ショップ>ホームセンター","ショップ>メガネ","ショップ>リサイクル",
  "ショップ>中古車販売","ショップ>健康食品","ショップ>八百屋","ショップ>化粧品","ショップ>子ども服","ショップ>家具",
  "ショップ>携帯電話","ショップ>文房具","ショップ>新車販売","ショップ>日用雑貨","ショップ>時計","ショップ>書籍","ショップ>百貨店",
  "ショップ>米店","ショップ>肉屋","ショップ>自然食品","ショップ>自転車","ショップ>花屋","ショップ>薬局","ショップ>質屋",
  "ショップ>酒店","ショップ>釣り用品","ショップ>電化製品","ショップ>靴","ショップ>音楽","ショップ>音楽楽器","ショップ>鮮魚店",
  "トラベル","トラベル>ガソリンスタンド","トラベル>サービスエリア","トラベル>タクシー","トラベル>チャージステーション",
  "トラベル>バス","トラベル>フェリー","トラベル>ホテル","トラベル>レンタカー","トラベル>公共の宿","トラベル>旅行代理店",
  "トラベル>旅館","トラベル>民宿","トラベル>温泉","トラベル>港","トラベル>空港","トラベル>観光名所","トラベル>観光案内",
  "トラベル>鉄道","トラベル>飛行機","トラベル>駅","トラベル>駐車場",
  "レジャー","レジャー>お城","レジャー>ウィンタースポーツ","レジャー>カジノ","レジャー>カラオケボックス","レジャー>キャンプ場",
  "レジャー>クルージング","レジャー>ゲームセンター","レジャー>ゴルフ","レジャー>サッカー","レジャー>スケート",
  "レジャー>スポーツジム","レジャー>スポーツ競技場","レジャー>セーリング","レジャー>テニス","レジャー>テーマパーク",
  "レジャー>ナイトクラブ","レジャー>バスケットボール","レジャー>パチンコ","レジャー>ビリヤード","レジャー>ボウリング",
  "レジャー>ボクシング","レジャー>マリンスポーツ","レジャー>モーターレース","レジャー>ヨガ","レジャー>公園","レジャー>劇場",
  "レジャー>動物園","レジャー>映画館","レジャー>植物園","レジャー>水族館","レジャー>水泳場","レジャー>牧場","レジャー>競馬",
  "レジャー>美術館","レジャー>自転車レンタル","レジャー>野球","レジャー>釣り","レジャー>音楽ホール","レジャー博物館",
  "レストラン","レストラン>うどん","レストラン>うなぎ","レストラン>お好み焼き","レストラン>かに","レストラン>しゃぶしゃぶ",
  "レストラン>すき焼き","レストラン>その他","レストラン>そば","レストラン>たこ焼き","レストラン>ちゃんぽん",
  "レストラン>とんかつ","レストラン>アイスクリーム","レストラン>アジアン料理","レストラン>アフリカ料理","レストラン>アメリカン",
  "レストラン>イタリアン","レストラン>インド料理","レストラン>カフェ","レストラン>カレー","レストラン>ケバブ",
  "レストラン>サンドイッチ","レストラン>シーフード","レストラン>ジャーマン","レストラン>スイーツ","レストラン>ステーキ",
  "レストラン>スパニッシュ","レストラン>タイ料理","レストラン>タピオカ","レストラン>ドーナツ","レストラン>ハラル料理",
  "レストラン>ハンバーガー","レストラン>バー","レストラン>パキスタン料理","レストラン>ビアガーデン","レストラン>ビュッフェ",
  "レストラン>ビーガン料理","レストラン>ピザ","レストラン>ファストフード","レストラン>ファミレス","レストラン>フレンチ",
  "レストラン>フードコート","レストラン>ブラジリアン","レストラン>ベジタリアン","レストラン>ベトナム料理",
  "レストラン>ベーカリー","レストラン>ホットドッグ","レストラン>メキシカン","レストラン>ラーメン","レストラン>ロシアン",
  "レストラン>ワインバー","レストラン>中華料理","レストラン>丼もの","レストラン>和菓子","レストラン>和食",
  "レストラン>喫茶店（その他）","レストラン>地中海","レストラン>天ぷら","レストラン>寿司","レストラン>居酒屋",
  "レストラン>弁当","レストラン>洋食","レストラン>焼き鳥","レストラン>焼肉","レストラン>西洋","レストラン>鍋料理",
  "レストラン>韓国料理","レストラン>餃子",
  "医療","医療>はり","医療>アレルギー科","医療>マッサージ","医療>リハビリテーション科","医療>内科","医療>外科",
  "医療>婦人科","医療>小児科","医療>整体","医療>整形外科","医療>歯科","医療>産婦人科","医療>病院","医療>皮膚科",
  "医療>眼科","医療>精神科","医療>美容外科","医療>耳鼻咽喉科","医療>薬局",
  "生活","生活>そろばん教室","生活>アート教室","生活>コインランドリー","生活>コンサルタント","生活>サウナ","生活>タトゥー",
  "生活>ダンス教室","生活>ドライクリーニング","生活>ネイルサロン","生活>ハウスクリーニング","生活>バイク修理",
  "生活>バレエ教室","生活>パソコン教室","生活>ビジネススクール","生活>ビデオレンタル","生活>ピアスショップ",
  "生活>ピアノ教室","生活>モスク","生活>レッカー","生活>レンタルショップ","生活>不動産","生活>中学校","生活>人材派遣",
  "生活>会計士","生活>保育園","生活>保育所","生活>保険業","生活>倉庫","生活>児童施設","生活>公証人","生活>動物病院",
  "生活>占い","生活>図書館","生活>国の機関","生活>大使館","生活>大学","生活>学校(その他)","生活>学習塾","生活>宅配便",
  "生活>宗教(その他)","生活>害虫駆除","生活>寺院","生活>専門学校","生活>小学校","生活>幼稚園","生活>弁護士",
  "生活>教会","生活>料理教室","生活>日焼けサロン","生活>水泳教室","生活>洗車場","生活>消防機関","生活>温泉浴場",
  "生活>着付け","生活>短期大学","生活>神社","生活>福祉施設","生活>税理士","生活>美容(その他)","生活>美容院",
  "生活>翻訳","生活>老人施設","生活>自動車修理","生活>自動車教習所","生活>葬祭業","生活>裁判所","生活>語学学校",
  "生活>警察機関","生活>貸衣装","生活>運送","生活>郵便局","生活>金融(その他)","生活>銀行","生活>銭湯","生活>鍵",
  "生活>防犯","生活>霊園","生活>靴修理","生活>音楽教室","生活>高等学校",
];

const ASK_AI_SYSTEM_PROMPT = `あなたは地図POIデータの品質チェックを行うアシスタントです。渡されたMapbox Search Box APIの検索結果1件(POI候補)について、あなたの知識に基づいて次の4項目を評価してください。

1. exists: このPOIが今も実在すると考えられるか
   - 単に「聞いたことがある/過去に存在した」だけでokにしないこと。倒産・閉店・チェーン全体の撤退・運営会社の吸収合併・再開発によるエリア一帯の取り壊し等、実在を疑わせる具体的な情報を知っているかどうかで判断すること
   - 具体的なネガティブ情報を知っていればng。特に負の情報を知らず、実在を疑う理由もなければok。判断材料がなければunknown
2. name_current: 名称が最新か
   - 「昔からある名前だから今も同じはず」ではなく、改名・リブランド・買収に伴う名称変更のニュースを具体的に知っているかで判断すること。知っていればng(noteに新旧両方の名称を書く)、知らなければok/unknown
3. address_current: 住所が最新か
   - 住所変更・地番整理・移転・再開発による住所変更のニュースを具体的に知っているかで判断すること
4. tags_correct: このPOIの実体(業種・扱っている商品/サービス)を踏まえたとき、poi_categoryが下記のMapboxカテゴリ一覧(このAPIが選択できるcanonical_idの全量)の中で最も適切な(ベストマッチな)分類になっているか
   - poi_categoryが一覧に存在しない値であればng(ハルシネーション/廃止された値の可能性が高い。noteにその旨を書く)
   - 一覧内の値ではあるが、同じ一覧の中にこのPOIの実体により合致する(より具体的、または実体そのものを指す)カテゴリが明らかに存在する場合はng(noteに、より適切と考えるカテゴリ名を一覧の表記そのままで書く)
   - 一覧内の値で、かつそれが一覧の粒度の中で現実的に最も適切(または同程度に妥当)な選択であればok
   - feature_typeが"poi"なのにpoi_categoryが空/nullの場合、一覧の中に明らかに当てはまるカテゴリがあればng(noteに提案カテゴリを書く)、判断がつかなければunknown
   - feature_typeがpoi以外(address/place等)の場合、poi_categoryが無いのは正常なのでokとすること

Mapboxカテゴリ一覧("親>子"は階層。この一覧に載っている表記からのみ判断すること):
${CATEGORY_TAXONOMY.join(', ')}

各項目についてverdict("ok"=問題なし, "ng"=問題あり, "unknown"=知識だけでは判断できない)とnote(日本語1文の根拠)を返してください。
このPOIについて知っていることがあれば、遠慮せず自信を持って断定してください(exists/name_current/address_currentはあなたの世界知識をそのまま使ってよい)。ただし「ok」は「今現在確実にそうだ」ではなく「知っている範囲でネガティブな情報がない」という意味であることを自覚し、具体的な根拠なしに安易に確信を装わないこと。本当に知らない/聞いたことがない場合、または知識がいつ時点のものか自信が持てない場合は正直にunknownとし、根拠のない憶測で断定しないこと。

出力は必ず以下のJSON形式のみ。説明文やコードブロックのマークダウンは付けないでください。
{"summary": "日本語で全体の総評1〜2文", "checks": {
  "exists": {"verdict": "ok"|"ng"|"unknown", "note": "..."},
  "name_current": {"verdict": "ok"|"ng"|"unknown", "note": "..."},
  "address_current": {"verdict": "ok"|"ng"|"unknown", "note": "..."},
  "tags_correct": {"verdict": "ok"|"ng"|"unknown", "note": "..."}
}}`;

const ASK_AI_CHECK_DEFS = [
  { key: 'exists',          label: 'POIが実在するか' },
  { key: 'name_current',    label: '名前が最新か' },
  { key: 'address_current', label: '住所が最新か' },
  { key: 'coord_match',     label: '住所と緯度経度に齟齬がないか' },
  { key: 'tags_correct',    label: 'タグ情報が正しいか' },
];
const ASK_AI_VERDICT_LABELS = { ok: '✅ OK', ng: '⚠️ NG', unknown: '❔ Unknown' };

// 緯度経度→住所をMapbox Temporary Geocoding API(v5, reverse)で引き、full_addressと突き合わせる。
// AIの推測に頼らず機械的に判定するため、既存の住所比較ロジック(normalizeAddressForMatch/namesMatch)を再利用する。
// country=jp/language=jaを固定指定(このツール自体が日本の住所を前提にしているため)
async function reverseGeocodeCheck(lat, lng, fullAddress) {
  const params = new URLSearchParams({ country: 'jp', language: 'ja', access_token: MAPBOX_TOKEN });
  const res = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?${params}`);
  if (!res.ok) throw new Error(`Reverse geocoding HTTP error: ${res.status}`);
  const data = await res.json();
  const geocodedAddress = data.features?.[0]?.place_name ?? '';
  if (!geocodedAddress) return { verdict: 'unknown', note: 'Reverse geocodingが結果を返しませんでした', geocodedAddress: '' };
  const matched = namesMatch(fullAddress ?? '', geocodedAddress, true);
  return {
    verdict: matched ? 'ok' : 'ng',
    note: matched
      ? `Reverse geocoding結果と一致: ${geocodedAddress}`
      : `Reverse geocoding結果と不一致。座標からの住所: ${geocodedAddress}`,
    geocodedAddress,
  };
}

function openAskAiModal(r) {
  document.getElementById('ask-ai-dialog').classList.add('open');
  document.getElementById('ask-ai-body').innerHTML = `<div class="ask-ai-processing">processing...</div>`;
  runAskAi(r);
}

async function runAskAi(r) {
  // AI診断のバッチ設定(aiDiagSettings.model)からは独立させた専用設定(askAiModel)を使う。
  // デフォルトはsonnet(低頻度・精度優先)だが、コストを抑えたい場合はhaikuも選択できる
  const modelKey = askAiModel;
  const modelId = AI_DIAG_MODEL_IDS[modelKey] || AI_DIAG_MODEL_IDS.sonnet;
  try {
    const payload = {
      name: r.name ?? null,
      full_address: r.full_address ?? null,
      feature_type: r.feature_type ?? null,
      poi_category: r.poi_category ?? null,
      maki: r.maki ?? null,
      brand: r.brand ?? null,
    };
    const lat = r.coordinates?.latitude, lng = r.coordinates?.longitude;
    // AIチェック(exists/name_current/address_current/tags_correct)とMapbox reverse geocoding(coord_match)は
    // 互いに依存しないので並行実行する
    const [aiData, coordResult] = await Promise.all([
      callClaudeRaw(ASK_AI_SYSTEM_PROMPT, [{ role: 'user', content: JSON.stringify(payload) }], 700, modelId),
      (lat != null && lng != null)
        ? reverseGeocodeCheck(lat, lng, r.full_address).catch(err => ({ verdict: 'unknown', note: `Reverse geocoding失敗: ${err.message || err}` }))
        : Promise.resolve({ verdict: 'unknown', note: '座標が取得できませんでした' }),
    ]);
    const parsed = parseAiJson(extractClaudeText(aiData), 'ask-ai');
    parsed.checks = { ...parsed.checks, coord_match: coordResult };

    const usage = {
      model: modelKey,
      inputTokens:  aiData?.usage?.input_tokens  ?? 0,
      outputTokens: aiData?.usage?.output_tokens ?? 0,
      cacheCreationInputTokens: aiData?.usage?.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens:     aiData?.usage?.cache_read_input_tokens     ?? 0,
    };
    usage.costJpy = estimateAiDiagCostJpy(modelKey, usage);
    renderAskAiResult(parsed, AI_DIAG_MODEL_LABELS[modelKey] || modelId, usage);
  } catch (err) {
    document.getElementById('ask-ai-body').innerHTML = `<div class="ask-ai-error">Error: ${esc(err.message || String(err))}</div>`;
  }
}

function renderAskAiResult(parsed, modelLabel, usage) {
  const checks = parsed.checks || {};
  document.getElementById('ask-ai-body').innerHTML = `
    <div class="ask-ai-model-tag">${esc(formatAiDiagUsage({ ...usage, mapboxApiCalls: 1, googleApiCalls: 0 }, 'Geocoding v5 reverse'))}</div>
    <div class="ask-ai-summary">${esc(parsed.summary || '')}</div>
    <div class="ask-ai-checklist">
      ${ASK_AI_CHECK_DEFS.map(def => {
        const c = checks[def.key] || {};
        const v = ['ok', 'ng', 'unknown'].includes(c.verdict) ? c.verdict : 'unknown';
        return `<div class="ask-ai-check">
          <div class="ask-ai-check-head">
            <span>${esc(def.label)}</span>
            <span class="ask-ai-check-verdict v-${v}">${ASK_AI_VERDICT_LABELS[v]}</span>
          </div>
          <div class="ask-ai-check-detail">${esc(c.note || '')}</div>
        </div>`;
      }).join('')}
    </div>`;
}

// ============================================================
// AI HINT (クエリ単位のヒント。existence + POI品質だけをAI診断の既存ロジックから流用して提示する)
// ============================================================
// 位置づけ: 手動フロー(人がGOOD/Almost!/badTag等を押して確定する)とAI診断(AIがscope/ticketsを
// 自分で確定する)の「中間」。AI診断のような自動確定は一切行わず、材料(有力候補・確信度・reasoning、
// 重複/wrong_poiの可能性)を提示するだけに留める。最終判断は常に人が手動フローのボタンで行う
// (Ask AIの単体POIチェックと同じ「提示するだけ」の設計をクエリ単位に広げたもの)。
// カバレッジ型(poi_brand/poi_category)は「答えが1つに定まらない」タイプのためexistenceヒント自体が
// 成立しない。誤って存在判定プロンプトに投げないよう、まず分類(S0)を走らせてから分岐する。

// existenceヒント: runAiDiagSpecificFlowのA-1(機械的レスキュー)/A-2(Mapbox単独判定)/A-4(Google単独判定)
// と同じロジックを流用するが、属性チェック(A-5)やticket化は行わない。「有力候補があるか、
// どちら側で見つかったか、確信度の根拠(reasoning)」を返すだけ
async function runAiHintExistence(ctx, modelId, addUsage) {
  const { mList, gList, mName, treatNameAsAddress } = ctx;

  if (gList.length) {
    const topGoogleName = ctx.gName(gList[0]);
    for (let i = 0; i < mList.length; i++) {
      if (namesMatch(mName(mList[i]), topGoogleName, treatNameAsAddress)) {
        return {
          matched: true, source: 'mapbox', name: mList[i]?.name ?? '', rank: i + 1,
          reasoning: "Mechanical cross-check: Google's top result name-matches this Mapbox candidate (no AI call needed for this).",
        };
      }
    }
  }

  const mapboxPayload = { q: ctx.query, prox: ctx.proxStr, bbox: ctx.bboxStr, bboxIgnored: ctx.bboxIgnored, mb: ctx.mapboxRows };
  const mData = await callClaudeRaw(AI_DIAG_MAPBOX_PROMPT, [{ role: 'user', content: JSON.stringify(mapboxPayload) }], 600, modelId);
  addUsage(mData);
  const mParsed = parseAiJson(extractClaudeText(mData), 'hint-mapbox', mData);
  if (mParsed.matched && mParsed.rank) {
    return { matched: true, source: 'mapbox', name: mList[mParsed.rank - 1]?.name ?? '', rank: mParsed.rank, reasoning: mParsed.reasoning || '' };
  }

  const googlePayload = { q: ctx.query, gg: ctx.googleRows };
  const gData = await callClaudeRaw(AI_DIAG_GOOGLE_PROMPT, [{ role: 'user', content: JSON.stringify(googlePayload) }], 600, modelId);
  addUsage(gData);
  const gParsed = parseAiJson(extractClaudeText(gData), 'hint-google', gData);
  if (gParsed.matched) {
    // AI_DIAG_GOOGLE_PROMPTの出力にはどのgg候補が一致したかの明示的なindex/rankが無い(ticket化のみを
    // 想定した既存スキーマのため)。reasoningの文中で言及される想定なので、name/rankはここでは示さない
    return { matched: true, source: 'google', name: '', rank: null, reasoning: gParsed.reasoning || '' };
  }
  return { matched: false, source: null, name: '', rank: null, reasoning: gParsed.reasoning || mParsed.reasoning || '' };
}

async function runAiHint() {
  if (!feedbackContext) return;
  resetAiDiagApiCallCounts();
  try {
    const query = feedbackContext.query;
    // Ask AI(単体POIチェック)と同じモデル設定を流用する(低頻度・精度優先の性質が同じため専用設定は作らない)
    const modelKey = askAiModel;
    const modelId = AI_DIAG_MODEL_IDS[modelKey] || AI_DIAG_MODEL_IDS.sonnet;
    const usage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    const addUsage = (data) => {
      usage.inputTokens              += data?.usage?.input_tokens               ?? 0;
      usage.outputTokens             += data?.usage?.output_tokens              ?? 0;
      usage.cacheCreationInputTokens += data?.usage?.cache_creation_input_tokens ?? 0;
      usage.cacheReadInputTokens     += data?.usage?.cache_read_input_tokens     ?? 0;
    };

    // S0: 分類(AI診断と同じプロンプトを流用)。existenceヒントが成立するタイプかどうかだけ見る
    const classifyData = await callClaudeRaw(AI_DIAG_CLASSIFY_PROMPT, [{ role: 'user', content: JSON.stringify({ q: query }) }], 400, modelId);
    addUsage(classifyData);
    const classifyParsed = parseAiJson(extractClaudeText(classifyData), 'hint-classify', classifyData);
    const qType = classifyParsed.type;
    if (!AI_DIAG_QUERY_TYPES.includes(qType)) throw new Error('AI returned an invalid query type');

    const ctx = await buildAiDiagContext(query);
    const existenceHint = (qType === 'poi_brand' || qType === 'poi_category' || qType === 'unknown')
      ? null
      : await runAiHintExistence(ctx, modelId, addUsage);
    // POI品質ヒント(重複/wrong_poi)はAI診断のrunAiDiagPoiQualityCheckをそのまま流用(既存実装のまま、
    // type=poiが2件以上あれば常に実行)。戻り値は"ticket"の形をしているが、ここではticket化(状態確定)せず
    // note/reasoningをヒント表示に使うだけ
    const qualityTickets = await runAiDiagPoiQualityCheck(ctx, modelId, addUsage);

    usage.model = modelKey;
    usage.costJpy = estimateAiDiagCostJpy(modelKey, usage);
    usage.mapboxApiCalls = aiDiagApiCallCounts.mapbox;
    usage.googleApiCalls = aiDiagApiCallCounts.google;

    renderAiHintResult({ qType, existenceHint, qualityTickets, usage });
  } catch (err) {
    document.getElementById('ai-hint-body').innerHTML = `<div class="ask-ai-error">Error: ${esc(err.message || String(err))}</div>`;
  }
}

function openAiHintDialog() {
  document.getElementById('ai-hint-dialog').classList.add('open');
  document.getElementById('ai-hint-body').innerHTML = `<div class="ask-ai-processing">processing...</div>`;
  runAiHint();
}

function renderAiHintResult({ qType, existenceHint, qualityTickets, usage }) {
  const existenceHtml = existenceHint === null
    ? `<div class="ask-ai-check">
         <div class="ask-ai-check-head"><span>Existence</span><span class="ask-ai-check-verdict v-unknown">— N/A</span></div>
         <div class="ask-ai-check-detail">${esc(`Query type is "${qType}" (no single correct answer), so existence doesn't apply here. See POI quality hints below.`)}</div>
       </div>`
    : `<div class="ask-ai-check">
         <div class="ask-ai-check-head"><span>Existence</span><span class="ask-ai-check-verdict v-${existenceHint.matched ? 'ok' : 'ng'}">${existenceHint.matched ? '✅ Likely match' : '⚠️ No match found'}</span></div>
         <div class="ask-ai-check-detail">${existenceHint.matched
            ? esc(`${existenceHint.source === 'mapbox' ? `Mapbox candidate${existenceHint.rank ? ` (rank ${existenceHint.rank})` : ''}: "${existenceHint.name}"` : 'Found on the Google side (not present in Mapbox)'} — ${existenceHint.reasoning}`)
            : esc(existenceHint.reasoning)}</div>
       </div>`;

  const qualityHtml = qualityTickets.length
    ? qualityTickets.map(t => `
        <div class="ask-ai-check">
          <div class="ask-ai-check-head"><span>${esc(t.dataIssue)}</span><span class="ask-ai-check-verdict v-ng">⚠️ Flagged</span></div>
          <div class="ask-ai-check-detail">${esc(t.note || '')}${t.reasoning ? esc(` — ${t.reasoning}`) : ''}</div>
        </div>`).join('')
    : `<div class="ask-ai-check">
         <div class="ask-ai-check-head"><span>POI quality</span><span class="ask-ai-check-verdict v-ok">✅ No issues flagged</span></div>
       </div>`;

  document.getElementById('ai-hint-body').innerHTML = `
    <div class="ask-ai-model-tag">${esc(formatAiDiagUsage(usage))}</div>
    <div class="ask-ai-summary">This is a hint only — nothing is set automatically. Review it, then use the manual flow buttons to finalize.</div>
    <div class="ask-ai-checklist">
      ${existenceHtml}
      ${qualityHtml}
    </div>`;
}

// ============================================================
// NAME STRIP (Google/Mapboxの全結果nameを一覧表示し、名前/住所の一致をハイライト)
// ============================================================
// 全角/半角・カタカナ半角などをNFKCで統一し、異体字(髙→高等)・「ヶ/ケ/ガ/が」表記ゆれ・法人格を除去し、
// 記号(ハイフン・&・中黒・括弧等)と空白を除去して比較用の文字列を作る。
// 記号は個別に列挙せず、Unicode区分(\p{P}=punctuation, \p{S}=symbol)単位でまとめて除去する
// (「セブン-イレブン」⇔「セブンイレブン」、「スターバックス・コーヒー」⇔「スターバックスコーヒー」、
//  「稲村が崎」⇔「稲村ガ崎」、「株式会社セブン-イレブン・ジャパン」⇔「セブン-イレブン・ジャパン」等の表記ゆれを吸収)。
// 括弧は記号(かっこ自体)だけ除去し中身の文字列は残す(例:「(渋谷店)」→「渋谷店」)。
// 注意: 「ー」(カタカナ長音符, U+30FC)はUnicode上Letter区分でありP/Sに含まれないため、
// 「スーパー」のような長音を含む語がこの除去で壊れることはない
function normalizeNameForMatch(s) {
  if (!s) return '';
  let t = canonicalizeVariantKanji(s.normalize('NFKC'));
  t = unifyKaNotation(t);
  t = stripCorporateEntity(t);
  return t.replace(/[\p{P}\p{S}]/gu, '').replace(/\s+/g, '').toLowerCase();
}

// POI名でGoogle/Mapbox間の法人格の有無・表記が非対称になりやすいため除去する(例:
// 「株式会社セブン-イレブン・ジャパン」⇔「セブン-イレブン・ジャパン」、「(株)ローソン」⇔「ローソン」)。
// 前株(先頭)/後株(末尾)どちらの位置にも出現するためアンカーせずグローバル置換する。
// 「医療法人社団」等、より長く具体的な表記を先に列挙し、その部分文字列(医療法人)だけが先に食われて
// 「社団」が消え残ることのないようにする(配列の並び順が重要)。
const CORPORATE_ENTITY_RE = new RegExp([
  '地方独立行政法人', '独立行政法人',
  '医療法人社団', '医療法人',
  '社会福祉法人', '学校法人', '宗教法人',
  '特定非営利活動法人', '一般社団法人', '一般財団法人', '公益社団法人', '公益財団法人',
  '株式会社', '有限会社', '合同会社', '合資会社', '合名会社',
  '\\(株\\)', '（株）', '\\(有\\)', '（有）',
].join('|'), 'g');
function stripCorporateEntity(s) {
  return s.replace(CORPORATE_ENTITY_RE, '');
}

// Google/Mapbox間で表記が割れやすい旧字体/異体字を新字体へ統一する(NFKCは字体の違いまでは統一しない)。
// 安全性の高い頻出ペアのみを辞書化。将来ペアを追加しやすいようプレーンオブジェクトのままにしておく。
// POI名・住所どちらの正規化からも呼ぶ(建物名・地名・店舗名のどれにも出現し得るため)。
const VARIANT_KANJI_MAP = {
  '髙': '高', '﨑': '崎', '邊': '辺', '邉': '辺',
  '齋': '斎', '齊': '斉', '澤': '沢', '龍': '竜',
  '國': '国', '學': '学',
};
const VARIANT_KANJI_RE = new RegExp(Object.keys(VARIANT_KANJI_MAP).join('|'), 'g');
function canonicalizeVariantKanji(s) {
  return s.replace(VARIANT_KANJI_RE, ch => VARIANT_KANJI_MAP[ch]);
}

// 都道府県名の先頭位置を探し、それより前(国名「日本」や郵便番号など)を丸ごと切り捨てる
// (「日本、〒106-0032 東京都港区...」→「東京都港区...」。都道府県名を含めた形で残す)
const PREFECTURE_RE = /(北海道|東京都|京都府|大阪府|[一-鿿々]{2,3}県)/;
function stripBeforePrefecture(s) {
  const m = s.match(PREFECTURE_RE);
  return m ? s.slice(m.index) : s;
}

// 「ヶ/ケ/ガ/が」は同じ地名でも表記が割れやすいため(千駄ヶ谷/千駄ケ谷/千駄が谷、稲村ヶ崎/稲村ガ崎/稲村が崎 等)、
// 比較用に「が」へ統一する(ガは片仮名の濁点付き「ケ」+濁点、がは平仮名。同じ音でも表記元が異なるだけで別文字なので
// NFKCでは変換されない。地名・店舗名どちらにも出現するため、name用/address用の正規化どちらからも呼ぶ)。
// 漢字に挟まれた場合だけを対象にする(前後を要求): 「ガスト」「ケンタッキー」「メガネスーパー」のような
// 通常のカタカナ語(前後がカタカナ)まで誤って書き換えてしまう事故を防ぐため。地名の「ヶ/ケ/ガ」は
// 稲村ヶ崎・霞ヶ関・千駄ヶ谷のように必ず漢字+ヶ/ケ/ガ+漢字の形になるため、この限定で実害なく両立できる。
function unifyKaNotation(s) {
  return s.replace(/(?<=\p{Script=Han})[ヶケガ](?=\p{Script=Han})/gu, 'が');
}

// 都道府県の直後に続く「郡」区分は省略されることがある(例:「青森県上北郡六戸町」⇔「青森県六戸町」)ため、
// 郡名(番地の数字やハイフンを含まない1〜6文字)+「郡」をまとめて除去する。
// ただし「郡」の直後から町/村に達するまでの間に「市」を挟む場合は除去しない(例:「奈良県大和郡山市」の
// 「郡」は郡区分ではなく市名の一部。日本の行政区画上、郡の構成要素は町・村のみで市を含み得ないため、
// 間に市があるという事実だけで「これは郡ではない」と機械的に判定できる)。
const COUNTY_RE = /^(北海道|東京都|京都府|大阪府|[一-鿿々]{2,3}県)[^\d\s,、\-]{1,6}郡(?=[^\d\s,、\-市]{1,6}[町村])/;
function stripCountySegment(s) {
  return s.replace(COUNTY_RE, '$1');
}

// 漢数字(〇/一〜九/十)の連続を算用数字に変換する(0〜99程度の丁目・番地・号を想定)
// 例: "三"→"3"、"十一"→"11"、"二十三"→"23"。変換対象外の文字が混じる場合はそのまま返す。
const KANJI_DIGIT_MAP = { '〇': 0, '○': 0, '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
function kanjiNumeralToArabic(str) {
  if (str.indexOf('十') === -1) {
    let out = '';
    for (const ch of str) out += (KANJI_DIGIT_MAP[ch] !== undefined ? KANJI_DIGIT_MAP[ch] : ch);
    return out;
  }
  const parts = str.split('十');
  if (parts.length !== 2) return str; // "十"が複数回登場するなど想定外のパターンはそのまま
  const [before, after] = parts;
  const tens = before === '' ? 1 : KANJI_DIGIT_MAP[before];
  const ones = after === '' ? 0 : KANJI_DIGIT_MAP[after];
  if (tens === undefined || ones === undefined) return str;
  return String(tens * 10 + ones);
}
// 「丁目/番地/番/号」の直前にある漢数字だけを変換対象にする(地名自体に含まれる漢数字は変換しない)。
// 例: 「六本木」「三田」「二子玉川」等は数字ではなく地名の一部なので素通りさせる。
function kanjiNumeralsToArabic(s) {
  return s.replace(/[〇○零一二三四五六七八九十]+(?=丁目|番地|番|号)/g, kanjiNumeralToArabic);
}

// 住所でよく省略される地名区分の接頭辞(大字・小字・字)は、片方にだけ付いていると不一致の原因になるため無視する。
// 「大字」「小字」を先に除去してから残った単独の「字」を除去する(「小字」の「字」を二重に消さないための順序)。
function stripAddressDivisionPrefixes(s) {
  return s.replace(/大字|小字/g, '').replace(/字/g, '');
}

// 号までの番地の数字列より後ろに残るテキスト(建物名)は、フロア表記(●階/●F/B●/地下●階)を含まない場合に限り無視する。
// フロア表記が含まれる場合は何もしない(同一建物内の別テナント、例:異なる階の同名店舗を誤って同一視しないため)。
const FLOOR_RE = /(\d+\s*(階|f)|b\d+|地下\d*階?)/i;
function stripBuildingNameIfNoFloor(s) {
  // 住所内で最初に現れる数字(丁目・番地・号)のチェーンまでを住所本体、それ以降を建物名候補とする。
  // (末尾の数字を基準にすると「サンシャインビル3F」のようにフロア表記自体に数字がある場合を取り違えるため)
  const m = s.match(/^(.*?\d[\d-]*)(.{1,50})?$/);
  if (!m) return s;
  const [, base, suffix] = m;
  if (!suffix) return s; // 番地チェーンの後に何も残らない場合は何もしない
  if (FLOOR_RE.test(suffix)) return s;
  return base;
}

// 住所比較用: 都道府県より前(国名/郵便番号)を除去し、丁目・番地・番・号や各種ハイフン類(全角/半角/長音)を単一の"-"に統一する
// (Googleは郵便番号が入っていないケースがあるため、郵便番号自体は「あれば無視する」形にする)
function normalizeAddressForMatch(s) {
  if (!s) return '';
  let t = canonicalizeVariantKanji(s.normalize('NFKC')); // 髙→高 等の異体字ゆれを吸収
  t = unifyKaNotation(t); // 「ヶ/ケ/が」の表記ゆれを吸収
  t = stripBeforePrefecture(t);
  t = stripCountySegment(t); // 「郡」区分の省略ゆれを吸収
  t = kanjiNumeralsToArabic(t); // 「三丁目」= 「3丁目」のように漢数字表記ゆれを吸収
  t = stripAddressDivisionPrefixes(t); // 「大字」「小字」「字」の有無による表記ゆれを吸収
  t = t.replace(/〒?\d{3}-?\d{4}/g, '');           // 郵便番号(先頭で拾いきれなかった場合の保険)
  t = t.replace(/日本[、,]?/g, '').replace(/,?\s*Japan/gi, '');
  t = t.replace(/[‐‑‒–—―−ー\-]/g, '-'); // 各種ハイフン/長音記号→"-"
  t = t.replace(/(\d)の(?=\d)/g, '$1-'); // 「2の3」のような「の」区切りを"-"に統一
  t = t.replace(/丁目/g, '-').replace(/番地/g, '-').replace(/番/g, '-').replace(/号/g, '');
  t = stripBuildingNameIfNoFloor(t); // フロア表記がなければ末尾の建物名を無視
  t = t.replace(/[\s,、]+/g, '');
  t = t.replace(/-+/g, '-');
  return t.toLowerCase();
}

// ノイズ(全角半角/空白/記号/丁目番地のハイフン表記ゆれ等)は正規化で吸収した上で、完全一致のみを一致とみなす
// (containment不可: 例「入谷駅」に対して「セブンイレブン入谷駅前店」はマッチさせない)
// treatAsAddressの値に関わらず、まず記号ゆれに強いname用の厳密一致(normalizeNameForMatch)を必ず試す
// (例:「セブン-イレブン」⇔「セブンイレブン」はどちらの型でも一致してほしいため)。
// それでも一致しない場合に限り、address型クエリでは住所の断片(Googleは短く/市区町村名すら省略、
// Mapboxはより完全)として返ってくることがあるため、住所用の正規化+後方一致(短い方が長い方の末尾と一致)を許容する。
// (番地の数字列だけを見るフォールバックは廃止: 町名が違っても番地番号が偶然一致すると誤マッチするため)
function namesMatch(a, b, treatAsAddress) {
  const na = normalizeNameForMatch(a), nb = normalizeNameForMatch(b);
  if (na && nb && na === nb) return true;
  if (!treatAsAddress) return false;
  const aa = normalizeAddressForMatch(a), ab = normalizeAddressForMatch(b);
  if (!aa || !ab) return false;
  return aa === ab || aa.endsWith(ab) || ab.endsWith(aa);
}

// 2点間の実距離(haversine)がCOORD_MATCH_THRESHOLD_KM以内かどうかで「同じ場所」を判定する。
// (住所文字列は「号」の有無などプロバイダ間のデータ詳細度の差で不一致になりやすいため、
// address欄の一致判定は文字列比較ではなく座標ベースにしている。
// 以前は小数点3桁=約100m格子への丸め一致だったが、格子境界をまたぐと近接点でも不一致になる問題があったため、
// 実距離ベース(50m以内)に変更)
const COORD_MATCH_THRESHOLD_KM = 0.05;
function coordinatesMatch(a, b) {
  if (!a || !b) return false;
  const { lat: latA, lng: lngA } = a;
  const { lat: latB, lng: lngB } = b;
  if (latA == null || lngA == null || latB == null || lngB == null) return false;
  if (!Number.isFinite(latA) || !Number.isFinite(lngA) || !Number.isFinite(latB) || !Number.isFinite(lngB)) return false;
  return haversineDistanceKm(latA, lngA, latB, lngB) <= COORD_MATCH_THRESHOLD_KM;
}

// listA の各要素について、listB内のどれかとname/位置が一致するかを判定し 'none'|'name'|'address'|'both' を返す
// ('address'の判定は、まず住所文字列同士を正規化(normalizeAddressForMatch)して比較し、それで一致しなければ
// 緯度経度(haversine距離、COORD_MATCH_THRESHOLD_KM以内)にフォールバックする。プロバイダ間で住所の詳細度が
// 違う(号の有無等)ケースは正規化で吸収し、それでも吸収できない表記差は座標側で救済する二段構え)
// 'both'は同一候補がname・位置両方を満たした時だけ成立させる(別々の候補がそれぞれ片方だけ満たした場合を
// 合成して完全一致扱いにすると、無関係な候補同士の組み合わせで誤って「完全一致」になってしまうため)。
function addressOrCoordMatch(addressA, coordA, addressB, coordB) {
  if (namesMatch(addressA, addressB, true)) return true; // 住所文字列の正規化+接尾一致を優先
  return coordinatesMatch(coordA, coordB); // ダメなら座標の近似一致にフォールバック
}
function computeMatchCategories(listA, getNameA, getCoordA, getAddressA, listB, getNameB, getCoordB, getAddressB, treatNameAsAddress) {
  return listA.map(item => {
    const nameA = getNameA(item), coordA = getCoordA(item), addressA = getAddressA(item);
    let nameHit = false, addrHit = false, bothHit = false;
    for (const other of listB) {
      if (other === item) continue; // 万一listAとlistBが同一参照を含んでいても自己参照させない
      const nHit = namesMatch(nameA, getNameB(other), treatNameAsAddress);
      const aHit = addressOrCoordMatch(addressA, coordA, getAddressB(other), getCoordB(other));
      if (nHit && aHit) { bothHit = true; break; } // 同一候補が両方満たした時点で確定
      if (nHit) nameHit = true;
      if (aHit) addrHit = true;
    }
    return bothHit ? 'both' : nameHit ? 'name' : addrHit ? 'address' : 'none';
  });
}

// AI診断専用: nameは一切見ず、addressOrCoordMatch(住所正規化 or 座標50m近似)だけで
// listAの各要素が「listB内に位置的に近い候補があるか」を判定する。'address'(近い候補あり) | 'none'(なし)。
// (name一致の判断はAI自身の意味理解に完全に委ねる方針のため、機械的なname一致は計算しない。
//  AIには元々生のnameが渡っており、正規化+完全一致しかできない機械的判定より
//  AIの方が表記ゆれ・同音異字等を扱える=判定として優れているため、渡す意味が薄いという判断)
function computeAddressMatchOnly(listA, getCoordA, getAddressA, listB, getCoordB, getAddressB) {
  return listA.map(item => {
    const addressA = getAddressA(item), coordA = getCoordA(item);
    const hit = listB.some(other => other !== item && addressOrCoordMatch(addressA, coordA, getAddressB(other), getCoordB(other)));
    return hit ? 'address' : 'none';
  });
}

// クリックされたnameチップに対応する結果リストの項目までスクロールし、一瞬ハイライトして知らせる
function focusResultItem(side, index) {
  const list = document.getElementById(`${side}-results`);
  if (!list) return;
  const item = list.querySelectorAll('.result-item')[index];
  if (!item) return;
  item.scrollIntoView({ block: 'center', behavior: 'smooth' });
  item.click();
  item.classList.add('result-item-flash');
  setTimeout(() => item.classList.remove('result-item-flash'), 1000);
}

function renderNameStrip(elId, list, nameOf, categories, side, proximityInfoOf) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!list || !list.length) { el.innerHTML = ''; return; }
  const MATCH_LABEL = { both: '完全一致', name: '一致（nameのみ）', address: '一致（位置が近似）', none: '一致なし' };
  el.innerHTML = list.map((item, i) => {
    const cat = categories[i];
    const cls = cat === 'both' ? 'match-both' : cat === 'name' ? 'match-name' : cat === 'address' ? 'match-address' : '';
    const { badge, tooltip } = proximityInfoOf ? proximityInfoOf(item) : { badge: '', tooltip: '' };
    const tooltipText = tooltip ? `${MATCH_LABEL[cat]} / ${tooltip}` : MATCH_LABEL[cat];
    return `<span class="name-chip ${cls}" data-index="${i}" data-tooltip="${esc(tooltipText)}">${badge}${esc(nameOf(item) ?? '(no name)')}</span>`;
  }).join('');
  el.querySelectorAll('.name-chip').forEach(chip => {
    chip.addEventListener('click', () => focusResultItem(side, parseInt(chip.dataset.index, 10)));
  });
}

// GoogleとMapboxの高さの高い方に両ストリップを揃える
function syncNameStripHeights() {
  const g = document.getElementById('google-name-strip');
  const m = document.getElementById('mapbox-name-strip');
  if (!g || !m) return;
  g.style.height = ''; m.style.height = '';
  const h = Math.max(g.scrollHeight, m.scrollHeight);
  if (h > 0) { g.style.height = h + 'px'; m.style.height = h + 'px'; }
}

// nameフィールドを住所として扱う(住所用の正規化+後方一致を許可する)かどうか。
// CSVバッチ実行中でquery_type列がある場合は、その行がAI/手動分類で「address」とされている時だけtrueにする。
// 検索ボックス単体利用やquery_type列が無い場合は、POI名クエリの方が多いと想定してfalse(name型)をデフォルトにする
// (以前はtrueがデフォルトだったが、それだとnamesMatch()が常に住所用の緩い正規化に流れてしまい、
//  記号違い程度の表記ゆれ(例:「セブン-イレブン」⇔「セブンイレブン」)がname用の厳密正規化で拾えなくなるバグがあった)
function isCurrentQueryAddressType() {
  if (currentCsvFileId && csvHasQueryType && csvIndex >= 0 && csvRawRows[csvIndex]) {
    const val = String(csvRawRows[csvIndex][csvQueryTypeColumn] ?? '').trim().toLowerCase();
    return val === 'address';
  }
  return false;
}

function updateNameStrips() {
  const gList = Array.isArray(googleRawResults) ? googleRawResults : [];
  const mList = Array.isArray(mapboxRawResults) ? mapboxRawResults : [];
  const gName = r => r.name, gCoord = r => ({ lat: r.geometry?.location?.lat, lng: r.geometry?.location?.lng }), gAddr = r => r.formatted_address;
  const mName = r => r.name, mCoord = r => ({ lat: r.coordinates?.latitude, lng: r.coordinates?.longitude }), mAddr = r => r.full_address;
  const treatNameAsAddress = isCurrentQueryAddressType();

  const gCats = computeMatchCategories(gList, gName, gCoord, gAddr, mList, mName, mCoord, mAddr, treatNameAsAddress);
  const mCats = computeMatchCategories(mList, mName, mCoord, mAddr, gList, gName, gCoord, gAddr, treatNameAsAddress);

  const gCenter = state.googleParams.location;
  const mCenter = state.mapboxParams.proximity;
  const gProximityInfo = r => nearProximityInfo(gCenter?.lat, gCenter?.lng, r.geometry?.location?.lat, r.geometry?.location?.lng);
  const mProximityInfo = r => nearProximityInfo(mCenter?.lat, mCenter?.lng, r.coordinates?.latitude, r.coordinates?.longitude);

  renderNameStrip('google-name-strip', gList, gName, gCats, 'google', gProximityInfo);
  renderNameStrip('mapbox-name-strip', mList, mName, mCats, 'mapbox', mProximityInfo);
  syncNameStripHeights();
}

function setLoading(side) {
  document.getElementById(`${side}-results`).innerHTML = `<p class="status-msg">Searching...</p>`;
  document.getElementById(`${side}-count`).textContent = '';
  const strip = document.getElementById(`${side}-name-strip`);
  if (strip) { strip.innerHTML = ''; strip.style.height = ''; }
}

// ============================================================
// QUERY DISPLAY
// ============================================================
function buildGoogleQueryDisplay(query) {
  if (googleApiMode === 'new') {
    const body = buildGoogleNewBody(query);
    return `POST https://places.googleapis.com/v1/places:searchText\n\n${JSON.stringify(body, null, 2)}`;
  }

  const params = new URLSearchParams({ query });
  for (const [k, v] of Object.entries(state.googleParams)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;

    if (k === 'location' && v?.lat != null && v?.lng != null) {
      params.set('location', `${v.lat},${v.lng}`);
    } else if (k === 'types' && Array.isArray(v)) {
      params.set('type', v[0]);
    } else if (typeof v === 'object') {
      params.set(k, JSON.stringify(v));
    } else {
      params.set(k, String(v));
    }
  }
  params.set('key', '****');
  return `GET https://maps.googleapis.com/maps/api/place/textsearch/json?${params.toString()}`;
}

function buildMapboxQueryDisplay(query) {
  return `GET https://api.mapbox.com/search/searchbox/v1/forward?${buildMapboxParams(query, false)}`;
}

// ============================================================
// SEARCH
// ============================================================
// CSV行ジャンプ等でdoSearch()が完了を待たずに連続実行された場合、ネットワーク応答の到着順は保証されないため、
// 古い呼び出しの結果が新しい呼び出しの結果を後から上書きしてしまうことがある(表示中の行と実際の結果/feedbackContextが
// ズレるレースコンディション)。呼び出しごとに世代番号を発行し、await後に「自分が最新の呼び出しか」を確認してから
// 画面反映することで、古い結果は無視して破棄する
let searchGeneration = 0;
async function doSearch() {
  const query = document.getElementById('query-input').value.trim();
  if (!query) return;
  const searchGen = ++searchGeneration;
  state.query = query;
  pushQueryHistory(query);
  queryHistoryPos = -1;

  // bboxをFormで手動編集した場合は、ここでの位置・半径からの自動再計算をスキップして手動値を保持する
  if (!mapboxBboxManual && Array.isArray(state.mapboxParams.bbox) && state.mapboxParams.bbox.length === 4) {
    const { lat, lng } = getCurrentLocation(), radius = getCurrentRadius(), offset = radius / 111000;
    state.mapboxParams.bbox = [+(lng-offset).toFixed(6), +(lat-offset).toFixed(6), +(lng+offset).toFixed(6), +(lat+offset).toFixed(6)];
    refreshParamUI('mapbox');
  }

  writeToURL();

  const { lat, lng } = getCurrentLocation();
  if (googleMap) googleMap.setCenter({ lat, lng });
  if (mapboxMap) mapboxMap.jumpTo({ center: [lng, lat] });

  const googleDisplay = buildGoogleQueryDisplay(query), mapboxDisplay = buildMapboxQueryDisplay(query);
  pendingGoogleUrl = googleDisplay; pendingMapboxUrl = mapboxDisplay;
  queryEditor?.setValue(googleDisplay); queryMapboxEditor?.setValue(mapboxDisplay);

  const label = document.getElementById('query-google-label');
  if (label) label.textContent = `Google Places API (${googleApiMode === 'new' ? 'New' : 'Legacy'})`;
  highlightedGoogleMarker = null;
  highlightedMapboxMarker = null;
  setLoading('google'); setLoading('mapbox');

  const [gRes, mRes] = await Promise.allSettled([searchGoogle(query), searchMapbox(query)]);

  // 待っている間に、より新しいdoSearch()呼び出しが発行されていたら、この結果は古いので画面には一切反映しない
  if (searchGen !== searchGeneration) return;

  if (gRes.status === 'fulfilled') {
    googleRawResults = gRes.value.error ? [] : gRes.value;
    renderGoogleResults(gRes.value);
    if (!gRes.value.error) plotGoogleMarkers(gRes.value);
  } else { googleRawResults = []; renderGoogleResults({ error: String(gRes.reason) }); }

  if (mRes.status === 'fulfilled') {
    mapboxRawResults = mRes.value.error ? [] : mRes.value;
    renderMapboxResults(mRes.value);
    if (!mRes.value.error) plotMapboxMarkers(mRes.value);
  } else { mapboxRawResults = []; renderMapboxResults({ error: String(mRes.reason) }); }

  updateNameStrips();
  fitResultsBounds();
  drawRangeOverlays();
  updateResultEditors();
  persistLastResult();

  // このクエリに対するフィードバック待ち状態にする(CSV読込中ならその行に紐づける)
  feedbackContext = {
    fileId:    currentCsvFileId || null,
    fileName:  currentCsvFileId ? currentCsvFileName : null,
    rowIndex:  currentCsvFileId ? csvIndex : null,
    query,
    roundId: newRoundId(),
  };
  feedbackPanelMode = 'start';
  aiDiagState = 'idle'; aiDiagProposal = null;
  renderFeedbackPanel();
}

// ============================================================
// CSV
// ============================================================
function parseCSVText(text) {
  text = text.replace(/^﻿/, ''); // BOM除去
  const rows = [];
  let row = [], cur = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\r') { /* skip CR */ }
      else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += ch;
    }
  }
  if (cur !== '' || row.length > 0) { row.push(cur); rows.push(row); }
  return rows;
}

// 固定カラム名を前提とせず、ヘッダー行 + 生データ行(dict配列)を返す
function parseCSV(text) {
  const rows = parseCSVText(text);
  if (rows.length < 2) return null;
  const headers = rows[0].map(h => h.trim());
  const dataRows = rows.slice(1)
    .filter(cols => cols.some(c => c !== undefined && c !== ''))
    .map(cols => headers.reduce((acc, h, i) => { acc[h] = (cols[i] ?? '').trim(); return acc; }, {}));
  return { headers, rows: dataRows };
}

const CSV_ROW_H = 28;
let csvHandlersAttached = false;
const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// Mapbox/Googleのどちらにも役割が割り当てられていない列は、メイン画面のプレビュー表からは隠す
function getVisibleCsvHeaders() {
  const headers = csvMapping
    ? csvHeaders.filter(h => {
        const col = csvMapping.columns.find(c => c.header === h);
        return col && (col.mapboxRole !== '(none)' || col.googleRole !== '(none)');
      })
    : csvHeaders;
  // query_type/query_count列は専用列(#の右隣)で表示するため、通常の列一覧からは除外する
  return headers.filter(h => h !== csvQueryTypeColumn && h !== csvQueryCountColumn);
}

// ---- フィルタリング状態 ----
let csvFilterResult = 'all'; // 'all' | 'no_issue' | 'problem' | 'out_of_scope' | 'untested'
let csvFilterReason = 'all'; // 'all' or 具体的な理由ラベル(dataIssue値/searchEngineIssues項目/out of scope reason)
let csvFilterText   = '';    // フリーワード検索

// CSV行のquery_count値を数値化(空/非数値は0扱い)
function getQueryCountValue(i) {
  const v = parseFloat(csvRawRows[i][csvQueryCountColumn]);
  return isNaN(v) ? 0 : v;
}

function getFilteredCsvIndices() {
  const needle = csvFilterText.trim().toLowerCase();
  const indices = csvRawRows.map((_, i) => i).filter(i => {
    const fb = getRowFeedback(i);
    if (csvFilterResult === 'no_issue'     && (!fb || fb.state !== 'no_issue'))     return false;
    if (csvFilterResult === 'problem'      && (!fb || fb.state !== 'problem'))      return false;
    if (csvFilterResult === 'out_of_scope' && (!fb || fb.state !== 'out_of_scope')) return false;
    if (csvFilterResult === 'untested' && fb) return false;
    if (csvFilterReason !== 'all') {
      const matches = fb && (
        (fb.state === 'problem' && fb.tickets.some(t => t.dataIssue === csvFilterReason || (t.searchEngineIssues || []).includes(csvFilterReason))) ||
        (fb.state === 'out_of_scope' && fb.reason === csvFilterReason)
      );
      if (!matches) return false;
    }
    if (csvHasQueryType && csvQueryTypeSelected.size < csvQueryTypeValues.length) {
      if (!csvQueryTypeSelected.has(csvRawRows[i][csvQueryTypeColumn] || '')) return false;
    }
    if (csvHasQueryCount && csvQueryCountMin != null) {
      if (getQueryCountValue(i) < csvQueryCountMin) return false;
    }
    if (needle) {
      const hay = Object.values(csvRawRows[i]).join(' ').toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  // ソート: #列クリック('index')かquery_countモーダルでの適用('querycount')のうち、直近に確定した方だけが有効
  if (csvSortField === 'querycount' && csvHasQueryCount) {
    indices.sort((a, b) => csvSortDir === 'asc'
      ? getQueryCountValue(a) - getQueryCountValue(b)
      : getQueryCountValue(b) - getQueryCountValue(a));
  } else if (csvSortField === 'index' && csvSortDir === 'desc') {
    indices.reverse();
  }
  return indices;
}

function populateCsvFilterReasonOptions() {
  const sel = document.getElementById('csv-filter-reason');
  const current = sel.value;
  const dataGroup = `<optgroup label="Data">${DATA_ISSUES.map(x => `<option value="${esc(x.value)}">${esc(x.label)}</option>`).join('')}</optgroup>`;
  const seGroups = SEARCH_ENGINE_ISSUE_GROUPS.map(g =>
    `<optgroup label="${esc(g.category)}">${g.items.map(label => `<option value="${esc(label)}">${esc(label)}</option>`).join('')}</optgroup>`
  ).join('');
  const outOfScopeGroup = `<optgroup label="Out of scope">${UNCLEAR_REASONS.map(label => `<option value="${esc(label)}">${esc(label)}</option>`).join('')}</optgroup>`;
  sel.innerHTML = '<option value="all">All</option>' + dataGroup + seGroups + outOfScopeGroup;
  sel.value = current || 'all';
}

function renderCSVTable() {
  const body  = document.getElementById('csv-body');
  const tbody = document.getElementById('csv-tbody');
  const theadRow = document.getElementById('csv-thead-row');
  const visibleHeaders = getVisibleCsvHeaders();

  const indexSortIcon = csvSortField === 'index' ? (csvSortDir === 'asc' ? ' ▲' : ' ▼') : '';
  const indexTh = `<th id="csv-th-index" style="cursor:pointer;user-select:none;" title="Click to sort by row order">#${indexSortIcon}</th>`;

  const queryTypeTh = csvHasQueryType
    ? `<th id="csv-th-querytype" style="cursor:pointer;user-select:none;" title="Click to filter by ${esc(csvQueryTypeColumn)}">${esc(csvQueryTypeColumn)} ${csvQueryTypeSelected.size < csvQueryTypeValues.length ? `🔽(${csvQueryTypeSelected.size}/${csvQueryTypeValues.length})` : '🔽'}</th>`
    : '';
  const queryCountSortIcon = csvSortField === 'querycount' ? (csvSortDir === 'asc' ? ' ▲' : ' ▼') : '';
  const queryCountTh = csvHasQueryCount
    ? `<th id="csv-th-querycount" style="cursor:pointer;user-select:none;" title="Click to sort/filter by ${esc(csvQueryCountColumn)}">${esc(csvQueryCountColumn)}${queryCountSortIcon}${csvQueryCountMin != null ? ` 🔽(≥${csvQueryCountMin})` : ''}</th>`
    : '';
  theadRow.innerHTML = indexTh + queryTypeTh + queryCountTh + '<th>結果</th><th>理由</th>' + visibleHeaders.map(h => `<th>${esc(h)}</th>`).join('');

  document.getElementById('csv-progress').textContent = csvRawRows.length > 0
    ? `${csvIndex >= 0 ? csvIndex + 1 : '-'} / ${csvRawRows.length}` : '';

  if (!csvHandlersAttached) {
    body.addEventListener('scroll', renderCSVViewport);
    tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-idx]');
      if (tr) jumpToCSVRow(parseInt(tr.dataset.idx));
    });
    theadRow.addEventListener('click', (e) => {
      if (e.target.closest('#csv-th-index')) {
        // #列クリック: 昇順/降順をトグル。直近のクリックが優先されるので、query_countソートを上書きする
        csvSortDir = (csvSortField === 'index' && csvSortDir === 'asc') ? 'desc' : 'asc';
        csvSortField = 'index';
        document.getElementById('csv-body').scrollTop = 0;
        renderCSVTable();
        return;
      }
      if (e.target.closest('#csv-th-querytype')) { openQueryTypeFilterModal(); return; }
      if (e.target.closest('#csv-th-querycount')) { openQueryCountFilterModal(); return; }
    });
    csvHandlersAttached = true;
  }

  renderCSVViewport();
}

function renderCSVViewport() {
  const body  = document.getElementById('csv-body');
  const tbody = document.getElementById('csv-tbody');
  const visibleHeaders = getVisibleCsvHeaders();
  const colCount = visibleHeaders.length + 3 + (csvHasQueryType ? 1 : 0) + (csvHasQueryCount ? 1 : 0); // # + 結果 + 理由 (+ query_type) (+ query_count)

  const indices = getFilteredCsvIndices();
  const total = indices.length;
  const countEl = document.getElementById('csv-filter-count');
  if (countEl) countEl.textContent = csvRawRows.length ? `${total} / ${csvRawRows.length}件表示` : '';
  if (total === 0) { tbody.innerHTML = ''; return; }

  const viewH = body.clientHeight || 180;
  // フィルタで行数が減った直後は、フィルタ前のスクロール位置(scrollTop)が新しいtotalを超えている場合がある。
  // クランプしないとfirst > lastになり、件数は表示されるのに行が1件も描画されないバグになる。
  const first = Math.min(Math.max(0, Math.floor(body.scrollTop / CSV_ROW_H) - 5), total - 1);
  const last  = Math.min(total - 1, first + Math.ceil(viewH / CSV_ROW_H) + 10);

  const padTop    = first * CSV_ROW_H;
  const padBottom = (total - 1 - last) * CSV_ROW_H;

  let html = '';
  if (padTop > 0)
    html += `<tr><td colspan="${colCount}" style="height:${padTop}px;padding:0;border:none;"></td></tr>`;

  for (let k = first; k <= last; k++) {
    const i = indices[k];
    const r = csvRawRows[i];
    const fb = getRowFeedback(i);
    const resultIcon = rowStatusBadge(fb);
    const reasonText = fb
      ? (fb.state === 'problem'
          ? esc(fb.tickets.map(ticketSummaryLabel).join(' / '))
          : esc(fb.reason || ''))
      : '';
    const queryTypeTd = csvHasQueryType ? `<td>${esc(r[csvQueryTypeColumn])}</td>` : '';
    const queryCountTd = csvHasQueryCount ? `<td>${esc(r[csvQueryCountColumn])}</td>` : '';
    html += `
      <tr class="${i === csvIndex ? 'active' : ''} ${fb ? 'csv-tested' : ''}" data-idx="${i}">
        <td>${i + 1}</td>
        ${queryTypeTd}
        ${queryCountTd}
        <td>${resultIcon}</td>
        <td>${reasonText}</td>
        ${visibleHeaders.map(h => `<td>${esc(r[h])}</td>`).join('')}
      </tr>`;
  }

  if (padBottom > 0)
    html += `<tr><td colspan="${colCount}" style="height:${padBottom}px;padding:0;border:none;"></td></tr>`;

  tbody.innerHTML = html;
}

// ---- query_type フィルタモーダル ----
let qtFilterHandlersAttached = false;

function openQueryTypeFilterModal() {
  csvQueryTypePending = new Set(csvQueryTypeSelected); // 編集用に複製(Cancel時は破棄)
  document.getElementById('querytype-filter-title').textContent = `🔽 Filter by ${csvQueryTypeColumn}`;
  renderQueryTypeFilterModal();
  document.getElementById('querytype-filter-dialog').classList.add('open');

  if (!qtFilterHandlersAttached) {
    document.getElementById('querytype-filter-body').addEventListener('change', (e) => {
      const cb = e.target.closest('.qt-checkbox');
      if (!cb) return;
      const v = csvQueryTypeValues[parseInt(cb.dataset.idx)];
      if (cb.checked) csvQueryTypePending.add(v); else csvQueryTypePending.delete(v);
    });
    document.getElementById('qt-select-all-btn').addEventListener('click', () => {
      csvQueryTypePending = new Set(csvQueryTypeValues);
      renderQueryTypeFilterModal();
    });
    document.getElementById('qt-select-none-btn').addEventListener('click', () => {
      csvQueryTypePending = new Set();
      renderQueryTypeFilterModal();
    });
    document.getElementById('qt-apply-btn').addEventListener('click', () => {
      csvQueryTypeSelected = new Set(csvQueryTypePending);
      document.getElementById('querytype-filter-dialog').classList.remove('open');
      document.getElementById('csv-body').scrollTop = 0;
      renderCSVTable(); // ヘッダーの選択件数表示も更新
    });
    qtFilterHandlersAttached = true;
  }
}

function renderQueryTypeFilterModal() {
  const body = document.getElementById('querytype-filter-body');
  body.innerHTML = csvQueryTypeValues.map((v, idx) => {
    const label = v === '' ? '(empty)' : esc(v);
    const checked = csvQueryTypePending.has(v) ? 'checked' : '';
    return `<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#ccc;cursor:pointer;padding:3px 0;">
      <input type="checkbox" class="qt-checkbox" data-idx="${idx}" ${checked}> ${label}
    </label>`;
  }).join('');
}

// ---- query_count フィルタ/ソートモーダル ----
let qcFilterHandlersAttached = false;
let csvSortDirPending = 'asc'; // モーダル編集中の一時的な並び順(Applyで確定)

// 0は「ありえない」ので出さず、1 / 2-10 / 11-50 / 51+ の固定バケットで分布件数を集計する(ユーザーがnを決める参考用)
function computeQueryCountDistribution() {
  const buckets = [
    { label: '1',     test: v => v === 1 },
    { label: '2–10',  test: v => v >= 2 && v <= 10 },
    { label: '11–50', test: v => v >= 11 && v <= 50 },
    { label: '51+',   test: v => v >= 51 },
  ];
  const counts = buckets.map(() => 0);
  for (let i = 0; i < csvRawRows.length; i++) {
    const v = getQueryCountValue(i);
    buckets.forEach((b, bi) => { if (b.test(v)) counts[bi]++; });
  }
  return buckets.map((b, bi) => ({ label: b.label, count: counts[bi] }));
}

function renderQueryCountSortButtons() {
  document.querySelectorAll('.qc-sort-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.dir === csvSortDirPending);
  });
}

function renderQueryCountDistribution() {
  const tbody = document.getElementById('qc-distribution-tbody');
  tbody.innerHTML = computeQueryCountDistribution().map(b => `
    <tr><td style="padding:2px 6px 2px 0;">${b.label}</td><td style="padding:2px 0;text-align:right;color:#888;">${b.count} rows</td></tr>
  `).join('');
}

function openQueryCountFilterModal() {
  csvSortDirPending = (csvSortField === 'querycount') ? csvSortDir : 'asc';
  csvQueryCountMinPending = csvQueryCountMin;
  document.getElementById('querycount-filter-title').textContent = `🔢 Filter by ${csvQueryCountColumn}`;
  document.getElementById('qc-min-input').value = csvQueryCountMinPending != null ? csvQueryCountMinPending : '';
  renderQueryCountSortButtons();
  renderQueryCountDistribution();
  document.getElementById('querycount-filter-dialog').classList.add('open');

  if (!qcFilterHandlersAttached) {
    document.querySelectorAll('.qc-sort-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        csvSortDirPending = btn.dataset.dir;
        renderQueryCountSortButtons();
      });
    });
    document.getElementById('qc-min-input').addEventListener('input', (e) => {
      const val = e.target.value.trim();
      csvQueryCountMinPending = val === '' ? null : Math.max(0, parseFloat(val) || 0);
    });
    document.getElementById('qc-apply-btn').addEventListener('click', () => {
      csvQueryCountMin = csvQueryCountMinPending;
      csvSortField = 'querycount'; // #列ソートより優先(直近に確定した方が優先されるルール)
      csvSortDir = csvSortDirPending;
      document.getElementById('querycount-filter-dialog').classList.remove('open');
      document.getElementById('csv-body').scrollTop = 0;
      renderCSVTable();
    });
    qcFilterHandlersAttached = true;
  }
}

function scrollCSVToIndex(idx) {
  const body  = document.getElementById('csv-body');
  const viewH = body.clientHeight || 180;
  const pos   = getFilteredCsvIndices().indexOf(idx);
  if (pos === -1) { renderCSVViewport(); return; } // フィルタで非表示中の行(スクロールは動かさない)
  const top   = pos * CSV_ROW_H;
  if (top < body.scrollTop) {
    body.scrollTop = top;
  } else if (top + CSV_ROW_H > body.scrollTop + viewH) {
    body.scrollTop = top - viewH + CSV_ROW_H;
  }
  renderCSVViewport();
}

// ---- 列ロール定義 ----
// 緯度・経度が「1列にカンマ区切りで結合」されているケースと「2列に分割」されているケースの両方に対応
const MAPBOX_ROLES = ['(none)','q','proximity','proximity(lat)','proximity(lng)','bbox','bbox(lat)','bbox(lng)','types','poi_category','poi_category_exclusion','limit','language','country','near','navigation_profile'];
const GOOGLE_ROLES  = ['(none)','query','location','location(lat)','location(lng)','radius','type','language','region'];

const LS_CSV_MAPPING = 'apc_csv_mapping_cache';
function loadCsvMappingCache() { try { return JSON.parse(localStorage.getItem(LS_CSV_MAPPING) || '{}'); } catch { return {}; } }
function saveCsvMappingCache(cache) { localStorage.setItem(LS_CSV_MAPPING, JSON.stringify(cache)); }

function arraysEqual(a, b) { return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v,i) => v === b[i]); }

const CSV_MAPPING_SYSTEM_PROMPT = `あなたはCSVファイルの列名を、2つの位置情報検索APIのパラメータにマッピングするアシスタントです。
出力は必ず次の形式のJSON配列のみを返してください。説明文やコードブロック記号は一切含めないでください。
[{"header":"<CSV列名>","mapboxRole":"<ロール>","googleRole":"<ロール>"}, ...]

Mapboxロール候補: q, proximity, proximity(lat), proximity(lng), bbox, bbox(lat), bbox(lng), types, poi_category, poi_category_exclusion, limit, language, country, near, navigation_profile, (none)
Googleロール候補: query, location, location(lat), location(lng), radius, type, language, region, (none)

ルール:
- 各CSV列について、上記候補から最も適切なロールを1つずつ選んでください。該当がなければ "(none)" にしてください。
- 検索クエリ文字列らしい列(例: query, query_text, keyword, 検索語, 店舗名など)は mapboxRole="q", googleRole="query" にしてください。
- 緯度・経度は「1列にまとまっているか」「緯度・経度が別々の列に分かれているか」を必ず判定してください。
  - 1列に "経度,緯度" のようにカンマ区切りで両方入っている列(例: proximity, lnglat, coordinates など)は mapboxRole="proximity", googleRole="location" にしてください(Googleは "緯度,経度" 順として扱われます)。
  - 緯度だけの列(latitude, lat など)は mapboxRole="proximity(lat)", googleRole="location(lat)" にしてください。
  - 経度だけの列(longitude, lng, lon など)は mapboxRole="proximity(lng)", googleRole="location(lng)" にしてください。
  - 検索範囲(bounding box)を表す列がある場合も同様に、1列にまとまっていれば "bbox"、中心点の緯度・経度が別列なら "bbox(lat)"/"bbox(lng)" にしてください(通常は使いません。座標列はproximity/locationに割り当てるのが基本です)。
- 判断に迷う列(reason, comment, memo など検索に無関係なメタ情報)は両方 "(none)" にしてください。`;

async function analyzeCsvColumns(headers, sampleRows) {
  const userMsg = `列名: ${JSON.stringify(headers)}\nサンプル行:\n${sampleRows.map(r => JSON.stringify(r)).join('\n')}`;
  const modelId = AI_DIAG_MODEL_IDS[csvScanModel] || AI_DIAG_MODEL_IDS.haiku;
  const text = await callClaude(CSV_MAPPING_SYSTEM_PROMPT, [{ role: 'user', content: userMsg }], 800, modelId);
  const match = text.match(/\[[\s\S]*\]/);
  return JSON.parse(match ? match[0] : text);
}

function setCsvMappingStatus(text) { document.getElementById('csv-mapping-status').textContent = text; }

// 実際のロール選択UI(select×2)を描画
function renderCsvMappingRows(headers, columns) {
  const tbody = document.getElementById('csv-mapping-tbody');
  tbody.innerHTML = headers.map(h => {
    const col = columns.find(c => c.header === h) || { mapboxRole: '(none)', googleRole: '(none)' };
    return `
      <tr data-header="${esc(h)}">
        <td>${esc(h)}</td>
        <td><select class="csv-mb-role">${MAPBOX_ROLES.map(r => `<option value="${r}" ${r === col.mapboxRole ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
        <td><select class="csv-gg-role">${GOOGLE_ROLES.map(r => `<option value="${r}" ${r === col.googleRole ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
      </tr>`;
  }).join('');
}

// AI解析中は「analyzing...」のみを表示し、(none)判定と誤読されないようにする
function renderCsvMappingRowsAnalyzing(headers) {
  const tbody = document.getElementById('csv-mapping-tbody');
  tbody.innerHTML = headers.map(h => `
    <tr data-header="${esc(h)}">
      <td>${esc(h)}</td>
      <td><select class="csv-mb-role" disabled><option>analyzing...</option></select></td>
      <td><select class="csv-gg-role" disabled><option>analyzing...</option></select></td>
    </tr>`).join('');
}

// Mapbox/Googleのどちらのロールにも属さない、query_type/query_count用の列選択(任意)
// initialColumn省略時はdefaultNameという名前の列があればそれをデフォルト選択する
function populateExtraColumnSelect(selectId, headers, initialColumn, defaultName) {
  const sel = document.getElementById(selectId);
  const fallback = headers.includes(defaultName) ? defaultName : '(none)';
  const selected = (initialColumn && headers.includes(initialColumn)) ? initialColumn : fallback;
  sel.innerHTML = '<option value="(none)">(none)</option>' + headers.map(h => `<option value="${esc(h)}">${esc(h)}</option>`).join('');
  sel.value = selected;
}

// analyzing=true: 「analyzing...」表示のプレースホルダ行を出し、完了ボタンを無効化
function openCsvMappingDialog(headers, initialColumns, analyzing, initialQueryTypeColumn, initialQueryCountColumn) {
  document.getElementById('csv-mapping-error').style.display = 'none';
  const confirmBtn = document.getElementById('csv-mapping-confirm-btn');
  populateExtraColumnSelect('csv-querytype-select', headers, initialQueryTypeColumn, 'query_type');
  populateExtraColumnSelect('csv-querycount-select', headers, initialQueryCountColumn, 'query_count');
  if (analyzing) {
    renderCsvMappingRowsAnalyzing(headers);
    confirmBtn.disabled = true;
    setCsvMappingStatus('🤖 AI解析中...');
  } else {
    renderCsvMappingRows(headers, initialColumns);
    confirmBtn.disabled = false;
    setCsvMappingStatus('');
  }
  document.getElementById('csv-mapping-dialog').classList.add('open');
}

// AI応答が返ってきたら、プレースホルダをまとめて実際のselect+結果に置き換える
function applyAiColumnsToDialog(aiCols) {
  renderCsvMappingRows(csvHeaders, aiCols);
  document.getElementById('csv-mapping-confirm-btn').disabled = false;
  setCsvMappingStatus('');
}

function readMappingFromDialog() {
  return Array.from(document.querySelectorAll('#csv-mapping-tbody tr[data-header]')).map(tr => ({
    header: tr.dataset.header,
    mapboxRole: tr.querySelector('.csv-mb-role').value,
    googleRole: tr.querySelector('.csv-gg-role').value,
  }));
}

function initCsvMappingDialog() {
  document.getElementById('csv-mapping-confirm-btn').addEventListener('click', () => {
    const columns = readMappingFromDialog();
    const hasQ  = columns.some(c => c.mapboxRole === 'q');
    const hasGQ = columns.some(c => c.googleRole === 'query');
    if (!hasQ || !hasGQ) {
      const err = document.getElementById('csv-mapping-error');
      err.textContent = 'query に対応する列がありません(Mapbox: q / Google: query のいずれかが未設定です)。';
      err.style.display = 'block';
      return;
    }
    const queryTypeColumn  = document.getElementById('csv-querytype-select').value;
    const queryCountColumn = document.getElementById('csv-querycount-select').value;
    csvMapping = { columns, queryTypeColumn, queryCountColumn };
    const cache = loadCsvMappingCache();
    cache[currentCsvFileName] = { headers: csvHeaders, columns, queryTypeColumn, queryCountColumn, confirmedAt: new Date().toISOString() };
    saveCsvMappingCache(cache);

    // query_type列(選択されていれば)の値を確定。列を変えて再読込した場合に備え、毎回作り直す
    csvQueryTypeColumn = queryTypeColumn !== '(none)' ? queryTypeColumn : null;
    csvHasQueryType = !!csvQueryTypeColumn;
    csvQueryTypeValues = csvHasQueryType
      ? [...new Set(csvRawRows.map(r => r[csvQueryTypeColumn] || ''))]
      : [];
    csvQueryTypeSelected = new Set(csvQueryTypeValues); // デフォルト全チェック(=フィルタなし)

    // query_count列(選択されていれば)を確定。ソート/フィルタ状態はファイル読み込み直後なのでリセットする
    csvQueryCountColumn = queryCountColumn !== '(none)' ? queryCountColumn : null;
    csvHasQueryCount = !!csvQueryCountColumn;
    csvQueryCountMin = null;
    csvSortField = null;
    csvSortDir = 'asc';

    document.getElementById('csv-mapping-dialog').classList.remove('open');
    document.getElementById('csv-body').classList.add('open');
    document.getElementById('csv-toggle-icon').classList.add('open');
    {
      // ラベルはCSSで省略表示(ellipsis)するので、フルテキストはtitleでホバー表示する
      // (ブラウザの仕様上、実ファイルパスは取得不可のためファイル名までを表示)
      const label = document.getElementById('csv-header-label');
      const fullLabel = `📂 ${currentCsvFileName} (${csvRawRows.length} rows)`;
      label.textContent = fullLabel;
      label.title = fullLabel;
    }
    csvIndex = -1;
    renderCSVTable();
  });

  document.getElementById('csv-mapping-cancel-btn').addEventListener('click', () => {
    document.getElementById('csv-mapping-dialog').classList.remove('open');
    csvHeaders = []; csvRawRows = []; csvMapping = null; currentCsvFileName = ''; currentCsvFileId = '';
    csvQueryTypeColumn = null; csvHasQueryType = false; csvQueryTypeValues = []; csvQueryTypeSelected = new Set();
    csvQueryCountColumn = null; csvHasQueryCount = false; csvQueryCountMin = null;
    csvSortField = null; csvSortDir = 'asc';
  });
}

// ---- CSV行 → state反映 ----
function applyRoleValue(target, role, val) {
  switch (role) {
    case 'proximity': case 'location': {
      // 1列にカンマ区切りで緯度・経度が両方入っているケース。
      // Mapbox("proximity")は"経度,緯度"、Google("location")は"緯度,経度"の順で解釈する。
      const parts = val.split(',').map(s => parseFloat(s.trim()));
      if (parts.length === 2 && !parts.some(Number.isNaN)) {
        if (role === 'proximity') { target.lng = parts[0]; target.lat = parts[1]; }
        else { target.lat = parts[0]; target.lng = parts[1]; }
      }
      break;
    }
    case 'proximity(lat)': case 'location(lat)': target.lat = parseFloat(val); break;
    case 'proximity(lng)': case 'location(lng)': target.lng = parseFloat(val); break;
    case 'bbox':      target.bbox = val; break;
    case 'bbox(lat)': target.bboxLat = parseFloat(val); break;
    case 'bbox(lng)': target.bboxLng = parseFloat(val); break;
    case 'types':   target.types = val.split(',').map(s => s.trim()).filter(Boolean); break;
    case 'poi_category':           target.poi_category = val.split(',').map(s => s.trim()).filter(Boolean); break;
    case 'poi_category_exclusion': target.poi_category_exclusion = val.split(',').map(s => s.trim()).filter(Boolean); break;
    case 'limit':   target.limit = parseInt(val, 10); break;
    case 'language':target.language = val; break;
    case 'country': target.country = val; break;
    case 'near':    target.near = val; break;
    case 'navigation_profile': target.navigation_profile = val; break;
    case 'radius':  target.radius = parseFloat(val); break;
    case 'type':    target.type = val; break;
    case 'region':  target.region = val; break;
  }
}

function resolveCsvRow(rawRow, mapping) {
  const mb = {}, gg = {};
  let query = '';
  mapping.columns.forEach(col => {
    const val = (rawRow[col.header] ?? '').trim();
    if (val === '') return;
    if (col.mapboxRole === 'q') query = val;
    if (col.googleRole === 'query' && !query) query = val;
    if (col.mapboxRole && col.mapboxRole !== '(none)' && col.mapboxRole !== 'q') applyRoleValue(mb, col.mapboxRole, val);
    if (col.googleRole && col.googleRole !== '(none)' && col.googleRole !== 'query') applyRoleValue(gg, col.googleRole, val);
  });
  return { query, mapbox: mb, google: gg, raw: rawRow };
}

function applyCsvRowToState(resolved) {
  document.getElementById('query-input').value = resolved.query || '';

  // CSV行を選ぶたびに、Form手動編集フラグを解除して自動追従(位置・半径からのproximity/bbox再計算)を復活させる
  mapboxProximityManual = false;
  mapboxBboxManual = false;

  const mb = resolved.mapbox, gg = resolved.google;
  let lat, lng;
  if (mb.lat != null && mb.lng != null) { lat = mb.lat; lng = mb.lng; }
  else if (gg.lat != null && gg.lng != null) { lat = gg.lat; lng = gg.lng; }
  if (lat != null && lng != null && !isNaN(lat) && !isNaN(lng)) setLocationPin(lat, lng);

  // 行ごとに明示的にリセットしてから反映する(でないと前の行のパラメータが残留する)
  if (mb.bbox) {
    state.mapboxParams.bbox = mb.bbox.split(',').map(Number);
  } else if (mb.bboxLat != null && mb.bboxLng != null && !isNaN(mb.bboxLat) && !isNaN(mb.bboxLng)) {
    // bbox(lat)/bbox(lng)(中心点の分割列)から現在のradiusでbboxを組み立てる
    const offset = getCurrentRadius() / 111000;
    state.mapboxParams.bbox = [
      +(mb.bboxLng - offset).toFixed(6), +(mb.bboxLat - offset).toFixed(6),
      +(mb.bboxLng + offset).toFixed(6), +(mb.bboxLat + offset).toFixed(6),
    ];
  } else {
    delete state.mapboxParams.bbox;
  }
  // 以下は手動編集済み(Form/JSONエディタ)のフィールドがあれば、CSV行の値による上書きをスキップして手動値を保持する
  if (!manualMapboxFields.has('types')) state.mapboxParams.types = mb.types || [];
  if (!manualMapboxFields.has('poi_category')) {
    if (mb.poi_category) state.mapboxParams.poi_category = mb.poi_category; else delete state.mapboxParams.poi_category;
  }
  if (!manualMapboxFields.has('poi_category_exclusion')) {
    if (mb.poi_category_exclusion) state.mapboxParams.poi_category_exclusion = mb.poi_category_exclusion; else delete state.mapboxParams.poi_category_exclusion;
  }
  if (!manualMapboxFields.has('limit')) state.mapboxParams.limit = (mb.limit != null && !isNaN(mb.limit)) ? mb.limit : 10;
  if (!manualMapboxFields.has('language')) state.mapboxParams.language = mb.language || 'ja';
  if (!manualMapboxFields.has('country'))  state.mapboxParams.country  = mb.country  || 'jp';
  if (!manualMapboxFields.has('near')) {
    if (mb.near) state.mapboxParams.near = mb.near; else delete state.mapboxParams.near;
  }
  if (!manualMapboxFields.has('navigation_profile')) {
    if (mb.navigation_profile) state.mapboxParams.navigation_profile = mb.navigation_profile; else delete state.mapboxParams.navigation_profile;
  }

  if (googleApiMode === 'legacy') {
    if (!manualGoogleFields.has('radius'))   state.googleParams.radius   = (gg.radius != null && !isNaN(gg.radius)) ? gg.radius : DEFAULT_RADIUS;
    if (!manualGoogleFields.has('types'))    state.googleParams.types    = gg.type ? [gg.type] : [];
    if (!manualGoogleFields.has('language')) state.googleParams.language = gg.language || 'ja';
    if (!manualGoogleFields.has('region'))   state.googleParams.region   = gg.region   || 'jp';
  } else {
    if (!manualGoogleFields.has('includedType')) state.googleParams.includedType = gg.type || '';
    if (!manualGoogleFields.has('languageCode')) state.googleParams.languageCode = gg.language || 'ja';
    if (!manualGoogleFields.has('regionCode'))   state.googleParams.regionCode   = gg.region   || 'jp';
  }

  writeToURL();
  refreshParamUI('google'); refreshParamUI('mapbox');
  updateBboxBtn();
}

async function jumpToCSVRow(idx) {
  if (idx < 0 || idx >= csvRawRows.length || !csvMapping) return;
  csvIndex = idx;
  const resolved = resolveCsvRow(csvRawRows[idx], csvMapping);
  applyCsvRowToState(resolved);

  renderCSVTable();
  scrollCSVToIndex(idx);

  await doSearch();
}

function initCSV() {
  document.getElementById('csv-toggle').addEventListener('click', () => {
    const body = document.getElementById('csv-body');
    const icon = document.getElementById('csv-toggle-icon');
    const isOpen = body.classList.toggle('open');
    icon.classList.toggle('open', isOpen);
  });

  document.getElementById('csv-file-btn').addEventListener('click', () => {
    document.getElementById('csv-file-input').click();
  });

  document.getElementById('csv-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    currentCsvFileName = file.name;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setTimeout(async () => {
        const parsed = parseCSV(ev.target.result);
        if (!parsed) { alert('CSVを解析できませんでした(ヘッダー行+データ行が必要です)。'); return; }
        if (!parsed.rows.length) { alert('有効な行がありません。'); return; }
        csvHeaders = parsed.headers;
        csvRawRows = parsed.rows;
        // ファイル名+内容ハッシュで識別 → 同じファイルを再読込した際に過去のフィードバックを参照できる
        currentCsvFileId = `${file.name}::${hashString(ev.target.result)}`;
        csvFilterResult = 'all'; csvFilterReason = 'all'; csvFilterText = '';
        document.getElementById('csv-filter-result').value = 'all';
        document.getElementById('csv-filter-reason').value = 'all';
        document.getElementById('csv-filter-text').value = '';

        const cache = loadCsvMappingCache();
        const cached = cache[file.name];

        if (cached && arraysEqual(cached.headers, csvHeaders)) {
          // 同一ファイル名+同一ヘッダー構成 → AI呼び出しをスキップしてキャッシュを再利用
          openCsvMappingDialog(csvHeaders, cached.columns, false, cached.queryTypeColumn, cached.queryCountColumn);
          setCsvMappingStatus('📦 前回の判定結果を再利用しています(AI呼び出しなし)');
        } else {
          // まず「analyzing...」のプレースホルダでモーダルを即表示し、完了ボタンは無効化
          openCsvMappingDialog(csvHeaders, null, true);
          try {
            const sample = csvRawRows.slice(0, 5);
            const aiCols = await analyzeCsvColumns(csvHeaders, sample);
            applyAiColumnsToDialog(aiCols);
          } catch (err) {
            renderCsvMappingRows(csvHeaders, csvHeaders.map(h => ({ header: h, mapboxRole: '(none)', googleRole: '(none)' })));
            document.getElementById('csv-mapping-confirm-btn').disabled = false;
            setCsvMappingStatus('⚠️ AI解析に失敗しました。手動でマッピングしてください: ' + err.message);
          }
        }
      }, 0);
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  const jumpInput = document.getElementById('csv-jump-input');
  const jumpBtn   = document.getElementById('csv-jump-btn');
  const jumpHint  = document.getElementById('csv-jump-hint');

  const doJump = () => {
    const val = parseInt(jumpInput.value);
    if (isNaN(val) || val < 1) { jumpHint.textContent = '無効な値'; return; }
    if (val > csvRawRows.length) { jumpHint.textContent = `最大 ${csvRawRows.length}`; return; }
    jumpToCSVRow(val - 1);
    jumpHint.textContent = `→ ${val}行目`;
    setTimeout(() => jumpHint.textContent = '', 2000);
  };

  jumpBtn.addEventListener('click', doJump);
  jumpInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJump(); });

  // CSV読み込み中のクエリのみ、実際の検索からbbox/navigation_profileを常に除外するオーバーライド。
  // トグル時、CSV行を表示中ならその場で再検索して結果に反映する
  document.getElementById('csv-ignore-bbox-checkbox').addEventListener('change', (e) => {
    csvIgnoreBbox = e.target.checked;
    if (currentCsvFileId && csvIndex >= 0) doSearch();
  });
  document.getElementById('csv-ignore-navprofile-checkbox').addEventListener('change', (e) => {
    csvIgnoreNavProfile = e.target.checked;
    if (currentCsvFileId && csvIndex >= 0) doSearch();
  });

  populateCsvFilterReasonOptions();
  // フィルタ変更時はスクロール位置を先頭に戻す(古い位置のままだと絞り込み後の内容が画面外にずれて見えるため)
  const resetCsvScroll = () => { document.getElementById('csv-body').scrollTop = 0; };
  document.getElementById('csv-filter-result').addEventListener('change', (e) => { csvFilterResult = e.target.value; resetCsvScroll(); renderCSVViewport(); });
  document.getElementById('csv-filter-reason').addEventListener('change', (e) => { csvFilterReason = e.target.value; resetCsvScroll(); renderCSVViewport(); });
  const runCsvTextFilter = () => { csvFilterText = document.getElementById('csv-filter-text').value; resetCsvScroll(); renderCSVViewport(); };
  document.getElementById('csv-filter-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') runCsvTextFilter(); });
  document.getElementById('csv-filter-text-btn').addEventListener('click', runCsvTextFilter);

  initCsvMappingDialog();
}

// ============================================================
// MONACO EDITORS
// ============================================================
let googleParamJsonEditor = null, mapboxParamJsonEditor = null, queryEditor = null;
let queryMapboxEditor = null, googleResultEditor = null, mapboxResultEditor = null;
let editorsInited = false, pendingGoogleUrl = '', pendingMapboxUrl = '';

// QUERYダイアログを開いている間だけ非nullになる編集用ドラフト。Form/JSONエディタでの編集は全てこのドラフトに対して行い、
// 「Apply」を押すまでstate.mapboxParams/googleParamsには一切反映しない(GUIチェックボックス等の細かい編集イベントの
// 取り漏れ・タイミング問題を気にせず、Applyを押した瞬間に確実に一括反映する設計にするため)。
// Cancel/✕/Escape/背景クリックのいずれで閉じてもdraftは破棄されるだけで、stateは無傷のまま
let queryDialogDraft = { mapbox: null, google: null };
// 今回のダイアログ編集セッション中に実際に触れたフィールドパス(Apply時に「本当に編集したものだけ」manualFields化するため。
// JSONエディタ編集時は差分が取りにくいので、その時点の全キーをまとめて追加する)
let queryDialogTouched = { mapbox: new Set(), google: new Set() };
// syncEngineJsonFromStateが自前でeditor.setValue()する間、それをonDidChangeModelContentが
// 「ユーザーがJSONを手で編集した」と誤認しないようにするためのフラグ
let suppressJsonSync = { mapbox: false, google: false };
function engineParamsForEdit(engine) {
  const draft = engine === 'google' ? queryDialogDraft.google : queryDialogDraft.mapbox;
  return draft || (engine === 'google' ? state.googleParams : state.mapboxParams);
}

require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' } });

function initEditors(cb) {
  if (editorsInited) { cb && cb(); return; }
  editorsInited = true;
  require(['vs/editor/editor.main'], function () {
    const common = { language: 'json', theme: 'vs-dark', minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, formatOnPaste: true, automaticLayout: true };

    const qgWrap = document.getElementById('query-google-editor-wrap'); qgWrap.style.height = '140px';
    queryEditor = monaco.editor.create(qgWrap, { ...common, language: 'plaintext', value: pendingGoogleUrl, readOnly: true });

    const qmWrap = document.getElementById('query-mapbox-editor-wrap'); qmWrap.style.height = '140px';
    queryMapboxEditor = monaco.editor.create(qmWrap, { ...common, language: 'plaintext', value: pendingMapboxUrl, readOnly: true });

    const gpWrap = document.getElementById('google-param-json-wrap'); gpWrap.style.height = '280px';
    googleParamJsonEditor = monaco.editor.create(gpWrap, { ...common, value: JSON.stringify(state.googleParams, null, 2) });
    googleParamJsonEditor.onDidChangeModelContent(() => {
      // syncEngineJsonFromStateが自分でeditor.setValue()した時もこのイベントは発火してしまうため、
      // そのプログラム的な更新中はsuppressJsonSyncで無視する(でないとForm編集のたびにここが誤発火し、
      // ドラフトオブジェクトが新しい参照に差し替わってFormのクロージャと食い違ってしまう=編集消失バグの原因だった)
      if (suppressJsonSync.google) return;
      // ダイアログを開いている間はドラフトに書き込むだけ(Applyを押すまでstateには反映しない)
      try {
        const parsed = JSON.parse(googleParamJsonEditor.getValue());
        if (queryDialogDraft.google) {
          queryDialogDraft.google = parsed;
          Object.keys(parsed).forEach(k => queryDialogTouched.google.add(k));
        } else {
          state.googleParams = parsed;
          Object.keys(state.googleParams).forEach(k => markFieldManual('google', k));
          writeToURL();
        }
      } catch {}
    });

    const mpWrap = document.getElementById('mapbox-param-json-wrap'); mpWrap.style.height = '280px';
    mapboxParamJsonEditor = monaco.editor.create(mpWrap, { ...common, value: JSON.stringify(state.mapboxParams, null, 2) });
    mapboxParamJsonEditor.onDidChangeModelContent(() => {
      // 上と同じ理由でプログラム的な更新中は無視する
      if (suppressJsonSync.mapbox) return;
      // ダイアログを開いている間はドラフトに書き込むだけ(Applyを押すまでstateには反映しない)
      try {
        const parsed = JSON.parse(mapboxParamJsonEditor.getValue());
        if (queryDialogDraft.mapbox) {
          queryDialogDraft.mapbox = parsed;
          Object.keys(parsed).forEach(k => queryDialogTouched.mapbox.add(k));
        } else {
          state.mapboxParams = parsed;
          mapboxProximityManual = true;
          mapboxBboxManual = true;
          Object.keys(state.mapboxParams).forEach(k => markFieldManual('mapbox', k));
          writeToURL();
        }
      } catch {}
    });

    const grWrap = document.getElementById('google-result-editor-wrap'); grWrap.style.height = '400px';
    googleResultEditor = monaco.editor.create(grWrap, { ...common, value: JSON.stringify(googleRawResults, null, 2), readOnly: true });

    const mrWrap = document.getElementById('mapbox-result-editor-wrap'); mrWrap.style.height = '400px';
    mapboxResultEditor = monaco.editor.create(mrWrap, { ...common, value: JSON.stringify(mapboxRawResults, null, 2), readOnly: true });

    cb && cb();
  });
}

// ============================================================
// PARAM UI (Form ⇄ JSON)
// ============================================================
// QUERYダイアログを開いている間は、Form/JSON双方の表示・編集をqueryDialogDraft(まだApplyされていない編集中の値)に対して行う。
// ダイアログを開いていない時に呼ばれた場合(CSV行移動時の裏更新等)は、そのままstateを対象にする
function refreshParamUI(engine) {
  const stateObj = engineParamsForEdit(engine);
  const fields = getEngineFields(engine);
  const formEl = document.getElementById(`${engine}-param-form`);
  if (formEl) renderParamForm(formEl, fields, stateObj, (path) => { queryDialogTouched[engine].add(path); syncEngineJsonFromState(engine); });
  syncEngineJsonFromState(engine);
}

function syncEngineJsonFromState(engine) {
  const editor = engine === 'google' ? googleParamJsonEditor : mapboxParamJsonEditor;
  const stateObj = engineParamsForEdit(engine);
  const json = JSON.stringify(stateObj, null, 2);
  if (editor && editor.getValue() !== json) {
    // このsetValue()自体がonDidChangeModelContentを発火させてしまうため、その間は「ユーザー編集」判定を止める
    suppressJsonSync[engine] = true;
    editor.setValue(json);
    suppressJsonSync[engine] = false;
  }
}

// Resetは(ダイアログを開いている間は)ドラフトだけを初期値に戻す。実際のstateへの反映はApplyを押した時点
function resetEngineParams(engine) {
  const { lat, lng } = getCurrentLocation(), radius = getCurrentRadius();
  let fresh;
  if (engine === 'google') {
    if (googleApiMode === 'new') {
      fresh = structuredClone(DEFAULT_GOOGLE_PARAMS_NEW);
      fresh.locationRestriction = { rectangle: { low: { latitude: lat - radius/111000, longitude: lng - radius/111000 }, high: { latitude: lat + radius/111000, longitude: lng + radius/111000 } } };
    } else {
      fresh = structuredClone(DEFAULT_GOOGLE_PARAMS_LEGACY);
      fresh.location = { lat, lng }; fresh.radius = radius;
    }
    manualGoogleFields.clear();
    if (queryDialogDraft.google) queryDialogDraft.google = fresh; else { state.googleParams = fresh; writeToURL(); }
  } else {
    fresh = structuredClone(DEFAULT_MAPBOX_PARAMS);
    fresh.proximity = { lng, lat };
    // Resetでデフォルトに戻すので、Form/JSONエディタの手動編集フラグも解除して自動追従を復活させる
    mapboxProximityManual = false;
    mapboxBboxManual = false;
    manualMapboxFields.clear();
    if (queryDialogDraft.mapbox) queryDialogDraft.mapbox = fresh; else { state.mapboxParams = fresh; writeToURL(); }
  }
  refreshParamUI(engine); drawRangeOverlays(); updateBboxBtn();
}

// ダイアログ編集中はドラフト(現在表示中の値)をコピーする
function copyEngineParams(engine, btn, label) {
  const obj = engineParamsForEdit(engine);
  navigator.clipboard.writeText(JSON.stringify(obj, null, 2));
  btn.textContent = '✅'; setTimeout(() => btn.textContent = label, 1500);
}

function initParamUIControls() {
  document.querySelectorAll('.param-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const engine = btn.dataset.engine, view = btn.dataset.view;
      document.querySelectorAll(`.param-view-btn[data-engine="${engine}"]`).forEach(b => b.classList.toggle('active', b === btn));
      document.getElementById(`${engine}-param-form`).style.display = view === 'form' ? 'flex' : 'none';
      document.getElementById(`${engine}-param-json-wrap`).style.display = view === 'json' ? 'block' : 'none';
      if (view === 'form') refreshParamUI(engine);
    });
  });

  document.getElementById('google-param-reset-btn').addEventListener('click', () => resetEngineParams('google'));
  document.getElementById('mapbox-param-reset-btn').addEventListener('click', () => resetEngineParams('mapbox'));
  document.getElementById('google-param-copy-btn').addEventListener('click', (e) => copyEngineParams('google', e.target, 'Copy JSON'));
  document.getElementById('mapbox-param-copy-btn').addEventListener('click', (e) => copyEngineParams('mapbox', e.target, 'Copy JSON'));
}

// ============================================================
// DIALOGS
// ============================================================
function openDialog(id) { initEditors(() => document.getElementById(id).classList.add('open')); }
function closeDialog(id) {
  document.getElementById(id).classList.remove('open');
  // QUERYダイアログはApplyを押さない限りstateに一切反映されないので、閉じ方(✕/Escape/背景クリック/Cancel)を問わず
  // ドラフトを破棄するだけでよい
  if (id === 'query-dialog') { queryDialogDraft.mapbox = null; queryDialogDraft.google = null; }
}

document.querySelectorAll('.dialog-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDialog(overlay.id); });
});
document.querySelectorAll('.dialog-close').forEach(btn => {
  btn.addEventListener('click', () => closeDialog(btn.dataset.close));
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.dialog-overlay.open').forEach(el => closeDialog(el.id));
});
// AI Hintボタンは検索結果と違って再レンダリングされない静的要素なので、トップレベルで一度だけ配線する
document.getElementById('ai-hint-btn').addEventListener('click', () => { if (feedbackContext) openAiHintDialog(); });
initResultSearchBoxes();

// ============================================================
// CENTER MAPS
// ============================================================
function centerMapsTo(lat, lng) {
  isSyncing = true;
  if (googleMap) { googleMap.setCenter({ lat, lng }); googleMap.setZoom(17); }
  if (mapboxMap) mapboxMap.jumpTo({ center: [lng, lat], zoom: 17 });
  setTimeout(() => { isSyncing = false; }, 300);
}

// 検索結果マーカーが画面外に出ないよう、各マップを自身の結果に合わせてfitさせる
// (Google/Mapboxはそれぞれ別の結果集合を持つので、各マップは自分の結果だけに合わせる)
function fitResultsBounds() {
  isSyncing = true; // fitBounds由来の idle/moveend で相互同期が発火しないようにする

  if (googleMap && googleRawResults.length) {
    if (googleRawResults.length === 1) {
      googleMap.setCenter({ lat: googleRawResults[0].geometry.location.lat, lng: googleRawResults[0].geometry.location.lng });
      googleMap.setZoom(17);
    } else {
      const bounds = new google.maps.LatLngBounds();
      googleRawResults.forEach(r => bounds.extend({ lat: r.geometry.location.lat, lng: r.geometry.location.lng }));
      googleMap.fitBounds(bounds, 60);
    }
  }

  if (mapboxMap && mapboxRawResults.length) {
    if (mapboxRawResults.length === 1) {
      mapboxMap.jumpTo({ center: [mapboxRawResults[0].coordinates.longitude, mapboxRawResults[0].coordinates.latitude], zoom: 17 });
    } else {
      const bounds = new mapboxgl.LngLatBounds();
      mapboxRawResults.forEach(r => bounds.extend([r.coordinates.longitude, r.coordinates.latitude]));
      mapboxMap.fitBounds(bounds, { padding: 60, maxZoom: 17, duration: 0 });
    }
  }

  setTimeout(() => { isSyncing = false; }, 400);
}

// ============================================================
// MAP SYNC
// ============================================================
let isSyncing = false, locationPin = { google: null, mapbox: null };
let radiusCircle = null, radiusRectangle = null;

function syncFromGoogle() {
  if (isSyncing || !mapboxMap) return; isSyncing = true;
  const c = googleMap.getCenter();
  mapboxMap.jumpTo({ center: [c.lng(), c.lat()], zoom: googleMap.getZoom() - 1 });
  isSyncing = false;
}
function syncFromMapbox() {
  if (isSyncing || !googleMap) return; isSyncing = true;
  const c = mapboxMap.getCenter();
  googleMap.setCenter({ lat: c.lat, lng: c.lng }); googleMap.setZoom(mapboxMap.getZoom() + 1);
  isSyncing = false;
}

// ============================================================
// RANGE OVERLAYS
// ============================================================
function drawRangeOverlays() { drawGoogleOverlay(); drawMapboxBbox(); }

function drawGoogleOverlay() {
  if (!googleMap) return;
  if (radiusCircle)    { radiusCircle.setMap(null);    radiusCircle    = null; }
  if (radiusRectangle) { radiusRectangle.setMap(null); radiusRectangle = null; }
  if (googleApiMode === 'legacy') {
    const { lat, lng } = getCurrentLocation();
    radiusCircle = new google.maps.Circle({ map: googleMap, center: { lat, lng }, radius: getCurrentRadius(), strokeColor: '#2563eb', strokeOpacity: 0.8, strokeWeight: 2, fillColor: '#2563eb', fillOpacity: 0.08, clickable: false });
  } else {
    const rect = state.googleParams.locationRestriction?.rectangle; if (!rect) return;
    radiusRectangle = new google.maps.Rectangle({ map: googleMap, bounds: { south: rect.low.latitude, west: rect.low.longitude, north: rect.high.latitude, east: rect.high.longitude }, strokeColor: '#2563eb', strokeOpacity: 0.8, strokeWeight: 2, fillColor: '#2563eb', fillOpacity: 0.08, clickable: false });
  }
}

function drawMapboxBbox() {
  if (!mapboxMap) return;
  const bbox = state.mapboxParams.bbox, hasBbox = Array.isArray(bbox) && bbox.length === 4;
  if (!hasBbox) {
    if (mapboxMap.getSource('bbox-source')) mapboxMap.getSource('bbox-source').setData({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[]] } });
    return;
  }
  const [west, south, east, north] = bbox;
  const geojson = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[west,south],[east,south],[east,north],[west,north],[west,south]]] } };
  if (mapboxMap.getSource('bbox-source')) {
    mapboxMap.getSource('bbox-source').setData(geojson);
  } else {
    const addLayers = () => {
      mapboxMap.addSource('bbox-source', { type: 'geojson', data: geojson });
      mapboxMap.addLayer({ id: 'bbox-fill', type: 'fill', source: 'bbox-source', paint: { 'fill-color': '#e74c3c', 'fill-opacity': 0.08 } });
      mapboxMap.addLayer({ id: 'bbox-line', type: 'line', source: 'bbox-source', paint: { 'line-color': '#e74c3c', 'line-width': 2, 'line-opacity': 0.8 } });
    };
    if (mapboxMap.isStyleLoaded()) addLayers(); else mapboxMap.once('load', addLayers);
  }
}

// ============================================================
// LOCATION PIN
// ============================================================
function setLocationPin(lat, lng) {
  // 新しい場所が明示的に選ばれたので、Form手動編集フラグを解除して自動追従を復活させる
  mapboxProximityManual = false;
  setLocationToState(lat, lng);
  state.mapboxParams.proximity = { lng, lat };
  writeToURL();
  refreshParamUI('google'); refreshParamUI('mapbox');

  // proximity/locationの中心ピン: 結果一覧の🅿️バッジ(赤背景/白太字のP)とお揃いのデザインにする
  const PIN_SVG = `<svg width="28" height="38" viewBox="0 0 28 38" xmlns="http://www.w3.org/2000/svg"><path d="M14 0C6.27 0 0 6.27 0 14C0 24.5 14 38 14 38C14 38 28 24.5 28 14C28 6.27 21.73 0 14 0Z" fill="#dc2626" stroke="white" stroke-width="2"/><text x="14" y="19" text-anchor="middle" font-size="14" font-weight="bold" fill="white" font-family="Arial, sans-serif">P</text></svg>`;

  if (locationPin.google) locationPin.google.setMap(null);
  locationPin.google = new google.maps.Marker({
    position: { lat, lng }, map: googleMap,
    icon: { url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(PIN_SVG), scaledSize: new google.maps.Size(28, 38), anchor: new google.maps.Point(14, 38) },
    title: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, zIndex: 999,
  });

  if (locationPin.mapbox) locationPin.mapbox.remove();
  const el = document.createElement('div');
  el.innerHTML = PIN_SVG;
  el.style.cursor = 'pointer';
  locationPin.mapbox = new mapboxgl.Marker({ element: el, anchor: 'bottom' }).setLngLat([lng, lat]).addTo(mapboxMap);
}

// ============================================================
// POI DENSITY
// ============================================================
function applyPoiDensity(density) {
  if (!mapboxMap) return;
  if (!mapboxMap.isStyleLoaded()) {
    mapboxMap.once('idle', () => applyPoiDensity(density));
    return;
  }

  const poiLayers = mapboxMap.getStyle().layers
    .filter(l => l.type === 'symbol' && /poi/i.test(l.id))
    .map(l => l.id);

  if (poiLayers.length === 0) {
    console.warn('[POI density] No POI layers found in current style');
    return;
  }

  const filterrankBase = [4, 6, 8, 10][density - 1];
  const allowOverlap   = density >= 3;

  poiLayers.forEach((layerId) => {
    try {
      mapboxMap.setFilter(layerId, [
        'all',
        ['<=',
          ['coalesce', ['get', 'filterrank'], 0],
          ['+', ['step', ['zoom'], 0, 16, 1, 17, 2], filterrankBase],
        ],
      ]);
    } catch (e) { /* ignore */ }

    try { mapboxMap.setLayoutProperty(layerId, 'text-allow-overlap',    allowOverlap); } catch (e) {}
    try { mapboxMap.setLayoutProperty(layerId, 'icon-allow-overlap',    allowOverlap); } catch (e) {}
    try { mapboxMap.setLayoutProperty(layerId, 'text-ignore-placement', allowOverlap); } catch (e) {}
  });
}

// ============================================================
// BBOX TOGGLE
// ============================================================
function updateBboxBtn() {
  const btn     = document.getElementById('bbox-toggle-btn');
  const hasBbox = Array.isArray(state.mapboxParams.bbox) && state.mapboxParams.bbox.length === 4;
  btn.textContent  = hasBbox ? 'BBOX ON(Switch to OFF)' : 'BBOX OFF (Switch to ON)';
  btn.style.borderColor = hasBbox ? '#e74c3c' : '#444';
  btn.style.color       = hasBbox ? '#e74c3c' : '#ccc';
}

function toggleBbox() {
  const hasBbox = Array.isArray(state.mapboxParams.bbox) && state.mapboxParams.bbox.length === 4;
  if (hasBbox) {
    delete state.mapboxParams.bbox;
  } else {
    const { lat, lng } = getCurrentLocation();
    const offset = getCurrentRadius() / 111000;
    state.mapboxParams.bbox = [
      +(lng - offset).toFixed(6),
      +(lat - offset).toFixed(6),
      +(lng + offset).toFixed(6),
      +(lat + offset).toFixed(6),
    ];
  }
  refreshParamUI('mapbox');
  writeToURL();
  drawMapboxBbox();
  updateBboxBtn();
}

// ============================================================
// MARKER HIGHLIGHT
// ============================================================
let highlightedGoogleMarker = null;
let highlightedMapboxMarker = null;

function highlightGoogleMarker(index) {
  mapboxMarkers.forEach((m) => {
    const el = m._customEl;
    if (el) Object.assign(el.style, { width: '24px', height: '24px', background: '#e74c3c', fontSize: '10px' });
  });
  highlightedMapboxMarker = null;

  googleMarkers.forEach((m) => {
    m.setIcon({ path: google.maps.SymbolPath.CIRCLE, scale: 12, fillColor: '#1a73e8', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 });
  });
  if (googleMarkers[index]) {
    googleMarkers[index].setIcon({ path: google.maps.SymbolPath.CIRCLE, scale: 18, fillColor: '#f59e0b', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 });
    highlightedGoogleMarker = index;
  }
}

function highlightMapboxMarker(index) {
  googleMarkers.forEach((m) => {
    m.setIcon({ path: google.maps.SymbolPath.CIRCLE, scale: 12, fillColor: '#1a73e8', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 });
  });
  highlightedGoogleMarker = null;

  mapboxMarkers.forEach((m) => {
    const el = m._customEl;
    if (el) Object.assign(el.style, { width: '24px', height: '24px', background: '#e74c3c', fontSize: '10px' });
  });
  const el = mapboxMarkers[index]?._customEl;
  if (el) {
    Object.assign(el.style, { width: '36px', height: '36px', background: '#f59e0b', fontSize: '13px' });
    highlightedMapboxMarker = index;
  }
}

// ============================================================
// RESULTS
// ============================================================
let googleRawResults = [], mapboxRawResults = [];

function updateResultEditors() {
  googleResultEditor?.setValue(JSON.stringify(googleRawResults, null, 2));
  mapboxResultEditor?.setValue(JSON.stringify(mapboxRawResults, null, 2));
  // 内容が変わったので、古い検索結果(matches)が新しい内容とズレたまま残らないよう検索ボックスもリセットする
  ['google', 'mapbox'].forEach(side => {
    const input = document.getElementById(`${side}-result-search`);
    if (input) { input.value = ''; input.classList.remove('no-match'); }
    resultSearchState[side] = { matches: [], index: -1 };
  });
}

// RESULTSダイアログの検索ボックス。Monaco Editor内蔵のFind機能(Ctrl+F)はショートカット頼りで
// 気付かれにくいため、常に見えるテキストボックスを別途用意する。入力するたびに最初のマッチへジャンプし、
// Enter/Shift+Enterで次/前のマッチへ巡回する(入力欄のフォーカスは奪わない。editor.focus()を呼ぶと
// 1文字打つごとに入力欄からフォーカスが逃げてしまうため)
const resultSearchState = { google: { matches: [], index: -1 }, mapbox: { matches: [], index: -1 } };

function jumpToResultMatch(side, term, direction) {
  const editor = side === 'google' ? googleResultEditor : mapboxResultEditor;
  const input = document.getElementById(`${side}-result-search`);
  if (!editor || !input) return;
  const state = resultSearchState[side];

  if (!term) {
    state.matches = []; state.index = -1;
    input.classList.remove('no-match');
    return;
  }
  if (direction === 0) {
    // 入力内容が変わったので検索し直し、最初のマッチへジャンプする
    state.matches = editor.getModel().findMatches(term, false, false, false, null, false);
    state.index = state.matches.length ? 0 : -1;
  } else if (state.matches.length) {
    // Enter/Shift+Enter: 検索し直さず、既に見つかっているマッチの中を巡回する(先頭/末尾で折り返す)
    state.index = (state.index + direction + state.matches.length) % state.matches.length;
  }

  input.classList.toggle('no-match', state.matches.length === 0);
  if (state.index === -1) return;
  const range = state.matches[state.index].range;
  editor.revealRangeInCenter(range);
  editor.setSelection(range);
}

function initResultSearchBoxes() {
  ['google', 'mapbox'].forEach(side => {
    const input = document.getElementById(`${side}-result-search`);
    if (!input) return;
    input.addEventListener('input', () => jumpToResultMatch(side, input.value.trim(), 0));
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      jumpToResultMatch(side, input.value.trim(), e.shiftKey ? -1 : 1);
    });
  });
}

// ============================================================
// MODE TOGGLE
// ============================================================
function updateModeBadge() {
  const badge = document.getElementById('google-mode-badge');
  const label = document.getElementById('query-google-label');
  if (googleApiMode === 'new') {
    badge.textContent = 'New (Switch to Legacy)'; badge.className = 'mode-badge new';
    if (label) label.textContent = 'Google Places API (New)';
  } else {
    badge.textContent = 'Legacy (Switch to New)'; badge.className = 'mode-badge legacy';
    if (label) label.textContent = 'Google Places API (Legacy)';
  }
}

function switchMode(newMode) {
  if (googleApiMode === newMode) return;
  const { lat, lng } = getCurrentLocation(), radius = getCurrentRadius();
  googleApiMode = newMode;
  if (googleApiMode === 'new') {
    state.googleParams = structuredClone(DEFAULT_GOOGLE_PARAMS_NEW);
    state.googleParams.locationRestriction = { rectangle: { low: { latitude: lat - radius/111000, longitude: lng - radius/111000 }, high: { latitude: lat + radius/111000, longitude: lng + radius/111000 } } };
  } else {
    state.googleParams = structuredClone(DEFAULT_GOOGLE_PARAMS_LEGACY);
    state.googleParams.location = { lat, lng }; state.googleParams.radius = radius;
  }
  updateModeBadge(); writeToURL(); refreshParamUI('google'); drawGoogleOverlay();
}

document.getElementById('google-mode-badge').addEventListener('click', () => switchMode(googleApiMode === 'new' ? 'legacy' : 'new'));

// ============================================================
// EVENT LISTENERS
// ============================================================
document.getElementById('search-btn').addEventListener('click', doSearch);
document.getElementById('query-input').addEventListener('keydown', e => {
  if (e.isComposing) return; // IME変換中はEnter確定/履歴操作どちらも無視(誤発火防止)
  if (e.key === 'Enter') { doSearch(); return; }
  if (e.key === 'ArrowUp') {
    if (queryHistory.length === 0) return;
    e.preventDefault();
    if (queryHistoryPos === -1) queryHistoryDraft = e.target.value;
    queryHistoryPos = Math.min(queryHistoryPos + 1, queryHistory.length - 1);
    e.target.value = queryHistory[queryHistoryPos];
  } else if (e.key === 'ArrowDown') {
    if (queryHistoryPos === -1) return;
    e.preventDefault();
    queryHistoryPos -= 1;
    e.target.value = queryHistoryPos === -1 ? queryHistoryDraft : queryHistory[queryHistoryPos];
  }
});
document.getElementById('copy-url-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(window.location.href);
  const btn = document.getElementById('copy-url-btn'); btn.textContent = '✅ Copied!'; setTimeout(() => btn.textContent = '🔗 Copy URL', 2000);
});
document.getElementById('open-query-btn').addEventListener('click', () => {
  // 開くたびに現在のstateからドラフトを作り直す(前回Cancelで捨てた分は引き継がない)
  queryDialogDraft.google = structuredClone(state.googleParams);
  queryDialogDraft.mapbox = structuredClone(state.mapboxParams);
  queryDialogTouched.google = new Set();
  queryDialogTouched.mapbox = new Set();
  initEditors(() => {
    document.getElementById('query-dialog').classList.add('open');
    refreshParamUI('google'); refreshParamUI('mapbox');
  });
});
document.getElementById('query-dialog-cancel-btn').addEventListener('click', () => closeDialog('query-dialog'));
document.getElementById('query-dialog-apply-btn').addEventListener('click', () => {
  // 実際にこの編集セッション中に触れたフィールドだけをmanual化する(触れていないproximity/bbox等の
  // 自動追従を意図せずロックしてしまわないため)
  if (queryDialogDraft.google) {
    state.googleParams = queryDialogDraft.google;
    queryDialogTouched.google.forEach(k => markFieldManual('google', k));
  }
  if (queryDialogDraft.mapbox) {
    state.mapboxParams = queryDialogDraft.mapbox;
    // Formでの編集は'proximity.lat'等のドット区切りパス、JSONエディタでの編集は'proximity'という
    // トップレベルキーで記録されている(JSON側はキー単位でしか差分を取れないため)。両方見る
    if (queryDialogTouched.mapbox.has('proximity') || queryDialogTouched.mapbox.has('proximity.lat') || queryDialogTouched.mapbox.has('proximity.lng')) mapboxProximityManual = true;
    if (queryDialogTouched.mapbox.has('bbox') || [...queryDialogTouched.mapbox].some(p => /^bbox\.\d$/.test(p))) mapboxBboxManual = true;
    queryDialogTouched.mapbox.forEach(k => markFieldManual('mapbox', k));
  }
  writeToURL(); drawRangeOverlays(); updateBboxBtn();
  closeDialog('query-dialog');
});
document.getElementById('open-results-btn').addEventListener('click', () => openDialog('results-dialog'));
document.getElementById('open-history-btn').addEventListener('click', () => { renderHistoryTable(); document.getElementById('history-dialog').classList.add('open'); });
document.getElementById('open-token-btn').addEventListener('click', openTokenModal);

// ============================================================
// HISTORY (フィードバック履歴)
// ============================================================
// v2(type: 'ticket'|'state')/レガシー(v1, resultフィールド)の両方に対応した履歴表示用フォーマッタ
function formatHistoryEntry(e) {
  if (e.type === 'ticket') {
    return { result: `🐞 Ticket (${e.problemType === 'data' ? 'Data' : 'Search Engine'})`, reason: ticketSummaryLabel(e), note: e.note || '', googleOk: '-' };
  }
  if (e.type === 'state') {
    const label = e.state === 'no_issue' ? '✅ No Issue' : e.state === 'out_of_scope' ? '➖ Out of scope' : e.state;
    return { result: label, reason: e.reason || '', note: '', googleOk: '-' };
  }
  // レガシー(v1)エントリ
  return { result: resultIconOf(e.result), reason: e.reason || '', note: '', googleOk: e.googleOk || '-' };
}

function renderHistoryTable() {
  const tbody = document.getElementById('history-tbody');
  const log = [...feedbackLog].reverse(); // 新しい順
  document.getElementById('history-count').textContent = `${log.length}件`;
  tbody.innerHTML = log.map(e => {
    const f = formatHistoryEntry(e);
    return `
    <tr>
      <td>${esc(e.timestamp)}</td>
      <td>${esc(e.fileName || '-')}</td>
      <td>${e.rowIndex != null ? e.rowIndex + 1 : '-'}</td>
      <td title="${esc(e.query)}">${esc(e.query)}</td>
      <td>${f.result}</td>
      <td title="${esc(f.reason)}">${esc(f.reason)}</td>
      <td title="${esc(f.note)}">${esc(f.note)}</td>
      <td>${esc(f.googleOk)}</td>
    </tr>`;
  }).join('');
}

function historyToCSV() {
  const header = ['timestamp', 'fileName', 'rowIndex', 'query', 'result', 'reason', 'note', 'googleOk'];
  const csvEscape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [header.join(',')];
  feedbackLog.forEach(e => {
    const f = formatHistoryEntry(e);
    lines.push([e.timestamp, e.fileName || '', e.rowIndex != null ? e.rowIndex + 1 : '', e.query, f.result, f.reason, f.note, f.googleOk]
      .map(csvEscape).join(','));
  });
  return lines.join('\n');
}

document.getElementById('history-copy-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(historyToCSV());
  const btn = document.getElementById('history-copy-btn'); btn.textContent = '✅ Copied'; setTimeout(() => btn.textContent = 'Copy', 1500);
});
document.getElementById('history-export-btn').addEventListener('click', () => {
  const blob = new Blob([historyToCSV()], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `feedback_history_${Date.now()}.csv`; a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('copy-google-query-btn').addEventListener('click', () => { navigator.clipboard.writeText(pendingGoogleUrl); const btn = document.getElementById('copy-google-query-btn'); btn.textContent = '✅'; setTimeout(() => btn.textContent = 'Copy', 2000); });
document.getElementById('copy-mapbox-query-btn').addEventListener('click', () => { navigator.clipboard.writeText(pendingMapboxUrl); const btn = document.getElementById('copy-mapbox-query-btn'); btn.textContent = '✅'; setTimeout(() => btn.textContent = 'Copy', 2000); });
document.getElementById('copy-google-results-btn').addEventListener('click', () => { navigator.clipboard.writeText(JSON.stringify(googleRawResults, null, 2)); const btn = document.getElementById('copy-google-results-btn'); btn.textContent = '✅'; setTimeout(() => btn.textContent = 'Copy', 2000); });
document.getElementById('copy-mapbox-results-btn').addEventListener('click', () => { navigator.clipboard.writeText(JSON.stringify(mapboxRawResults, null, 2)); const btn = document.getElementById('copy-mapbox-results-btn'); btn.textContent = '✅'; setTimeout(() => btn.textContent = 'Copy', 2000); });

document.getElementById('poi-density-select').addEventListener('change', (e) => { applyPoiDensity(Number(e.target.value)); });
document.getElementById('bbox-toggle-btn').addEventListener('click', toggleBbox);

document.getElementById('radius-select').addEventListener('change', (e) => {
  const ci = document.getElementById('radius-custom');
  if (e.target.value === 'custom') { ci.style.display = 'block'; ci.focus(); }
  else { ci.style.display = 'none'; applyRadius(Number(e.target.value)); }
});
document.getElementById('radius-custom').addEventListener('change', (e) => { const v = Number(e.target.value); if (v > 0) applyRadius(v); });
document.getElementById('radius-custom').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const v = Number(e.target.value); if (v > 0) applyRadius(v); } });

// ============================================================
// TILEQUERY (Right-click context menu)
// ============================================================
const LS_TILEQUERY = 'apc_tilequery_settings';
const MAPBOX_STREETS_LAYERS = [
  'landuse_overlay', 'landuse', 'waterway', 'water', 'aeroway',
  'structure', 'building', 'road', 'admin',
  'place_label', 'airport_label', 'transit_stop_label', 'poi_label',
  'motorway_junction', 'housenum_label', 'natural_label'
];
const DEFAULT_TQ_SETTINGS = {
  radius: 500,
  limit:  50,
  layers: ['poi_label', 'transit_stop_label', 'airport_label']
};

let tilequerySettings = structuredClone(DEFAULT_TQ_SETTINGS);
let lastRightClick    = null;
let googleInfoWindow  = null;
let mapboxBubble      = null;

function loadTilequerySettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_TILEQUERY) || 'null');
    if (saved && typeof saved === 'object') {
      tilequerySettings = {
        radius: Number.isFinite(saved.radius) ? saved.radius : DEFAULT_TQ_SETTINGS.radius,
        limit:  Number.isFinite(saved.limit)  ? saved.limit  : DEFAULT_TQ_SETTINGS.limit,
        layers: Array.isArray(saved.layers) && saved.layers.length > 0
                  ? saved.layers : [...DEFAULT_TQ_SETTINGS.layers],
      };
    }
  } catch {}
}
function saveTilequerySettings() {
  localStorage.setItem(LS_TILEQUERY, JSON.stringify(tilequerySettings));
}

async function fetchTilequery(lat, lng, limitOverride) {
  const layers = (tilequerySettings.layers?.length ? tilequerySettings.layers : ['poi_label']).join(',');
  const limit  = limitOverride ?? tilequerySettings.limit;
  const radius = tilequerySettings.radius;
  const url = `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery/${lng},${lat}.json`
            + `?radius=${radius}&limit=${limit}&dedupe&geometry=point`
            + `&layers=${encodeURIComponent(layers)}&access_token=${MAPBOX_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Tilequery error: ${res.status} ${await res.text()}`);
  return res.json();
}

function buildBubbleHTML(names, header) {
  if (!names || names.length === 0) {
    return `<div style="font-size:11px;color:#666;padding:4px 6px;max-width:320px;">
              <div style="font-size:10px;color:#999;margin-bottom:4px;">${header}</div>
              該当なし
            </div>`;
  }
  return `<div style="font-size:12px;color:#222;padding:4px 6px;max-width:320px;line-height:1.5;">
            <div style="font-size:10px;color:#888;margin-bottom:4px;">${header}</div>
            ${names.join('、')}
          </div>`;
}

function showBubble(side, lat, lng, html) {
  if (side === 'google') {
    if (googleInfoWindow) googleInfoWindow.close();
    googleInfoWindow = new google.maps.InfoWindow({ position: { lat, lng }, content: html });
    googleInfoWindow.open(googleMap);
  } else {
    if (mapboxBubble) mapboxBubble.remove();
    mapboxBubble = new mapboxgl.Popup({ closeButton: true, maxWidth: '360px', offset: 6 })
      .setLngLat([lng, lat]).setHTML(html).addTo(mapboxMap);
  }
}

async function runTilequery(mode) {
  if (!lastRightClick) return;
  const { lat, lng, side } = lastRightClick;
  const limit = mode === 'all' ? 50 : tilequerySettings.limit;

  try {
    const data  = await fetchTilequery(lat, lng, limit);
    const feats = data.features ?? [];

    if (mode === 'all') {
      const names = feats.map(f => f?.properties?.name_ja).filter(Boolean);
      const header = `Tilequery 全件 (${names.length}件 / radius=${tilequerySettings.radius}m, limit=${limit})`;
      showBubble(side, lat, lng, buildBubbleHTML(names, header));
    } else {
      const filtered = feats.filter(f => {
        const p = f?.properties || {};
        return p.type === 'Mall' || p.type === 'Department store';
      });
      const names = filtered.map(f => f?.properties?.name_ja).filter(Boolean);
      if (names.length === 0) return;
      const header = `Mall / Department store (${names.length}件)`;
      showBubble(side, lat, lng, buildBubbleHTML(names, header));
    }
  } catch (e) {
    alert('Tilequery失敗: ' + e.message);
  }
}

function showCtxMenu(x, y) {
  const menu = document.getElementById('ctx-menu');
  menu.style.display = 'block';
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth  - rect.width  - 4) + 'px';
  menu.style.top  = Math.min(y, window.innerHeight - rect.height - 4) + 'px';
}
function hideCtxMenu() {
  document.getElementById('ctx-menu').style.display = 'none';
}

function initContextMenu() {
  const menu = document.getElementById('ctx-menu');

  document.addEventListener('click',   (e) => { if (!menu.contains(e.target)) hideCtxMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtxMenu(); });
  window.addEventListener('blur', hideCtxMenu);

  menu.querySelectorAll('.ctx-item').forEach(item => {
    item.addEventListener('click', () => {
      const action = item.dataset.action;
      hideCtxMenu();
      if (action === 'tilequery')          runTilequery('filter');
      else if (action === 'tilequery-all') runTilequery('all');
      else if (action === 'settings')      openTilequerySettings();
    });
  });

  const gDiv = document.getElementById('google-map');
  const mDiv = document.getElementById('mapbox-map');
  gDiv?.addEventListener('contextmenu', (e) => e.preventDefault());
  mDiv?.addEventListener('contextmenu', (e) => e.preventDefault());

  if (googleMap) {
    googleMap.addListener('contextmenu', (e) => {
      if (!e.latLng) return;
      const dom = e.domEvent;
      dom?.preventDefault?.();
      lastRightClick = { lat: e.latLng.lat(), lng: e.latLng.lng(), side: 'google' };
      showCtxMenu(dom?.clientX ?? 100, dom?.clientY ?? 100);
    });
  }

  const attachMapboxCtx = () => {
    if (!mapboxMap) return;
    try {
      mapboxMap.on('contextmenu', (e) => {
        e.originalEvent?.preventDefault?.();
        lastRightClick = { lat: e.lngLat.lat, lng: e.lngLat.lng, side: 'mapbox' };
        showCtxMenu(e.originalEvent.clientX, e.originalEvent.clientY);
      });
    } catch (err) {
      console.warn('[ctxmenu] mapbox attach failed:', err);
    }
  };
  if (mapboxMap?.loaded?.()) attachMapboxCtx();
  else mapboxMap?.once('load', attachMapboxCtx);
}

// ============================================================
// TILEQUERY SETTINGS DIALOG
// ============================================================
function buildLayerCheckboxes() {
  const container = document.getElementById('tq-layers-checkboxes');
  container.innerHTML = MAPBOX_STREETS_LAYERS.map(layer => `
    <label>
      <input type="checkbox" value="${layer}" ${tilequerySettings.layers.includes(layer) ? 'checked' : ''} />
      <span>${layer}</span>
    </label>
  `).join('');
}
function openTilequerySettings() {
  document.getElementById('tq-radius').value = tilequerySettings.radius;
  document.getElementById('tq-limit').value  = tilequerySettings.limit;
  buildLayerCheckboxes();
  document.getElementById('tilequery-settings-dialog').classList.add('open');
}
function saveTilequerySettingsFromForm() {
  const r = parseFloat(document.getElementById('tq-radius').value);
  const l = parseInt(document.getElementById('tq-limit').value, 10);
  const layers = Array.from(
    document.querySelectorAll('#tq-layers-checkboxes input[type=checkbox]:checked')
  ).map(c => c.value);
  if (!Number.isFinite(r) || r < 0)  { alert('Radiusが不正です'); return; }
  if (!Number.isInteger(l) || l < 1) { alert('Limitが不正です'); return; }
  if (layers.length === 0)           { alert('Layersを1つ以上選択してください'); return; }
  tilequerySettings = { radius: r, limit: l, layers };
  saveTilequerySettings();
  closeDialog('tilequery-settings-dialog');
}
document.getElementById('tq-save').addEventListener('click', saveTilequerySettingsFromForm);

// ============================================================
// APP START
// ============================================================
function startApp() {
  const hasUrlState = readFromURL();
  let restoredFromCache = false;

  if (!hasUrlState) {
    const last = loadLastResult();
    if (last) {
      state.query = last.query || '';
      googleApiMode = last.mode || googleApiMode;
      state.googleParams = last.googleParams || state.googleParams;
      state.mapboxParams = last.mapboxParams || state.mapboxParams;
      googleRawResults = last.googleRawResults || [];
      mapboxRawResults = last.mapboxRawResults || [];
      restoredFromCache = true;
    }
  }

  if (state.query) document.getElementById('query-input').value = state.query;
  updateModeBadge();
  initCSV();
  loadTilequerySettings();

  loadGoogleMaps().then(async () => {
    initMapboxMap();
    await initGoogleMap();
    initResizers();
    updateBboxBtn();
    initContextMenu();
    initParamUIControls();
    setTimeout(() => initEditors(() => { refreshParamUI('google'); refreshParamUI('mapbox'); }), 100);

    if (restoredFromCache) {
      renderGoogleResults(googleRawResults);
      renderMapboxResults(mapboxRawResults);
      if (!googleRawResults.error) plotGoogleMarkers(googleRawResults);
      if (!mapboxRawResults.error) plotMapboxMarkers(mapboxRawResults);
      updateNameStrips();
      fitResultsBounds();
      updateResultEditors();
      // 前回セッションのキャッシュ復元時点ではCSVは未読込のため、クエリ単体としてフィードバック待ちにする
      feedbackContext = { fileId: null, fileName: null, rowIndex: null, query: state.query, roundId: newRoundId() };
      feedbackPanelMode = 'start';
      renderFeedbackPanel();
    } else if (state.query) {
      doSearch();
    }
  });
}

// ============================================================
// INIT
// ============================================================
initSetup();
