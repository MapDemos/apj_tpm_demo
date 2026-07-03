/**
 * Emergency Location Finder - Main Application
 *
 * Orchestrates UI, Mapbox GL JS map, and Claude AI agent.
 * Provides frontend map-visualization tools to Claude alongside
 * the data-fetching tools from MapboxMCPClient.
 *
 * Based on spec §5: フロントエンド地図連動仕様
 *
 * Modeled after JapanDayTripApp from the reference project,
 * but self-contained (no @mapdemos/ai-framework dependency).
 *
 * Requires (loaded via script tags before this file):
 *   config.js, prompts/prompt.js,
 *   modules/spatial-utils.js, modules/mapbox-mcp.js
 */

class LocationFinderApp {

  constructor() {
    this.config    = CONFIG;
    this.mapboxMCP = null;  // initialized in initialize()

    // Map state
    this.map              = null;
    this.candidateMarkers = [];
    this.finalMarker      = null;
    this._mapLayerRegistry = []; // { layers:[{id,type}], sources:[id], gen:N }
    this._mapGen           = 0;  // current generation (increments each user send)

    // Conversation history for Claude
    this.messages = [];

    // Language state
    this._lang = 'ja';

    // Token tracking
    this._tokens = { input: 0, output: 0 };

    // Debug step mode
    this._debugMode       = false;
    this._debugStepResolve = null;
    this._debugPauseCount = 0;

    // Hint system
    this._hintResolve = null;

    // Probable area
    this._probableAreaActive = false;

    // Current agent loop turn (for layer metadata)
    this._currentTurn = 0;

  }

  // ═══════════════════════════════════════════════════════════════
  // Initialization
  // ═══════════════════════════════════════════════════════════════

  async initialize() {
    try {
      // 1. Init Mapbox MCP (data-fetching tools)
      this.mapboxMCP = new MapboxMCPClient(this.config, this);
      await this.mapboxMCP.initialize();

      // 2. Init Mapbox GL JS map
      await this._initMap();

      // 3. Wire up UI event listeners
      this._setupEventListeners();

      // 4. Show model name in header
      const modelEl = document.getElementById('model-badge');
      if (modelEl) modelEl.textContent = this.config.CLAUDE_MODEL;

      // 5. Welcome message
      this.addMessage('assistant', LANG[this._lang].welcome);

    } catch (err) {
      console.error('[App] initialize() failed:', err);
      this.addMessage('error', `初期化エラー: ${err.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Map init
  // ─────────────────────────────────────────────────────────────

  async _initMap() {
    mapboxgl.accessToken = this.config.MAPBOX_ACCESS_TOKEN;

    this.map = new mapboxgl.Map({
      container:          'map',
      style:              this.config.MAP_STYLE,
      center:             this.config.DEFAULT_MAP_CENTER,
      zoom:               this.config.DEFAULT_MAP_ZOOM,
      language:           this._lang,
      attributionControl: false,
    });

    this.map.addControl(new mapboxgl.NavigationControl({ visualizePitch: false }), 'top-right');
    this.map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');

    return new Promise(resolve => this.map.on('load', () => {
      document.getElementById('mapStatus').textContent = '地図の準備ができました';
      this._initDebugLayers();
      resolve();
    }));
  }

  // ─────────────────────────────────────────────────────────────
  // UI events
  // ─────────────────────────────────────────────────────────────

  _setupEventListeners() {
    const input   = document.getElementById('chatInput');
    const sendBtn = document.getElementById('sendBtn');

    sendBtn.addEventListener('click', () => this._handleSend());

    // Double-Enter to send: first Enter = newline, second Enter on empty line = send
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        const val = input.value;
        if (val.endsWith('\n') && val.trim() !== '') {
          e.preventDefault();
          this._handleSend();
        }
        // Otherwise let the browser insert the newline naturally
      }
    });

    // Auto-resize textarea
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });

    document.getElementById('clearChatBtn').addEventListener('click', () => this._resetChat());

    document.getElementById('lang-toggle').addEventListener('click', () => {
      this._lang = this._lang === 'ja' ? 'en' : 'ja';
      this._applyLanguage(this._lang);
    });

    // Thinking float widget toggle
    const toggleLog = () => {
      const log  = document.getElementById('thinkingLog');
      const btn  = document.getElementById('thinkingToggleBtn');
      const open = log.style.display === 'none';
      log.style.display  = open ? 'block' : 'none';
      btn.textContent    = open ? '▼' : '▲';
    };
    document.getElementById('thinkingBadge')?.addEventListener('click', toggleLog);
    document.getElementById('thinkingCollapseBtn')?.addEventListener('click', toggleLog);

    document.getElementById('debugToggleBtn').addEventListener('click', () => {
      this._debugMode = !this._debugMode;
      const btn = document.getElementById('debugToggleBtn');
      btn.textContent = this._debugMode ? LANG[this._lang].debugOn : LANG[this._lang].debugOff;
      btn.classList.toggle('active', this._debugMode);
      // If turning off mid-pause, resume immediately
      if (!this._debugMode && this._debugStepResolve) {
        this._debugStepResolve();
        this._debugStepResolve = null;
      }
    });

    // Example chips
    document.querySelectorAll('.example-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        input.value = btn.dataset.q;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        input.focus();
      });
    });
  }

  async _handleSend() {
    const input   = document.getElementById('chatInput');
    const sendBtn = document.getElementById('sendBtn');
    const text    = input.value.trim();
    if (!text) return;

    // Hide examples on first send
    const examples = document.getElementById('examplesArea');
    if (examples) examples.style.display = 'none';

    input.value      = '';
    sendBtn.disabled = true;
    input.disabled   = true;

    this.addMessage('user', text);
    this._advanceMapGen();
    this._showThinking(LANG[this._lang].connecting);

    try {
      await this.processUserMessage(text);
    } catch (err) {
      this.addMessage('error', `エラー: ${err.message}`);
    } finally {
      this._hideThinking();
      sendBtn.disabled = false;
      input.disabled   = false;
      input.focus();
    }
  }

  _resetChat() {
    this.messages = [];
    this._tokens  = { input: 0, output: 0 };
    this._updateTokenDisplay();
    if (this.mapboxMCP) {
      this.mapboxMCP._sbRequests  = 0;
      this.mapboxMCP._tqRequests  = 0;
      this.mapboxMCP._tqCacheHits = 0;
      this.mapboxMCP._tqCache.clear();
      this.mapboxMCP._poiGridCache?.clear();
    }
    this._updateAPICountDisplay();
    // Resolve any pending debug pause
    if (this._debugStepResolve) { this._debugStepResolve(); this._debugStepResolve = null; }
    // Resolve any pending hint request
    if (this._hintResolve) { this._hintResolve(null); this._hintResolve = null; }
    // Remove probable area polygon
    this._removeProbableArea();
    this.clearMapElements();
    this._clearDebugLayers();
    if (this.finalMarker) { this.finalMarker.remove(); this.finalMarker = null; }
    document.getElementById('resolutionPanel')?.remove();
    document.getElementById('chatMessages').innerHTML = '';
    document.getElementById('thinkingSteps').innerHTML = '';
    document.getElementById('mapStatus').textContent = '地図の準備ができました';
    const examples = document.getElementById('examplesArea');
    if (examples) examples.style.display = '';
    this.addMessage('assistant', LANG[this._lang].welcome);
  }

  // ═══════════════════════════════════════════════════════════════
  // Frontend Map-Visualization Tools (exposed to Claude via tools array)
  // Based on spec §5: リアクティブ地図操作ツール
  // ═══════════════════════════════════════════════════════════════

  /**
   * draw_search_boundary
   * Renders a semi-transparent blue polygon showing the search area.
   * @param {number[]} bbox - [minX, minY, maxX, maxY]
   */
  drawSearchBoundary(rawBbox) {
    // Enforce ±500m max (same cap as MCP side)
    const bbox = _capBBoxFE(rawBbox);
    const [minX, minY, maxX, maxY] = bbox;
    const idx = this._mapLayerRegistry.length;
    const p   = `bbox-${idx}`;

    const midLat = (minY + maxY) / 2;
    const wm = Math.round(Math.abs(maxX - minX) * 111320 * Math.cos(midLat * Math.PI / 180));
    const hm = Math.round(Math.abs(maxY - minY) * 110540);
    const sbLabel = wm === hm ? `${wm}m` : `${wm}×${hm}m`;

    const meta = { tool: 'draw_search_boundary', turn: this._currentTurn, params: sbLabel };

    const geojson = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[ [minX,minY],[maxX,minY],[maxX,maxY],[minX,maxY],[minX,minY] ]],
        },
        properties: meta,
      }],
    };

    this.map.addSource(`${p}-poly`, { type: 'geojson', data: geojson });
    this.map.addLayer({ id: `${p}-fill`, type: 'fill', source: `${p}-poly`,
      paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.12 } });
    this.map.addLayer({ id: `${p}-line`, type: 'line', source: `${p}-poly`,
      paint: { 'line-color': '#60a5fa', 'line-width': 2, 'line-dasharray': [4, 2] } });

    this.map.on('click', `${p}-fill`, (e) => this._showLayerPopup(e.lngLat, e.features[0].properties));
    this.map.on('mouseenter', `${p}-fill`, () => { this.map.getCanvas().style.cursor = 'pointer'; });
    this.map.on('mouseleave', `${p}-fill`, () => { this.map.getCanvas().style.cursor = ''; });

    this.map.addSource(`${p}-lbl`, { type: 'geojson', data: {
      type: 'FeatureCollection',
      features: [{ type: 'Feature',
        geometry: { type: 'Point', coordinates: [(minX + maxX) / 2, maxY] },
        properties: { label: sbLabel } }],
    }});
    this.map.addLayer({ id: `${p}-sym`, type: 'symbol', source: `${p}-lbl`,
      layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-anchor': 'bottom',
                'text-offset': ['literal', [0, -0.3]],
                'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': '#60a5fa', 'text-halo-color': 'rgba(8,13,26,0.9)', 'text-halo-width': 1.5 } });

    this._mapLayerRegistry.push({
      layers:  [{ id: `${p}-fill`, type: 'fill' }, { id: `${p}-line`, type: 'line' },
                { id: `${p}-sym`,  type: 'symbol' }],
      sources: [`${p}-poly`, `${p}-lbl`],
      gen:     this._mapGen,
    });

    this.map.fitBounds([[minX, minY], [maxX, maxY]], { padding: 70, duration: 1200 });

    return '検索範囲を地図に描画しました';
  }

  /**
   * add_candidate_markers
   * Plots numbered pins for each candidate POI with priority labels.
   * Array order = priority order (index 0 = 最有力候補).
   * @param {object[]} places - [{ name, latitude, longitude, address?, reason? }]
   */
  addCandidateMarkers(places) {
    this.candidateMarkers.forEach(m => m.remove());
    this.candidateMarkers = [];

    places.forEach((place, i) => {
      const isFull = place.match_level === 'full';
      const badgeClass = isFull ? 'match-full' : 'match-partial';
      const badgeLabel = isFull ? '🟢 条件合致' : '🟡 一部合致';

      const el = document.createElement('div');
      el.className = `candidate-marker ${isFull ? 'priority-1' : 'priority-2'}`;
      el.textContent = i + 1;
      el.title = place.name;

      const popupHTML =
        `<div class="${badgeClass}">${badgeLabel}</div>` +
        `<strong>${_esc(place.name)}</strong>` +
        (place.address ? `<div class="popup-address">${_esc(place.address)}</div>` : '') +
        (place.reason  ? `<div class="popup-reason">💡 ${_esc(place.reason)}</div>` : '');

      const popup = new mapboxgl.Popup({ offset: 30, closeButton: false })
        .setHTML(popupHTML);

      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat(_safeLL(place.longitude, place.latitude))
        .setPopup(popup)
        .addTo(this.map);

      el.addEventListener('click', () => marker.togglePopup());
      this.candidateMarkers.push(marker);
    });

    if (places.length === 1) {
      this.map.flyTo({ center: [places[0].longitude, places[0].latitude], zoom: 16, duration: 1000 });
    } else if (places.length > 1) {
      const bounds = places.reduce(
        (b, p) => b.extend([p.longitude, p.latitude]),
        new mapboxgl.LngLatBounds(
          [places[0].longitude, places[0].latitude],
          [places[0].longitude, places[0].latitude]
        )
      );
      this.map.fitBounds(bounds, { padding: 90, maxZoom: 17, duration: 1200 });
    }

    const firstFull = this.candidateMarkers.findIndex((_, i) => places[i]?.match_level === 'full');
    const autoOpen = firstFull >= 0 ? firstFull : 0;
    if (places.length >= 2 && this.candidateMarkers[autoOpen]) {
      setTimeout(() => this.candidateMarkers[autoOpen].togglePopup(), 1400);
    }

    const fullCount    = places.filter(p => p.match_level === 'full').length;
    const partialCount = places.filter(p => p.match_level === 'partial').length;
    return `条件合致${fullCount}件、一部合致${partialCount}件を地図にプロット`;
  }

  /**
   * clear_map_elements
   * Removes all search-boundary polygons and candidate markers.
   */
  clearMapElements() {
    this.candidateMarkers.forEach(m => m.remove());
    this.candidateMarkers = [];
    this._removeProbableArea();
    this._clearMapLayers();
    return 'マップ要素をクリアしました';
  }

  /**
   * finalize_location_marker
   * Plants the confirmed 📍 pin and flies the camera in.
   * @param {number} lat
   * @param {number} lng
   * @param {string} address
   */
  finalizeLocationMarker(lat, lng, address) {
    if (this.finalMarker) { this.finalMarker.remove(); this.finalMarker = null; }

    const el = document.createElement('div');
    el.className   = 'final-marker';
    el.textContent = '📍';

    const popup = new mapboxgl.Popup({ offset: [0, -20], closeOnClick: false })
      .setHTML(
        `<span class="popup-confirmed">確定</span>` +
        `<br><strong>${_esc(address)}</strong>` +
        `<div class="popup-address">${lat.toFixed(6)}, ${lng.toFixed(6)}</div>`
      );

    this.finalMarker = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat(_safeLL(lng, lat))
      .setPopup(popup)
      .addTo(this.map);

    this.finalMarker.togglePopup();

    this.map.flyTo({ center: _safeLL(lng, lat), zoom: 17, duration: 2000, essential: true });

    document.getElementById('mapStatus').textContent = `📍 ${address}`;

    this._showResolutionPanel();
    return `確定: ${address} [${lat}, ${lng}]`;
  }

  _showResolutionPanel() {
    document.getElementById('resolutionPanel')?.remove();

    const container = document.getElementById('chatMessages');
    const wrapper = document.createElement('div');
    wrapper.id = 'resolutionPanel';
    wrapper.className = 'message resolution-panel';
    wrapper.innerHTML = `
      <div class="resolution-buttons">
        <button class="resolution-btn ok" id="resBtn-ok">✅ OK確定</button>
        <button class="resolution-btn retry" id="resBtn-retry">🔄 やり直し</button>
        <button class="resolution-btn give-up" id="resBtn-giveup">⏹ 諦める</button>
      </div>
    `;
    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;

    document.getElementById('resBtn-ok').addEventListener('click', () => {
      wrapper.remove();
      document.getElementById('mapStatus').textContent = '✅ 捜索完了';
      this._disableInput();
    });

    document.getElementById('resBtn-retry').addEventListener('click', () => {
      wrapper.remove();
      if (this.finalMarker) { this.finalMarker.remove(); this.finalMarker = null; }
      document.getElementById('mapStatus').textContent = '地図の準備ができました';
      this._enableInput();
    });

    document.getElementById('resBtn-giveup').addEventListener('click', () => {
      wrapper.remove();
      document.getElementById('mapStatus').textContent = '⏹ 未解決';
      this._disableInput();
    });
  }

  _disableInput() {
    document.getElementById('chatInput').disabled = true;
    document.getElementById('sendBtn').disabled = true;
  }

  _enableInput() {
    document.getElementById('chatInput').disabled = false;
    document.getElementById('sendBtn').disabled = false;
    document.getElementById('chatInput').focus();
  }

  // ─────────────────────────────────────────────────────────────
  // Internal: boundary layer cleanup
  // ─────────────────────────────────────────────────────────────

  _removeBoundaryLayers() {
    ['search-boundary-fill', 'search-boundary-line', 'sb-label-sym'].forEach(id => {
      try { this.map.removeLayer(id); } catch (_) {}
    });
    ['search-boundary', 'sb-label'].forEach(id => {
      try { this.map.removeSource(id); } catch (_) {}
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Debug visualization layers
  // ─────────────────────────────────────────────────────────────


  /** Initialize persistent GeoJSON sources/layers for debug visualization. */
  _initDebugLayers() {
    this._dbg = {
      proximity:   { type: 'FeatureCollection', features: [] },
      searchHits:  { type: 'FeatureCollection', features: [] },
      tqHits:      { type: 'FeatureCollection', features: [] },
      bboxes:      { type: 'FeatureCollection', features: [] },
      bboxLabels:  { type: 'FeatureCollection', features: [] },
      clusters:    { type: 'FeatureCollection', features: [] },  // DBSCAN cluster centers
      routeBuf:    { type: 'FeatureCollection', features: [] },
      routeLine:   { type: 'FeatureCollection', features: [] },
      routeLabels: { type: 'FeatureCollection', features: [] },
    };

    const add = (id, data, layers) => {
      this.map.addSource(id, { type: 'geojson', data });
      layers.forEach(l => this.map.addLayer({ source: id, ...l }));
    };

    // Orange: proximity center point
    add('dbg-proximity', this._dbg.proximity, [{
      id: 'dbg-proximity-c', type: 'circle',
      paint: { 'circle-radius': 8, 'circle-color': '#f97316', 'circle-opacity': 0.95,
               'circle-stroke-width': 2, 'circle-stroke-color': '#fff' },
    }]);

    // Orange dashed: search bbox
    add('dbg-bboxes', this._dbg.bboxes, [{
      id: 'dbg-bboxes-l', type: 'line',
      paint: { 'line-color': '#f97316', 'line-width': 1.5,
               'line-dasharray': ['literal', [3, 2]], 'line-opacity': 0.75 },
    }]);

    // Teal: Search Box hit points + labels
    add('dbg-search-hits', this._dbg.searchHits, [
      {
        id: 'dbg-search-hits-c', type: 'circle',
        paint: { 'circle-radius': 5, 'circle-color': '#06b6d4', 'circle-opacity': 0.8,
                 'circle-stroke-width': 1, 'circle-stroke-color': '#fff' },
      },
      {
        id: 'dbg-search-hits-l', type: 'symbol',
        layout: {
          'text-field':            ['get', 'name'],
          'text-size':             10,
          'text-offset':           ['literal', [0.7, 0]],
          'text-anchor':           'left',
          'text-allow-overlap':    false,
          'text-ignore-placement': false,
          'text-max-width':        8,
        },
        paint: {
          'text-color':       '#06b6d4',
          'text-halo-color':  'rgba(8,13,26,0.85)',
          'text-halo-width':  1.2,
        },
      },
    ]);

    // Purple: Tilequery hit points + labels
    add('dbg-tq-hits', this._dbg.tqHits, [
      {
        id: 'dbg-tq-hits-c', type: 'circle',
        paint: { 'circle-radius': 5, 'circle-color': '#a855f7', 'circle-opacity': 0.8,
                 'circle-stroke-width': 1, 'circle-stroke-color': '#fff' },
      },
      {
        id: 'dbg-tq-hits-l', type: 'symbol',
        layout: {
          'text-field':            ['get', 'name'],
          'text-size':             10,
          'text-offset':           ['literal', [0.7, 0]],
          'text-anchor':           'left',
          'text-allow-overlap':    false,
          'text-ignore-placement': false,
          'text-max-width':        8,
        },
        paint: {
          'text-color':       '#c084fc',
          'text-halo-color':  'rgba(8,13,26,0.85)',
          'text-halo-width':  1.2,
        },
      },
    ]);

    // Violet: Route corridor buffer fill + route line
    // Primary = 不透明・太い / 代替ルート = 半透明・細い
    add('dbg-route-buf', this._dbg.routeBuf, [{
      id: 'dbg-route-buf-f', type: 'fill',
      paint: {
        'fill-color': '#8b5cf6',
        'fill-opacity': ['case', ['get', 'primary'], 0.15, 0.07],
      },
    }]);
    add('dbg-route-line', this._dbg.routeLine, [{
      id: 'dbg-route-line-l', type: 'line',
      paint: {
        'line-color': '#8b5cf6',
        'line-width':   ['case', ['get', 'primary'], 6, 3],
        'line-opacity': ['case', ['get', 'primary'], 1.0, 0.5],
        'line-dasharray': ['case', ['get', 'primary'], ['literal', [1]], ['literal', [4, 2]]],
      },
    }]);

    // Size labels for bboxes (shown outside top edge)
    const labelPaint = {
      'text-color':      '#f97316',
      'text-halo-color': 'rgba(8,13,26,0.9)',
      'text-halo-width': 1.5,
    };
    const labelLayout = (anchor, offset) => ({
      'text-field':            ['get', 'label'],
      'text-size':             11,
      'text-font':             ['literal', ['DIN Offc Pro Medium', 'Arial Unicode MS Bold']],
      'text-anchor':           anchor,
      'text-offset':           ['literal', offset],
      'text-allow-overlap':    true,
      'text-ignore-placement': true,
    });

    add('dbg-bbox-labels', this._dbg.bboxLabels, [{
      id: 'dbg-bbox-labels-sym', type: 'symbol',
      layout: labelLayout('bottom', [0, -0.4]),
      paint: labelPaint,
    }]);

    add('dbg-route-labels', this._dbg.routeLabels, [{
      id: 'dbg-route-labels-sym', type: 'symbol',
      layout: { ...labelLayout('left', [0.5, 0]), 'text-color': '#8b5cf6' },
      paint: { ...labelPaint, 'text-color': '#c084fc' },
    }]);

    // Cluster centers: hollow ring (no fill) + Cxx label
    // Deliberately NOT a filled circle to distinguish from candidate markers
    add('dbg-clusters', this._dbg.clusters, [
      {
        id: 'dbg-clusters-ring', type: 'circle',
        paint: {
          'circle-radius':         14,
          'circle-color':          'transparent',
          'circle-opacity':        0,
          'circle-stroke-width':   2.5,
          'circle-stroke-color':   '#f59e0b',
          'circle-stroke-opacity': 0.9,
        },
      },
      {
        id: 'dbg-clusters-label', type: 'symbol',
        layout: {
          'text-field':            ['concat', 'C', ['to-string', ['get', 'cid']]],
          'text-size':             10,
          'text-font':             ['literal', ['DIN Offc Pro Medium', 'Arial Unicode MS Bold']],
          'text-offset':           ['literal', [1.8, 0]],
          'text-anchor':           'left',
          'text-allow-overlap':    true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color':       '#f59e0b',
          'text-halo-color':  'rgba(8,13,26,0.9)',
          'text-halo-width':  1.2,
        },
      },
    ]);
  }

  /** Reset all debug layers to empty. */
  _clearDebugLayers() {
    if (!this._dbg) return;
    Object.keys(this._dbg).forEach(k => { this._dbg[k].features = []; });
    ['dbg-proximity','dbg-bboxes','dbg-bbox-labels','dbg-search-hits','dbg-clusters','dbg-tq-hits','dbg-route-buf','dbg-route-line','dbg-route-labels'].forEach(id => {
      try { this.map.getSource(id)?.setData({ type: 'FeatureCollection', features: [] }); } catch(_){}
    });
    document.getElementById('mapLegend').style.display = 'none';
  }

  _dbgAddPoint(sourceId, stateKey, lng, lat, props = {}) {
    if (!this._dbg) return;
    this._dbg[stateKey].features.push({
      type: 'Feature', geometry: { type: 'Point', coordinates: _safeLL(lng, lat) }, properties: props,
    });
    try { this.map.getSource(sourceId)?.setData(this._dbg[stateKey]); } catch(_){}
    document.getElementById('mapLegend').style.display = 'block';
  }

  _dbgAddBbox(bbox) {
    if (!this._dbg || !bbox || bbox.length < 4) return;
    const [minX, minY, maxX, maxY] = bbox;
    this._dbg.bboxes.features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[[minX,minY],[maxX,minY],[maxX,maxY],[minX,maxY],[minX,minY]]] },
      properties: {},
    });
    try { this.map.getSource('dbg-bboxes')?.setData(this._dbg.bboxes); } catch(_){}

    // Size label at top-center of the bbox
    const midLat = (minY + maxY) / 2;
    const wm = Math.round(Math.abs(maxX - minX) * 111320 * Math.cos(midLat * Math.PI / 180));
    const hm = Math.round(Math.abs(maxY - minY) * 110540);
    const label = wm === hm ? `${wm}m` : `${wm}×${hm}m`;
    this._dbg.bboxLabels.features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [(minX + maxX) / 2, maxY] },
      properties: { label },
    });
    try { this.map.getSource('dbg-bbox-labels')?.setData(this._dbg.bboxLabels); } catch(_){}
    document.getElementById('mapLegend').style.display = 'block';
  }

  /** Visualize Search Box args (proximity/bbox) before the tool call. */
  _visualizeSearchArgs(toolName, args) {
    if (toolName === 'search_nearby_poi') {
      if (args.proximity?.length >= 2) {
        this._dbgAddPoint('dbg-proximity', 'proximity', args.proximity[0], args.proximity[1], { type: 'proximity' });
      }
      if (args.bbox) this._dbgAddBbox(args.bbox);
    }
    // Show A/B endpoints for route tool
    if (toolName === 'get_route_pois') {
      if (args.from_lat && args.from_lng)
        this._dbgAddPoint('dbg-proximity', 'proximity', args.from_lng, args.from_lat, { type: 'route_from' });
      if (args.to_lat && args.to_lng)
        this._dbgAddPoint('dbg-proximity', 'proximity', args.to_lng, args.to_lat, { type: 'route_to' });
    }
  }

  /** Visualize tool results (hit points) after the tool call. */
  _visualizeToolResult(toolName, resultStr) {
    try {
      const result = JSON.parse(resultStr);
      if (toolName === 'search_nearby_poi') {
        (result.items || []).forEach(item => {
          if (item.longitude != null && item.latitude != null) {
            this._dbgAddPoint('dbg-search-hits', 'searchHits', item.longitude, item.latitude, { name: item.name || '' });
          }
        });
      }
      if (toolName === 'scan_street_features' || toolName === 'get_facing_road') {
        (result.items || result.all_roads || []).forEach(item => {
          if (item.coords?.length >= 2) {
            this._dbgAddPoint('dbg-tq-hits', 'tqHits', item.coords[0], item.coords[1], { name: item.name || '', layer: item.layer || '' });
          }
        });
      }
      // Draw route corridor from stored geometry (not in result JSON)
      if (toolName === 'get_route_pois' && this.mapboxMCP._lastRouteData) {
        const { routesCoords, bufferMeters } = this.mapboxMCP._lastRouteData;
        this._drawRouteOnMap(routesCoords, bufferMeters);
        this.mapboxMCP._lastRouteData = null;
      }
    } catch(_) {}
  }

  /** Draw Directions API routes (primary + alternatives) + Turf buffer corridors on map. */
  _drawRouteOnMap(routesCoords, bufferMeters) {
    if (!routesCoords?.length) return;

    // Build FeatureCollections: primary route first, then alternatives
    const lineFeatures = routesCoords.map((coords, i) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: { primary: i === 0, route_index: i },
    }));
    const bufFeatures = routesCoords.map((coords, i) => {
      const f = turf.buffer(turf.lineString(coords), bufferMeters, { units: 'meters' });
      f.properties = { primary: i === 0, route_index: i };
      return f;
    });

    this._dbg.routeLine.features = lineFeatures;
    this._dbg.routeBuf.features  = bufFeatures;
    try {
      this.map.getSource('dbg-route-line')?.setData(this._dbg.routeLine);
      this.map.getSource('dbg-route-buf')?.setData(this._dbg.routeBuf);
    } catch(_) {}

    // Buffer width label at midpoint of primary route
    try {
      const primaryCoords = routesCoords[0];
      if (primaryCoords && primaryCoords.length >= 2) {
        const midIdx = Math.floor(primaryCoords.length / 2);
        const [midLng, midLat] = primaryCoords[midIdx];
        // Offset label slightly above the route
        const offsetLat = midLat + (bufferMeters / 110540) * 1.3;
        this._dbg.routeLabels.features = [{
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [midLng, offsetLat] },
          properties: { label: `±${bufferMeters}m` },
        }];
        this.map.getSource('dbg-route-labels')?.setData(this._dbg.routeLabels);
      }
    } catch(_) {}

    // Fit map to all routes combined
    const allCoords = routesCoords.flat();
    const bounds = allCoords.reduce(
      (b, c) => b.extend(c),
      new mapboxgl.LngLatBounds(allCoords[0], allCoords[0])
    );
    this.map.fitBounds(bounds, { padding: 100, maxZoom: 17, duration: 1000 });
    document.getElementById('mapLegend').style.display = 'block';
  }

  // ─────────────────────────────────────────────────────────────
  // Probable area polygon
  // ─────────────────────────────────────────────────────────────

  /**
   * show_probable_area: Draw a convex hull around candidates when Claude
   * cannot commit to a single location.
   */
  showProbableArea(candidates, message) {
    this._removeProbableArea();
    if (!candidates?.length) return 'candidates が空です';

    const pts = turf.featureCollection(
      candidates.map(c => turf.point(_safeLL(c.longitude, c.latitude)))
    );

    let area;
    try {
      if (candidates.length === 1) {
        area = turf.buffer(pts.features[0], 0.08, { units: 'kilometers' });
      } else {
        const hull = turf.convex(pts);
        area = hull
          ? turf.buffer(hull, 0.05, { units: 'kilometers' })
          : turf.buffer(turf.bboxPolygon(turf.bbox(pts)), 0.05, { units: 'kilometers' });
      }
    } catch(_) {
      area = turf.bboxPolygon(turf.bbox(pts));
    }

    const centroid = turf.centroid(area);
    const label    = message || 'この辺にいると思われます';

    this.map.addSource('probable-area', { type: 'geojson', data: area });
    this.map.addLayer({
      id: 'probable-area-fill', type: 'fill', source: 'probable-area',
      paint: { 'fill-color': '#ef4444', 'fill-opacity': 0.12 },
    });
    this.map.addLayer({
      id: 'probable-area-line', type: 'line', source: 'probable-area',
      paint: { 'line-color': '#ef4444', 'line-width': 2.5, 'line-dasharray': [5, 3] },
    });
    this.map.addSource('probable-area-label-src', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [{ ...centroid, properties: { label } }] },
    });
    this.map.addLayer({
      id: 'probable-area-label', type: 'symbol', source: 'probable-area-label-src',
      layout: {
        'text-field':            ['get', 'label'],
        'text-size':             13,
        'text-anchor':           'center',
        'text-allow-overlap':    true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color':       '#ef4444',
        'text-halo-color':  'rgba(8,13,26,0.92)',
        'text-halo-width':  2,
      },
    });

    this._probableAreaActive = true;

    const bbox = turf.bbox(area);
    this.map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 80, duration: 1200 });
    document.getElementById('mapStatus').textContent = `🔴 ${label}`;

    return `エリアをポリゴンで表示しました（${candidates.length}候補を包含）`;
  }

  _removeProbableArea() {
    ['probable-area-label', 'probable-area-fill', 'probable-area-line'].forEach(id => {
      try { this.map.removeLayer(id); } catch(_) {}
    });
    ['probable-area', 'probable-area-label-src'].forEach(id => {
      try { this.map.removeSource(id); } catch(_) {}
    });
    this._probableAreaActive = false;
  }

  // ─────────────────────────────────────────────────────────────
  // Map computation visualization
  // ─────────────────────────────────────────────────────────────

  /** Show map-side feedback while a tool is executing. */
  _showMapComputing(toolName, args) {
    const overlay = document.getElementById('mapComputing');
    const text    = document.getElementById('mapComputingText');
    const status  = document.getElementById('mapStatus');

    const labels = {
      get_midpoint_area:        `🗺 中間地点を計算中… (${args.placeA} ↔ ${args.placeB})`,
      search_nearby_poi:        `🔍 POI検索中… (${(Array.isArray(args.queries) ? args.queries : [args.queries].filter(Boolean)).slice(0,2).join(' / ')})`,
      scan_street_features:     `📡 半径 ${args.radius}m をスキャン中…`,
      draw_search_boundary:     '📐 検索範囲を描画中…',
      add_candidate_markers:    '📌 候補ピンを配置中…',
      clear_map_elements:       '🧹 マップをクリア中…',
      finalize_location_marker: '✅ 確定地点をマーク中…',
    };

    const msg = labels[toolName] || `${toolName} 実行中…`;
    if (text)   text.textContent   = msg;
    if (status) status.textContent = msg;
    if (overlay) overlay.style.display = 'flex';

    // Draw Tilequery radius circles on the map
    if (toolName === 'scan_street_features' && args.lat && args.lng) {
      const meta = { tool: toolName, turn: this._currentTurn, params: `r=${args.radius}m | target=${args.target || 'both'}` };
      this._drawScanCircle(args.lat, args.lng, args.radius, 'amber', meta);
      this.map.flyTo({ center: [args.lng, args.lat], zoom: Math.max(this.map.getZoom(), 14), duration: 800 });
    }

    if (toolName === 'scan_natural_features' && args.lat && args.lng) {
      const meta = { tool: toolName, turn: this._currentTurn, params: `r=${args.radius}m` };
      this._drawScanCircle(args.lat, args.lng, args.radius, 'amber', meta);
      this.map.flyTo({ center: [args.lng, args.lat], zoom: Math.max(this.map.getZoom(), 13), duration: 800 });
    }

    if (toolName === 'get_facing_road' && args.lat && args.lng) {
      const meta = { tool: toolName, turn: this._currentTurn, params: 'r=50m (自動拡張)' };
      this._drawScanCircle(args.lat, args.lng, 50, 'amber', meta);
      this.map.flyTo({ center: [args.lng, args.lat], zoom: Math.max(this.map.getZoom(), 16), duration: 600 });
    }

    // search_nearby_poi: fly to proximity, draw all Tilequery grid circles
    if (toolName === 'search_nearby_poi' && args.proximity?.length >= 2) {
      const [pLng, pLat] = args.proximity;
      this.map.flyTo({ center: [pLng, pLat], zoom: Math.max(this.map.getZoom(), 13), duration: 800 });
      // radius_metersからbboxを計算（MCP側と同じロジック）
      let vizBbox = args.bbox;
      if (args.radius_meters != null && !vizBbox) {
        const r    = Math.min(args.radius_meters, 400);
        const dLng = r / (111320 * Math.cos(pLat * Math.PI / 180));
        const dLat = r / 110540;
        vizBbox = [pLng - dLng, pLat - dLat, pLng + dLng, pLat + dLat];
        // radius_meters使用時はClaudeがdraw_search_boundaryを呼べないため自動描画
        this.drawSearchBoundary(vizBbox);
      }

      if (vizBbox?.length === 4) {
        // Replicate _gridTilequeryPOI grid logic (with inset) to show actual scan circles
        const [minX, minY, maxX, maxY] = vizBbox;
        const gridRadius = 200;
        const spacingM   = gridRadius * 1.5;
        const DEG_LNG    = 1 / (111320 * Math.cos(pLat * Math.PI / 180));
        const DEG_LAT    = 1 / 110540;
        const radiusLng  = gridRadius * DEG_LNG;
        const radiusLat  = gridRadius * DEG_LAT;
        const gMinX = minX + radiusLng, gMaxX = maxX - radiusLng;
        const gMinY = minY + radiusLat, gMaxY = maxY - radiusLat;
        const qs = Array.isArray(args.queries) ? args.queries.slice(0, 2).join(', ') + (args.queries.length > 2 ? '…' : '') : '';
        const gridMeta = { tool: toolName, turn: this._currentTurn, params: `r=200m${qs ? ` | ${qs}` : ''}` };

        if (gMinX >= gMaxX || gMinY >= gMaxY) {
          this._drawScanCircle((minY + maxY) / 2, (minX + maxX) / 2, gridRadius, 'cyan', gridMeta);
        } else {
          const widthM  = (gMaxX - gMinX) / DEG_LNG;
          const heightM = (gMaxY - gMinY) / DEG_LAT;
          const nx = Math.max(1, Math.ceil(widthM  / spacingM) + 1);
          const ny = Math.max(1, Math.ceil(heightM / spacingM) + 1);
          for (let iy = 0; iy < ny; iy++) {
            for (let ix = 0; ix < nx; ix++) {
              const gLng = nx === 1 ? (gMinX + gMaxX) / 2 : gMinX + ix * (gMaxX - gMinX) / (nx - 1);
              const gLat = ny === 1 ? (gMinY + gMaxY) / 2 : gMinY + iy * (gMaxY - gMinY) / (ny - 1);
              this._drawScanCircle(gLat, gLng, gridRadius, 'cyan', gridMeta);
            }
          }
        }
      }
    }
  }

  /** Remove map computation visuals after a tool completes. */
  _hideMapComputing() {
    const overlay = document.getElementById('mapComputing');
    if (overlay) overlay.style.display = 'none';
  }

  /** Show a popup with layer metadata (tool, turn, params). */
  _showLayerPopup(lngLat, meta) {
    const toolLabel = LANG[this._lang]?.tools?.[meta.tool] || meta.tool;
    new mapboxgl.Popup({ closeButton: true, className: 'layer-info-popup', maxWidth: '240px' })
      .setLngLat(lngLat)
      .setHTML(
        `<div class="layer-popup-tool">${_esc(toolLabel)}</div>` +
        `<div class="layer-popup-turn">ターン ${meta.turn ?? '-'}</div>` +
        (meta.params ? `<div class="layer-popup-params">${_esc(meta.params)}</div>` : '')
      )
      .addTo(this.map);
  }

  /**
   * Draw a filled circle showing the Tilequery scan radius. Accumulates with generation tracking.
   * @param {string} color - 'amber' (single-point Tilequery) or 'cyan' (grid circles)
   * @param {object|null} meta - { tool, turn, params } for click popup
   */
  _drawScanCircle(lat, lng, radiusMeters, color = 'amber', meta = null) {
    const idx    = this._mapLayerRegistry.length;
    const p      = `scan-${idx}`;
    const center = turf.point([lng, lat]);
    const circleGeom = turf.circle(center, radiusMeters / 1000, { units: 'kilometers', steps: 64 });
    const circle = {
      ...circleGeom,
      properties: meta || {},
    };

    const fillColor = color === 'cyan' ? '#06b6d4' : '#f59e0b';
    const lineColor = color === 'cyan' ? '#22d3ee' : '#f59e0b';
    const dotColor  = color === 'cyan' ? '#06b6d4' : '#f59e0b';

    this.map.addSource(`${p}-poly`, { type: 'geojson', data: circle });
    this.map.addLayer({ id: `${p}-fill`, type: 'fill', source: `${p}-poly`,
      paint: { 'fill-color': fillColor, 'fill-opacity': 0.08 } });
    this.map.addLayer({ id: `${p}-line`, type: 'line', source: `${p}-poly`,
      paint: { 'line-color': lineColor, 'line-width': 1.5, 'line-dasharray': [3, 2] } });

    if (meta) {
      this.map.on('click', `${p}-fill`, (e) => this._showLayerPopup(e.lngLat, meta));
      this.map.on('mouseenter', `${p}-fill`, () => { this.map.getCanvas().style.cursor = 'pointer'; });
      this.map.on('mouseleave', `${p}-fill`, () => { this.map.getCanvas().style.cursor = ''; });
    }

    this.map.addSource(`${p}-ctr`, { type: 'geojson', data: {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: {} }],
    }});
    this.map.addLayer({ id: `${p}-dot`, type: 'circle', source: `${p}-ctr`,
      paint: { 'circle-radius': 4, 'circle-color': dotColor, 'circle-opacity': 0.9,
               'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });

    const degsNorth = radiusMeters / 110540;
    this.map.addSource(`${p}-lbl`, { type: 'geojson', data: {
      type: 'FeatureCollection',
      features: [{ type: 'Feature',
        geometry: { type: 'Point', coordinates: [lng, lat + degsNorth] },
        properties: { label: `r=${radiusMeters}m` } }],
    }});
    this.map.addLayer({ id: `${p}-sym`, type: 'symbol', source: `${p}-lbl`,
      layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-anchor': 'bottom',
                'text-offset': ['literal', [0, -0.3]],
                'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': lineColor, 'text-halo-color': 'rgba(8,13,26,0.9)', 'text-halo-width': 1.5 } });

    this._mapLayerRegistry.push({
      layers:  [{ id: `${p}-fill`, type: 'fill' }, { id: `${p}-line`, type: 'line' },
                { id: `${p}-dot`,  type: 'circle' }, { id: `${p}-sym`, type: 'symbol' }],
      sources: [`${p}-poly`, `${p}-ctr`, `${p}-lbl`],
      gen:     this._mapGen,
    });
  }

  /** Gray-out a single layer (called when it ages one generation). */
  _grayOutLayer(id) {
    const layer = this.map.getLayer(id);
    if (!layer) return;
    try {
      switch (layer.type) {
        case 'fill':
          this.map.setPaintProperty(id, 'fill-color',   '#6b7280');
          this.map.setPaintProperty(id, 'fill-opacity',  0.06);
          break;
        case 'line':
          this.map.setPaintProperty(id, 'line-color',   '#6b7280');
          this.map.setPaintProperty(id, 'line-opacity',  0.35);
          break;
        case 'circle':
          this.map.setPaintProperty(id, 'circle-color',        '#6b7280');
          this.map.setPaintProperty(id, 'circle-opacity',       0.4);
          this.map.setPaintProperty(id, 'circle-stroke-color', '#4b5563');
          break;
        case 'symbol':
          this.map.setPaintProperty(id, 'text-color',      '#6b7280');
          this.map.setPaintProperty(id, 'text-halo-color', 'rgba(8,13,26,0.5)');
          break;
      }
    } catch (_) {}
  }

  /**
   * Called when the user sends a new message.
   * Gen-1 layers → gray out. Gen-2+ layers → remove.
   */
  _advanceMapGen() {
    this._mapGen++;
    const keep = [];
    this._mapLayerRegistry.forEach(entry => {
      const age = this._mapGen - entry.gen;
      if (age === 1) {
        // gray out
        entry.layers.forEach(({ id }) => this._grayOutLayer(id));
        keep.push(entry);
      } else if (age >= 2) {
        // remove
        entry.layers.forEach(({ id }) => { try { this.map.removeLayer(id);  } catch (_) {} });
        entry.sources.forEach(id       => { try { this.map.removeSource(id); } catch (_) {} });
      } else {
        keep.push(entry);
      }
    });
    this._mapLayerRegistry = keep;
  }

  /** Remove all tracked map layers (used by clearMapElements / resetChat). */
  _clearMapLayers() {
    this._mapLayerRegistry.forEach(({ layers, sources }) => {
      layers.forEach(({ id }) => { try { this.map.removeLayer(id);  } catch (_) {} });
      sources.forEach(id     => { try { this.map.removeSource(id); } catch (_) {} });
    });
    this._mapLayerRegistry = [];
    this._mapGen = 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // Tool Aggregation
  // ═══════════════════════════════════════════════════════════════

  /**
   * Frontend map-visualization tool definitions (Claude schema).
   * Combined with mapboxMCP.listTools() to form the full tools array.
   */
  _getFrontendToolDefinitions() {
    return [
      {
        name: 'draw_search_boundary',
        description: '地図にBBOX検索範囲を描画する。探索エリア確定時に実行。',
        input_schema: {
          type: 'object',
          properties: { bbox: { type: 'array', items: { type: 'number' }, description: '[minX,minY,maxX,maxY]' } },
          required: ['bbox'],
        },
      },
      {
        name: 'add_candidate_markers',
        description: '条件に合致する候補を確度順の番号付きピンで地図にプロット。件数を絞らず該当するものをすべて渡すこと。places[0]が最有力候補。reason(根拠)を付記。最有力のポップアップは自動で開く。',
        input_schema: {
          type: 'object',
          properties: {
            places: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name:        { type: 'string' },
                  latitude:    { type: 'number' },
                  longitude:   { type: 'number' },
                  address:     { type: 'string' },
                  reason:      { type: 'string' },
                  match_level: {
                    type: 'string',
                    enum: ['full', 'partial'],
                    description: 'full=全条件合致、partial=一部条件合致。条件に合致しないものは渡さないこと。'
                  },
                },
                required: ['name', 'latitude', 'longitude'],
              },
            },
          },
          required: ['places'],
        },
      },
      {
        name: 'clear_map_elements',
        description: '地図の検索範囲ポリゴンと候補ピンをすべて消去する。確定フェーズ移行時に実行。',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'show_probable_area',
        description:
          '候補が2〜4件あり1点に絞れない場合、またはエリアは特定できるが具体的建物・住所が不明な場合に使用。候補を包含するエリアポリゴン（赤系）を地図に表示する。' +
          'finalize_location_markerとは異なり確定しない。add_candidate_markersと併用可能。messageには根拠（「〇〇と□□の間にいると思われます」等）を含めること。',
        input_schema: {
          type: 'object',
          properties: {
            candidates: {
              type: 'array',
              description: '候補地点の配列',
              items: {
                type: 'object',
                properties: {
                  latitude:  { type: 'number' },
                  longitude: { type: 'number' },
                },
                required: ['latitude', 'longitude'],
              },
            },
            message: { type: 'string', description: 'ポリゴン中央に表示するメッセージ' },
          },
          required: ['candidates'],
        },
      },
      {
        name: 'finalize_location_marker',
        description: '確定座標に赤ピンを立てポップアップと住所を表示しズームインする。候補1件のみ・オペレーター肯定応答・絞り込み根拠が揃った時点で即座にclear_map_elements→本ツールの順で実行すること（先延ばし禁止）。',
        input_schema: {
          type: 'object',
          properties: {
            lat:     { type: 'number' },
            lng:     { type: 'number' },
            address: { type: 'string' },
          },
          required: ['lat', 'lng', 'address'],
        },
      },
      {
        name: 'ask_choice',
        description: '探索対象が複数ある場合にオペレーターへ選択肢をボタン形式で提示し、どれをメインに探すか確認する。ユーザーの回答を待ってから探索を開始すること。',
        input_schema: {
          type: 'object',
          properties: {
            question: { type: 'string', description: '確認の質問文（例：「どちらを先に探しますか？」）' },
            choices:  {
              type: 'array',
              items: { type: 'string' },
              description: '選択肢ラベルの配列（例：["ホテル", "レンタカー屋"]）',
            },
          },
          required: ['question', 'choices'],
        },
      },
    ];
  }

  /**
   * Execute any tool — routes to frontend methods or MapboxMCPClient.
   *
   * @param {string} name  - Tool name
   * @param {object} args  - Tool arguments
   * @returns {Promise<string>} Result string (Minified JSON or status message)
   */
  async _executeTool(name, args) {
    switch (name) {
      case 'draw_search_boundary':
        return this.drawSearchBoundary(args.bbox);
      case 'add_candidate_markers':
        return this.addCandidateMarkers(args.places || []);
      case 'clear_map_elements':
        return this.clearMapElements();
      case 'show_probable_area':
        return this.showProbableArea(args.candidates || [], args.message);
      case 'finalize_location_marker':
        return this.finalizeLocationMarker(args.lat, args.lng, args.address);
      case 'ask_choice':
        return await this._showChoicePanel(args.question, args.choices || []);
      default:
        return await this.mapboxMCP.executeTool(name, args);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Claude AI Agent Loop
  // ═══════════════════════════════════════════════════════════════

  /**
   * Send a user message to Claude, run the agentic tool loop,
   * and display results progressively.
   *
   * @param {string} userText - Raw user input
   */
  async processUserMessage(userText) {
    this.messages.push({ role: 'user', content: userText });

    const allTools = [
      ...this.mapboxMCP.listTools(),
      ...this._getFrontendToolDefinitions(),
    ];

    // Reset map to overview on each new query
    this._clearDebugLayers();
    this.clearMapElements();
    if (this.finalMarker) { this.finalMarker.remove(); this.finalMarker = null; }
    this.map.flyTo({ zoom: 8, duration: 900, essential: true });

    PerfLogger.startQuery(userText);
    let turnCount       = 0;
    let hintRequested   = false;
    let maxTurns        = this.config.MAX_TOOL_TURNS;
    let toolTurnCount   = 0;  // counts only tool_use turns

    for (let turn = 0; turn < maxTurns; turn++) {

      // ── Hint request after MAX_HINT_TURNS tool calls ───────
      if (!hintRequested && toolTurnCount >= this.config.MAX_HINT_TURNS) {
        hintRequested = true;
        const hintText = await this._requestHintFromUser(allTools);
        if (hintText) {
          this.messages.push({ role: 'user', content: hintText });
          this.addMessage('user', hintText);
          maxTurns = turn + 1 + this.config.HINT_EXTRA_TURNS;
        }
        // Whether hint provided or not, continue (Claude may finalize)
      }
      turnCount++;
      this._updateThinking(`Claude API (ターン ${turn + 1})…`);

      // ── Claude API call ────────────────────────────────────────
      const apiHandle = PerfLogger.startOp(`Claude API ターン ${turn + 1}`);
      const apiStep   = this._addThinkingStep(`🤖 Claude API (ターン ${turn + 1})`);

      let res;
      try {
        res = await fetch(this.config.CLAUDE_API_PROXY, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            model:       this.config.CLAUDE_MODEL,
            max_tokens:  this.config.MAX_TOKENS,
            temperature: this.config.TEMPERATURE ?? 0,
            system:      POSITION_AGENT_PROMPT,
            messages:    this.messages,
            tools:       allTools,
          }),
        });
      } catch (err) {
        throw new Error(`ネットワークエラー: ${err.message}`);
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        throw new Error(`API Error ${res.status}: ${errText}`);
      }

      const data = await res.json();
      const usage = data.usage || {};
      this._tokens.input  += usage.input_tokens  || 0;
      this._tokens.output += usage.output_tokens || 0;
      this._updateTokenDisplay();

      const apiElapsed = PerfLogger.endOp(
        apiHandle,
        `in=${usage.input_tokens ?? '?'} out=${usage.output_tokens ?? '?'} stop=${data.stop_reason}`
      );
      this._resolveThinkingStep(
        apiStep,
        `${apiElapsed}s · in:${usage.input_tokens ?? '?'} out:${usage.output_tokens ?? '?'}`
      );

      // Extract text blocks
      const textContent = (data.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');

      this.messages.push({ role: 'assistant', content: data.content });
      // Compress tool_results Claude just consumed to save tokens in future turns
      this._compressLastToolResults();

      // ── end_turn ───────────────────────────────────────────────
      if (data.stop_reason === 'end_turn') {
        if (textContent) this.addMessage('assistant', textContent);
        break;
      }

      // ── tool_use ───────────────────────────────────────────────
      if (data.stop_reason === 'tool_use') {
        toolTurnCount++;
        if (textContent) this.addMessage('thinking-msg', textContent);

        const toolUseBlocks = (data.content || []).filter(b => b.type === 'tool_use');
        const toolResults   = [];

        this._currentTurn = turn + 1;

        for (const tu of toolUseBlocks) {
          const label = getToolLabel(tu.name, this._lang);
          this._updateThinking(label);
          const toolStep   = this._addThinkingStep(label);
          const toolHandle = PerfLogger.startOp(`Tool: ${tu.name}`);
          this._showMapComputing(tu.name, tu.input);
          if (this._debugMode) this._visualizeSearchArgs(tu.name, tu.input);

          const result = await this._executeTool(tu.name, tu.input);

          this._hideMapComputing();
          if (this._debugMode) this._visualizeToolResult(tu.name, result);
          this._updateAPICountDisplay();
          const toolElapsed = PerfLogger.endOp(toolHandle);
          this._resolveThinkingStep(toolStep, toolElapsed + 's');

          // ── Debug step pause ──────────────────────────────────
          if (this._debugMode) {
            await this._debugPause(tu.name, tu.input, result);
          }

          toolResults.push({
            type:        'tool_result',
            tool_use_id: tu.id,
            content:     result,
          });
        }

        this.messages.push({ role: 'user', content: toolResults });

        // Warn Claude when the next turn is the last so it finalizes
        if (turn === maxTurns - 2) {
          const lastTurnWarning = this._lang === 'ja'
            ? '【システム】これが最後の探索ターンです。これ以上ツールは使えません。現時点で最も可能性の高い地点を特定し、必ずfinalize_location_markerを呼び出して回答を確定してください。情報が不十分でも、最善の推測で回答してください。'
            : '[SYSTEM] This is the final turn. No more tool calls will be available. Identify the most likely location based on what you have found and call finalize_location_marker to confirm your answer. Make your best guess even if information is incomplete.';
          this.messages.push({ role: 'user', content: lastTurnWarning });
        }

      } else {
        if (textContent) this.addMessage('assistant', textContent);
        break;
      }
    }

    const totalSec = PerfLogger.endQuery(turnCount);
    this.addMessage('tool-status', `⏱ 完了: ${totalSec}s / APIターン ${turnCount}回`);

    // finalMarkerがあるのにパネルが出ていない場合は確実に表示
    if (this.finalMarker && !document.getElementById('resolutionPanel')) {
      this._showResolutionPanel();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // UI Helpers
  // ═══════════════════════════════════════════════════════════════

  /**
   * Append a message bubble to the chat panel.
   *
   * @param {'user'|'assistant'|'thinking-msg'|'tool-status'|'error'} role
   * @param {string} text
   */
  addMessage(role, text) {
    const container = document.getElementById('chatMessages');

    const t = LANG[this._lang];
    const roleLabels = {
      user:           t.roleUser,
      assistant:      t.roleAssistant,
      'thinking-msg': t.roleThinking,
      'tool-status':  t.roleTool,
      error:          t.roleError,
    };

    const wrapper = document.createElement('div');
    wrapper.className = `message ${role}`;

    if (roleLabels[role]) {
      const lbl = document.createElement('div');
      lbl.className   = 'msg-label';
      lbl.textContent = roleLabels[role];
      wrapper.appendChild(lbl);
    }

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.innerHTML = _formatMsg(text);
    wrapper.appendChild(bubble);

    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;
  }

  // ─────────────────────────────────────────────────────────────
  // Token optimization: compress consumed tool results
  // ─────────────────────────────────────────────────────────────

  /**
   * After Claude processes tool results, replace the raw JSON with a compact
   * summary. We walk backwards to find the most recent tool_result user message,
   * look up the matching tool_use block in the preceding assistant message
   * to know the tool name, then compress.
   */
  _compressLastToolResults() {
    // Find the most recent tool_result user message (skip the very last message
    // since that's the assistant response we just added)
    for (let i = this.messages.length - 2; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
      if (!msg.content.some(b => b.type === 'tool_result')) continue;

      // Build tool_use_id → tool_name map from the preceding assistant message
      const toolNameMap = {};
      const prevAssist = i > 0 ? this.messages[i - 1] : null;
      if (prevAssist?.role === 'assistant' && Array.isArray(prevAssist.content)) {
        prevAssist.content
          .filter(b => b.type === 'tool_use')
          .forEach(b => { toolNameMap[b.id] = b.name; });
      }

      // Compress each tool_result block
      msg.content = msg.content.map(b => {
        if (b.type !== 'tool_result') return b;
        const toolName = toolNameMap[b.tool_use_id] || 'unknown';
        const compressed = this._summarizeToolResult(toolName, b.content);
        if (this.config.DEBUG && compressed !== b.content) {
          const before = b.content?.length ?? 0;
          const after  = compressed?.length ?? 0;
          console.log(`[TokenOpt] ${toolName}: ${before}c → ${after}c (-${Math.round((1 - after/before)*100)}%)`);
        }
        return { ...b, content: compressed };
      });
      break;
    }
  }

  /**
   * Return a compact JSON string retaining only the fields Claude
   * might need to reference in later turns.
   */
  _summarizeToolResult(toolName, content) {
    try {
      const d = JSON.parse(content);
      if (d.error) return JSON.stringify({ error: d.error });

      switch (toolName) {
        case 'search_nearby_poi':
          return JSON.stringify({
            source: d.source,
            count:  d.count,
            items: (d.items || []).map(i => ({
              name: i.name, latitude: i.latitude, longitude: i.longitude,
              ...(i.operator     ? { operator:     i.operator }     : {}),
              ...(i.feature_type ? { feature_type: i.feature_type } : {}),
              ...(i.bbox         ? { bbox:         i.bbox }         : {}),
            })),
          });

        case 'scan_street_features':
          return JSON.stringify({
            source: d.source, layers: d.layers, count: d.count,
            // Keep name + class/stop_type + coords for spatial reference
            items: (d.items || []).map(i => ({
              layer:     i.layer,
              ...(i.name      ? { name:      i.name }      : {}),
              ...(i.class     ? { class:     i.class }     : {}),
              ...(i.stop_type ? { stop_type: i.stop_type } : {}),
              ...(i.mode      ? { mode:      i.mode }      : {}),
              ...(i.coords    ? { coords:    i.coords }    : {}),
            })),
          });

        case 'get_facing_road':
          return JSON.stringify({
            found:        d.found,
            primary_road: d.primary_road
              ? { name: d.primary_road.name, class: d.primary_road.class }
              : null,
            road_classes: d.road_classes,
            radius_used:  d.radius_used,
          });

        case 'get_midpoint_area':
          // Already compact
          return content;

        case 'get_route_pois':
          return JSON.stringify({
            source:         d.source,
            profile:        d.profile,
            route_count:    d.route_count,
            matching_count: d.matching_count,
            matching_pois:  d.matching_pois,
            excluded_pois:  (d.excluded_pois || []).map(p => ({ name: p.name })),
          });

        default:
          // Map tools return short strings — keep as-is
          return content;
      }
    } catch (_) {
      return content; // parse failed, keep original
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Hint request system
  // ─────────────────────────────────────────────────────────────

  /**
   * Ask Claude what information would help, then show a text input for the operator.
   * Returns the operator's hint text, or null if skipped.
   */
  async _requestHintFromUser(allTools) {
    this._updateThinking('💭 追加情報のリクエストを生成中...');

    // Ask Claude (no tools) what it needs
    let hintMessage = '';
    try {
      const res = await fetch(this.config.CLAUDE_API_PROXY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model:      this.config.CLAUDE_MODEL,
          max_tokens: 400,
          system:     POSITION_AGENT_PROMPT,
          messages: [
            ...this.messages,
            {
              role: 'user',
              content: '複数回の検索を行いましたが、まだ正確な位置を特定できていません。' +
                       'オペレーターに追加情報を求めてください。' +
                       '今の状況を1文で説明した上で、特定に役立つ具体的な質問を3点以内で列挙してください。' +
                       'ツールは呼ばず、オペレーターへのメッセージのみ返答してください。',
            },
          ],
          // No tools → force text response
        }),
      });
      if (res.ok) {
        const data = await res.json();
        hintMessage = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      }
    } catch(_) {}

    if (!hintMessage) return null;

    return new Promise(resolve => {
      this._hintResolve = resolve;
      this._showHintPanel(hintMessage, resolve);
      this._updateThinking('⏸ オペレーターからの追加情報を待っています...');
    });
  }

  /** Render the hint request panel in chat and wait for operator input. */
  _showHintPanel(claudeMessage, onResponse) {
    const container = document.getElementById('chatMessages');
    const uid = `hint-${Date.now()}`;

    const ht = LANG[this._lang];
    const wrapper = document.createElement('div');
    wrapper.className = 'message hint-request';
    wrapper.innerHTML = `
      <div class="msg-label">${ht.hintTitle(this.config.HINT_EXTRA_TURNS)}</div>
      <div class="hint-bubble">
        <div class="hint-question">${_formatMsg(claudeMessage)}</div>
        <textarea id="${uid}-input" class="hint-input" placeholder="${ht.hintPlaceholder}" rows="3"></textarea>
        <div class="hint-actions">
          <button class="hint-submit-btn" id="${uid}-ok">${ht.hintSubmit}</button>
          <button class="hint-skip-btn"   id="${uid}-skip">${ht.hintSkip}</button>
        </div>
      </div>
    `;
    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;

    document.getElementById(`${uid}-ok`).addEventListener('click', () => {
      const text = document.getElementById(`${uid}-input`).value.trim();
      if (!text) return;
      document.getElementById(`${uid}-input`).disabled = true;
      document.getElementById(`${uid}-ok`).disabled    = true;
      document.getElementById(`${uid}-ok`).textContent = LANG[this._lang].hintDone;
      document.getElementById(`${uid}-skip`).style.display = 'none';
      this._hintResolve = null;
      onResponse(text);
    });

    document.getElementById(`${uid}-skip`).addEventListener('click', () => {
      document.getElementById(`${uid}-input`).disabled   = true;
      document.getElementById(`${uid}-ok`).disabled      = true;
      document.getElementById(`${uid}-skip`).disabled    = true;
      wrapper.querySelector('.hint-bubble').style.opacity = '0.5';
      this._hintResolve = null;
      onResponse(null);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Choice panel
  // ─────────────────────────────────────────────────────────────

  /**
   * Show choice buttons in chat and wait for operator selection.
   * Returns the selected choice string as the tool result.
   */
  _showChoicePanel(question, choices) {
    return new Promise(resolve => {
      const container = document.getElementById('chatMessages');
      const uid = `choice-${Date.now()}`;

      const wrapper = document.createElement('div');
      wrapper.className = 'message choice-request';
      wrapper.innerHTML = `
        <div class="msg-label">🔀 選択</div>
        <div class="choice-bubble">
          <div class="choice-question">${_formatMsg(question)}</div>
          <div class="choice-buttons" id="${uid}-btns">
            ${choices.map((c, i) =>
              `<button class="choice-btn" id="${uid}-btn-${i}">${_esc(c)}</button>`
            ).join('')}
          </div>
        </div>
      `;
      container.appendChild(wrapper);
      container.scrollTop = container.scrollHeight;

      choices.forEach((choice, i) => {
        document.getElementById(`${uid}-btn-${i}`).addEventListener('click', () => {
          // Disable all buttons after selection
          choices.forEach((_, j) => {
            const btn = document.getElementById(`${uid}-btn-${j}`);
            if (btn) {
              btn.disabled = true;
              btn.classList.toggle('choice-btn-selected', j === i);
            }
          });
          this.addMessage('user', choice);
          resolve(`選択: ${choice}`);
        });
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Debug step mode
  // ─────────────────────────────────────────────────────────────

  /**
   * Pause the agentic loop until the user clicks "▶ 次のステップへ".
   * Shows a summary of the tool call + result in the chat.
   */
  _debugPause(toolName, toolInput, resultStr) {
    return new Promise(resolve => {
      this._debugStepResolve = resolve;

      // Build result summary for display
      let summary = '';
      try {
        const r = JSON.parse(resultStr);
        if (typeof r === 'string') {
          summary = r.slice(0, 60);
        } else if (r.count != null) {
          summary = `${r.count}件取得（${r.source || ''}）`;
        } else if (r.found != null) {
          summary = r.found
            ? `検出: ${r.primary_road?.name || r.road_classes || '不明'}`
            : '未検出';
        } else if (r.matching_count != null) {
          summary = `経路沿い ${r.matching_count}件 / 除外 ${(r.excluded_pois||[]).length}件`;
        } else if (r.error) {
          summary = `エラー: ${r.error}`;
        } else {
          summary = JSON.stringify(r).slice(0, 80);
        }
      } catch(_) { summary = String(resultStr).slice(0, 80); }

      // Build input summary
      let inputSummary = '';
      try {
        const inp = toolInput || {};
        if (inp.queries)  inputSummary = `queries: [${(inp.queries || []).slice(0,2).join(', ')}…]`;
        else if (inp.lat) inputSummary = `lat=${inp.lat?.toFixed(4)}, lng=${inp.lng?.toFixed(4)}, r=${inp.radius}m`;
        else if (inp.placeA) inputSummary = `${inp.placeA} ↔ ${inp.placeB}`;
        else if (inp.from_lat) inputSummary = `from→to, profile=${inp.profile}`;
        else if (inp.bbox) inputSummary = `bbox=[${(inp.bbox||[]).map(v=>v.toFixed(3)).join(',')}]`;
      } catch(_) {}

      // Create pause message element
      const pauseId = `debug-next-${this._debugPauseCount++}`;

      // Build tabs HTML for search_nearby_poi
      let tabsHtml = '';
      if (toolName === 'search_nearby_poi') {
        try {
          const r = JSON.parse(resultStr);
          const dbg = r._debug;
          if (dbg) {
            const renderList = (items) => (items || []).length
              ? (items || []).map(i => `<div class="debug-poi-item"><span class="debug-poi-name">${_esc(i.name)}</span><span class="debug-poi-dist">${i.distance ?? '-'}m</span></div>`).join('')
              : '<div class="debug-poi-empty">0件</div>';

            tabsHtml = `
              <div class="debug-tabs">
                <div class="debug-tab-bar">
                  <button class="debug-tab active" data-tab="sb">Search Box (${dbg.sb_count})</button>
                  <button class="debug-tab" data-tab="tq">Tilequery (${dbg.tq_count})</button>
                  <button class="debug-tab" data-tab="all">合計 (${r.count})</button>
                </div>
                <div class="debug-tab-content" id="${pauseId}-tab-sb">${renderList(dbg.sb_items)}</div>
                <div class="debug-tab-content" id="${pauseId}-tab-tq" style="display:none">${renderList(dbg.tq_items)}</div>
                <div class="debug-tab-content" id="${pauseId}-tab-all" style="display:none">${renderList([...(dbg.sb_items||[]), ...(dbg.tq_items||[])])}</div>
              </div>
            `;
          }
        } catch(_) {}
      }
      const container = document.getElementById('chatMessages');
      const wrapper = document.createElement('div');
      wrapper.className = 'message debug-pause';
      wrapper.innerHTML = `
        <div class="msg-label">⏸ デバッグ停止</div>
        <div class="debug-pause-bubble">
          <div class="debug-tool-name">${getToolLabel(toolName, this._lang)}</div>
          ${inputSummary ? `<div class="debug-input-summary">入力: ${_esc(inputSummary)}</div>` : ''}
          <div class="debug-result-summary">結果: ${_esc(summary)}</div>
          ${tabsHtml}
          <button class="debug-next-btn" id="${pauseId}">▶ 次のステップへ</button>
        </div>
      `;
      container.appendChild(wrapper);
      container.scrollTop = container.scrollHeight;

      // Update thinking bar
      this._updateThinking('⏸ デバッグ一時停止 — 地図を確認してから「次のステップへ」をクリック');

      document.getElementById(pauseId).addEventListener('click', () => {
        document.getElementById(pauseId).disabled = true;
        document.getElementById(pauseId).textContent = '✓ 続行';
        this._debugStepResolve = null;
        resolve();
      });

      wrapper.querySelectorAll('.debug-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          wrapper.querySelectorAll('.debug-tab').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          const target = tab.dataset.tab;
          wrapper.querySelectorAll('.debug-tab-content').forEach(c => c.style.display = 'none');
          const content = document.getElementById(`${pauseId}-tab-${target}`);
          if (content) content.style.display = 'block';
        });
      });
    });
  }

  _applyLanguage(lang) {
    const t = LANG[lang];
    if (!t) return;

    // Toggle button — shows current language
    const btn = document.getElementById('lang-toggle');
    if (btn) btn.textContent = t.langBtn;

    // App title
    const titleEl = document.getElementById('app-title');
    if (titleEl) titleEl.textContent = t.appTitle;

    // Textarea placeholder
    const input = document.getElementById('chatInput');
    if (input) input.placeholder = t.placeholder;

    // Clear chat button
    const clearBtn = document.getElementById('clearChatBtn');
    if (clearBtn) clearBtn.textContent = t.clearChat;

    // Debug toggle button (respect current state)
    const dbgBtn = document.getElementById('debugToggleBtn');
    if (dbgBtn) dbgBtn.textContent = this._debugMode ? t.debugOn : t.debugOff;

    // Examples label
    const exLabel = document.getElementById('examples-label');
    if (exLabel) exLabel.textContent = t.examplesLabel;

    // Example chips: show correct language text + update data-q
    document.querySelectorAll('.example-chip').forEach(chip => {
      const q = chip.dataset[`q${lang.charAt(0).toUpperCase() + lang.slice(1)}`] || chip.dataset.q;
      if (q) chip.dataset.q = q;
      chip.querySelector('.chip-text-ja').style.display = lang === 'ja' ? '' : 'none';
      chip.querySelector('.chip-text-en').style.display = lang === 'en' ? '' : 'none';
    });

    // Update welcome message if conversation hasn't started yet
    const hasUserMsg = document.querySelectorAll('#chatMessages .message.user').length > 0;
    if (!hasUserMsg) {
      const firstBubble = document.querySelector('#chatMessages .message.assistant .message-bubble');
      if (firstBubble) firstBubble.innerHTML = _formatMsg(t.welcome);
    }

    // Map language
    try { this.map.setLanguage(lang); } catch(_) {}

    // Map status
    const mapStatus = document.getElementById('mapStatus');
    if (mapStatus && mapStatus.textContent === LANG[lang === 'ja' ? 'en' : 'ja'].mapReady) {
      mapStatus.textContent = t.mapReady;
    }
  }

  _updateAPICountDisplay() {
    const sb = document.getElementById('api-counter-sb');
    const tq = document.getElementById('api-counter-tq');
    if (sb) sb.textContent = `SB: ${this.mapboxMCP?._sbRequests ?? 0} req`;
    const tqHits = this.mapboxMCP?._tqCacheHits ?? 0;
    const tqReal = this.mapboxMCP?._tqRequests  ?? 0;
    if (tq) tq.textContent = tqHits > 0
      ? `TQ: ${tqReal} req (+${tqHits}↩)`
      : `TQ: ${tqReal} req`;
  }

  _updateTokenDisplay() {
    const el = document.getElementById('token-display');
    if (!el) return;
    const fmt = n => n.toLocaleString('ja-JP');
    el.textContent = `↑${fmt(this._tokens.input)} ↓${fmt(this._tokens.output)}`;
  }

  _showThinking(text) {
    const el = document.getElementById('thinkingDisplay');
    el.style.display = 'flex';
    el.style.flexDirection = 'column';
    // Always start collapsed
    document.getElementById('thinkingLog').style.display  = 'none';
    document.getElementById('thinkingToggleBtn').textContent = '▲';
    document.getElementById('thinkingSteps').innerHTML = '';
    this._updateThinking(text);
  }

  _updateThinking(text) {
    document.getElementById('thinkingStatus').textContent = text;
  }

  /** Add a step to the thinking panel. Returns the element so timing can be appended later. */
  _addThinkingStep(text) {
    const steps = document.getElementById('thinkingSteps');
    const step  = document.createElement('div');
    step.className   = 'thinking-step pending';
    step.textContent = text;
    steps.appendChild(step);
    return step;
  }

  /** Update an existing thinking step with elapsed time and mark it done. */
  _resolveThinkingStep(el, elapsedSec) {
    if (!el) return;
    el.textContent = el.textContent + ` (${elapsedSec}s)`;
    el.classList.remove('pending');
  }

  _hideThinking() {
    const el = document.getElementById('thinkingDisplay');
    el.style.display = 'none';
    // Collapse log on hide so next time starts fresh
    document.getElementById('thinkingLog').style.display = 'none';
    document.getElementById('thinkingToggleBtn').textContent = '▲';
  }
}

// ═══════════════════════════════════════════════════════════════
// Performance Logger
// ═══════════════════════════════════════════════════════════════

const PerfLogger = {
  _sessionStart: null,
  _queryLabel:   null,

  /** Call at the start of each user query. */
  startQuery(label) {
    this._sessionStart = performance.now();
    this._queryLabel   = label;
    console.group(`🚀 [LocationFinder] "${label.slice(0, 60)}"  — ${new Date().toLocaleTimeString()}`);
  },

  /** Returns a timer handle. Call end(handle) when the operation finishes. */
  startOp(label) {
    const t = performance.now();
    const total = ((t - this._sessionStart) / 1000).toFixed(2);
    console.log(`  ⏳ [+${total}s] ${label}`);
    return { label, t };
  },

  /** Logs completion and returns elapsed seconds as string. */
  endOp(handle, extra = '') {
    const elapsed = ((performance.now() - handle.t) / 1000).toFixed(2);
    const total   = ((performance.now() - this._sessionStart) / 1000).toFixed(2);
    const suffix  = extra ? `  │  ${extra}` : '';
    console.log(`  ✅ [+${total}s] ${handle.label} → \x1b[32m${elapsed}s\x1b[0m${suffix}`);
    return elapsed;
  },

  /** Print a summary and close the console group. */
  endQuery(turnCount) {
    const total = ((performance.now() - this._sessionStart) / 1000).toFixed(2);
    console.log(`📊 合計: ${total}s  |  API ターン数: ${turnCount}`);
    console.groupEnd();
    return total;
  },
};

// ═══════════════════════════════════════════════════════════════
// Tool status labels (displayed in thinking indicator)
// ═══════════════════════════════════════════════════════════════

// Tool labels are now in LANG[lang].tools — use getToolLabel(name) instead of TOOL_LABELS
function getToolLabel(name, lang = 'ja') {
  return (LANG[lang]?.tools?.[name]) || name;
}

// ═══════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════

/**
 * Guard against swapped lat/lng (Claude occasionally passes [lat,lng] order).
 * In Japan: longitude ≈ 139, latitude ≈ 35.
 * If |lat| > 90 and |lng| <= 90, the values are swapped → correct them.
 */
function _safeLL(lng, lat) {
  if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) {
    if (CONFIG.DEBUG) console.warn(`[safeLL] lat/lng swapped detected, correcting: [${lng},${lat}] → [${lat},${lng}]`);
    return [lat, lng];
  }
  return [lng, lat];
}

// ================================================================
// Language definitions
// ================================================================
const LANG = {
  ja: {
    appTitle:      'ジオネーター',
    langBtn:       '🌐 Switch to EN',
    placeholder:   '場所を入力… (Enter×2で送信)',
    clearChat:     'チャットをクリア',
    debugOff:      '🔍 デバッグ OFF',
    debugOn:       '🔍 デバッグ ON',
    examplesLabel: '入力例',
    mapReady:      '地図の準備ができました',
    mapLoading:    '地図を読み込み中…',
    welcome:
      'こんにちは、ジオネーターです！\n\n' +
      '曖昧な言葉から、場所を特定します。近くのお店や、駅、方角、道路、川や海など、特徴的なものをいくつか教えてください。',
    // Chat role labels
    roleUser:      'オペレーター',
    roleAssistant: 'AI エージェント',
    roleThinking:  'AI 思考',
    roleTool:      'ツール実行',
    roleError:     'エラー',
    roleDebug:     'デバッグ停止',
    roleHint:      '💭 追加情報のお願い',
    // Priority labels
    priorityLabels:   ['最有力候補', '次有力候補', '第3候補', '第4候補', '第5候補'],
    priorityBadges:   ['⭐ 最有力候補', '🔵 次有力候補', '⚪'],
    probableArea:     'この辺にいると思われます',
    // Hint panel
    hintTitle:        (n) => `💭 追加情報のお願い（${n}回追加検索）`,
    hintPlaceholder:  '分かる範囲でお答えください...',
    hintSubmit:       '▶ この情報で続ける',
    hintSkip:         'スキップ（このまま続ける）',
    hintDone:         '✓ 続行中',
    // Processing
    connecting:       'Claude APIに接続中…',
    pausedHint:       '⏸ 追加情報を待っています...',
    debugPaused:      (s) => `⏸ デバッグ一時停止 — ${s}を確認してから「次のステップへ」をクリック`,
    debugNext:        '▶ 次のステップへ',
    debugDone:        '✓ 続行',
    confirmed:        '確定',
    // Tool labels
    tools: {
      get_midpoint_area:               '🗺  中間領域を計算中',
      search_nearby_poi:               '🔍 POIを検索中',
      scan_street_features:            '📡 周辺施設をスキャン中',
      draw_search_boundary:            '📐 検索範囲を描画中',
      add_candidate_markers:           '📌 候補ピンを追加中',
      clear_map_elements:              '🧹 マップをクリア中',
      finalize_location_marker:        '✅ 確定地点をマーク中',
      get_facing_road:                 '🛣  面している道路を判定中',
      get_route_pois:                  '🗺  経路沿いのPOIを判定中',
      scan_natural_features:           '🌿 自然地物をスキャン中',
      show_probable_area:              '🔴 候補エリアを表示中',
      check_travel_time:               '⏱  移動時間を確認中',
      compute_area_from_landmark_bearing: '🧭 ランドマーク方位からエリアを計算中',
    },
  },
  en: {
    appTitle:      'Geonator',
    langBtn:       '🌐 日本語に変更',
    placeholder:   'Describe location… (press Enter twice to send)',
    clearChat:     'Clear Chat',
    debugOff:      '🔍 Debug OFF',
    debugOn:       '🔍 Debug ON',
    examplesLabel: 'Examples',
    mapReady:      'Map ready',
    mapLoading:    'Loading map…',
    welcome:
      'Hi, I\'m Geonator!\n\n' +
      'I identify locations from vague descriptions. Share nearby features — stores, stations, directions, roads, rivers, or landmarks.',
    roleUser:      'Caller',
    roleAssistant: 'AI Agent',
    roleThinking:  'AI Thinking',
    roleTool:      'Tool',
    roleError:     'Error',
    roleDebug:     'Debug Pause',
    roleHint:      '💭 More info needed',
    priorityLabels:   ['Top Candidate', '2nd Candidate', '3rd Option', '4th Option', '5th Option'],
    priorityBadges:   ['⭐ Top Candidate', '🔵 2nd Candidate', '⚪'],
    probableArea:     'Likely in this area',
    hintTitle:        (n) => `💭 Need more info (${n} more searches)`,
    hintPlaceholder:  'Type what you know…',
    hintSubmit:       '▶ Continue with this info',
    hintSkip:         'Skip',
    hintDone:         '✓ Continuing',
    connecting:       'Connecting to Claude…',
    pausedHint:       '⏸ Waiting for your input…',
    debugPaused:      (s) => `⏸ Debug paused — check the ${s} then click "Next Step"`,
    debugNext:        '▶ Next Step',
    debugDone:        '✓ Done',
    confirmed:        'Confirmed',
    tools: {
      get_midpoint_area:               '🗺  Computing midpoint',
      search_nearby_poi:               '🔍 Searching POIs',
      scan_street_features:            '📡 Scanning street features',
      draw_search_boundary:            '📐 Drawing search area',
      add_candidate_markers:           '📌 Adding candidate pins',
      clear_map_elements:              '🧹 Clearing map',
      finalize_location_marker:        '✅ Marking confirmed location',
      get_facing_road:                 '🛣  Checking road type',
      get_route_pois:                  '🗺  Checking route POIs',
      scan_natural_features:           '🌿 Scanning natural features',
      show_probable_area:              '🔴 Showing probable area',
      check_travel_time:               '⏱  Checking travel time',
      compute_area_from_landmark_bearing: '🧭 Computing bearing area',
    },
  },
};

/** Mirror of MapboxMCPClient._capBBox — cap bbox to ±500m each side. */
function _capBBoxFE(bbox, maxHalfM = 500) {
  const [minX, minY, maxX, maxY] = bbox;
  const cx   = (minX + maxX) / 2;
  const cy   = (minY + maxY) / 2;
  const dLng = maxHalfM / (111320 * Math.cos(cy * Math.PI / 180));
  const dLat = maxHalfM / 110540;
  const hw   = Math.min((maxX - minX) / 2, dLng);
  const hh   = Math.min((maxY - minY) / 2, dLat);
  return [cx - hw, cy - hh, cx + hw, cy + hh];
}

function _esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _formatMsg(text) {
  return _esc(text)
    .replace(/\n/g, '<br>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.*?)`/g,
      '<code style="background:rgba(255,255,255,.08);padding:1px 5px;border-radius:4px;font-size:.9em">$1</code>'
    );
}

// ═══════════════════════════════════════════════════════════════
// Boot
// ═══════════════════════════════════════════════════════════════

window.addEventListener('DOMContentLoaded', async () => {
  const app = new LocationFinderApp();
  await app.initialize();
});
