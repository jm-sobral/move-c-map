(function () {
  'use strict';

  const DATA = window.TRANSIT;
  const OPS = {
    smtuc: { name: 'SMTUC', long: 'Urban buses, Coimbra', full: 'Serviços Municipalizados de Transportes Urbanos de Coimbra' },
    mm: { name: 'Metro Mondego', long: 'Metrobus BRT', full: 'Metro Mondego — Sistema de Mobilidade do Mondego' },
    sit: { name: 'SIT Metropolitano', long: 'Regional buses, 19 municipalities', full: 'SIT Metropolitano da Região de Coimbra' },
    cp: { name: 'CP', long: 'Trains, Comboios de Portugal', full: 'CP – Comboios de Portugal' },
  };
  const OP_ORDER = ['smtuc', 'mm', 'sit', 'cp'];
  const NEARBY_M = 250;
  // Metrobus colours as published, softened where they vanish on a light basemap.
  const COLOUR_FIX = { '#00FF40': '#1f9d4a', '#FF0000': '#d6282b', '#0080FF': '#1673d1' };

  // ------------------------------------------------------------------ helpers
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // bring the start of the detail view into sight after it changes (the whole panel scrolls)
  function showViewTop() {
    const p = document.getElementById('panel'), v = document.getElementById('view');
    const d = v.getBoundingClientRect().top - p.getBoundingClientRect().top;
    if (d < 0 || d > p.clientHeight - 160) p.scrollTop += d - 8;
  }
  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  function decode(str) {
    const pts = []; let i = 0, lat = 0, lon = 0;
    while (i < str.length) {
      for (let k = 0; k < 2; k++) {
        let shift = 0, res = 0, b;
        do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        const d = res & 1 ? ~(res >> 1) : res >> 1;
        if (k === 0) lat += d; else lon += d;
      }
      pts.push([lat / 1e5, lon / 1e5]);
    }
    return pts;
  }

  function metres(a, b) {
    const k = Math.cos((a[0] + b[0]) / 2 * Math.PI / 180);
    const dx = (b[1] - a[1]) * k, dy = b[0] - a[0];
    return Math.hypot(dx, dy) * Math.PI / 180 * 6371000;
  }

  function textOn(hex) {
    const h = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.substr(i, 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return L > 0.36 ? '#141a22' : '#ffffff';
  }

  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function isDark() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t) return t === 'dark';
    return matchMedia('(prefers-color-scheme: dark)').matches;
  }

  const fmtKm = (km) => km.toFixed(1).replace('.', ',') + ' km';
  const fmtM = (m) => (m >= 1000 ? (m / 1000).toFixed(1).replace('.', ',') + ' km' : Math.round(m / 10) * 10 + ' m');

  // ------------------------------------------------------------------ model
  const stops = DATA.stops.map((s, i) => ({ i, op: s[0], name: s[1], ll: [s[2], s[3]], code: s[4], serves: [] }));
  const lines = DATA.lines.map((L, li) => ({ ...L, li, pats: L.pats.map((p, pi) => ({ ...p, pi, pts: decode(p.g) })) }));
  lines.forEach((L) => L.pats.forEach((p) => p.s.forEach((si, pos) => stops[si].serves.push({ li: L.li, pi: p.pi, pos }))));
  const liveStops = stops.filter((s) => s.serves.length);
  // Links name stops by operator + stop code, which survive a data rebuild; array positions do not.
  const stopKey = (s) => `${s.op}-${s.code}`;
  const stopByKey = new Map(stops.map((s) => [stopKey(s), s.i]));

  function lineColour(L) {
    if (L.op === 'mm' && L.color) return COLOUR_FIX[L.color.toUpperCase()] || L.color;
    return cssVar('--' + L.op);
  }
  // trains carry their real destination (h) when the map stops at the region's boundary
  function headsign(p) { return p.h || stops[p.s[p.s.length - 1]].name; }
  function origin(p) { return stops[p.s[0]].name; }
  function linesAt(stop) {
    const m = new Map();
    stop.serves.forEach(({ li, pi, pos }) => {
      if (!m.has(li)) m.set(li, { L: lines[li], heads: new Set(), pats: [] });
      const e = m.get(li), p = lines[li].pats[pi];
      if (pos < p.s.length - 1) e.heads.add(headsign(p)); else e.heads.add('terminus');
      e.pats.push(p);
    });
    return [...m.values()].sort((a, b) => OP_ORDER.indexOf(a.L.op) - OP_ORDER.indexOf(b.L.op) || a.L.li - b.L.li);
  }

  function badge(L, cls = '') {
    const c = lineColour(L);
    return `<span class="badge ${cls}" style="--c:${c};--tc:${textOn(c)}">${esc(L.code)}</span>`;
  }
  function lineTitle(L) {
    if (L.op === 'mm') {
      const p = L.pats[0];
      return `${origin(p)} – ${headsign(p)}`;
    }
    return L.name || '';
  }

  // Filled in by the vehicles module once timetables load; keeps the rest of the app independent of it.
  const hooks = {
    onView() {}, departuresHtml() { return ''; }, lineLiveHtml() { return ''; },
    planButtonsHtml() { return ''; }, planRender(v) { v.innerHTML = ''; }, planLines() { return new Set(); }, planFromHash() {},
  };

  // ------------------------------------------------------------------ state
  const state = {
    on: Object.fromEntries(OP_ORDER.map((op) => [op, true])), // every overlay starts switched on
    sel: null, // {type:'line', li, pi} | {type:'stop', si}
    q: '',
  };

  // ------------------------------------------------------------------ map
  const map = L.map('map', { preferCanvas: true, zoomControl: true, minZoom: 9, maxZoom: 19 })
    .setView([40.205, -8.43], 12);
  map.createPane('network'); map.getPane('network').style.zIndex = 400;
  // One canvas for every vector shape. Each canvas takes the clicks for the whole map, so with
  // stacked canvases the shapes on the lower ones could never be clicked again.
  const rMain = L.canvas({ pane: 'network', tolerance: 5 });
  // Dims everything under the current selection; drawn between the network and the selection.
  const veil = L.rectangle([[-85, -180], [85, 180]], { renderer: rMain, stroke: false, fillOpacity: 0.6, interactive: false });

  // OpenStreetMap standard tiles; the dark theme re-tones them with a CSS filter on the tile pane.
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  // Leaflet re-projects every vertex (spherical Mercator: trig + log) on every zoom. For the
  // thousands of static network shapes, project once at zoom 0 and only rescale afterwards:
  // at zoom z the layer point is p0 * 2^z - pixelOrigin, exact for Web Mercator.
  function zoomScale(m) { return m.getZoomScale(m.getZoom(), 0); }
  const FastPolyline = L.Polyline.extend({
    _projectLatlngs(latlngs, result, bounds) {
      const m = this._map;
      if (!this._p0) {
        const rings = latlngs[0] instanceof L.LatLng ? [latlngs] : latlngs;
        this._p0 = rings.map((ring) => {
          const a = new Float64Array(ring.length * 2);
          ring.forEach((ll, i) => { const p = m.project(ll, 0); a[2 * i] = p.x; a[2 * i + 1] = p.y; });
          return a;
        });
      }
      const s = zoomScale(m), o = m.getPixelOrigin();
      for (const a of this._p0) {
        const ring = new Array(a.length / 2);
        for (let i = 0; i < ring.length; i++) {
          const p = new L.Point(Math.round(a[2 * i] * s) - o.x, Math.round(a[2 * i + 1] * s) - o.y);
          ring[i] = p;
          bounds.extend(p);
        }
        result.push(ring);
      }
    },
  });
  const FastCircleMarker = L.CircleMarker.extend({
    _project() {
      const m = this._map;
      if (!this._p0) this._p0 = m.project(this._latlng, 0);
      const s = zoomScale(m), o = m.getPixelOrigin();
      this._point = new L.Point(Math.round(this._p0.x * s) - o.x, Math.round(this._p0.y * s) - o.y);
      this._updateBounds();
    },
  });

  const net = {}, stopLayers = {};
  const DRAW_ORDER = ['cp', 'sit', 'smtuc', 'mm']; // railway and regional lines under urban ones
  function netTooltip(ls) {
    const shown = ls.slice(0, 8).map((li) => badge(lines[li], 'sm')).join(' ');
    return `<div class="tt-lines">${shown}${ls.length > 8 ? ` +${ls.length - 8}` : ''}</div>${ls.length === 1 ? esc(lineTitle(lines[ls[0]])) : 'Click to choose a line'}`;
  }
  function netPopup(ls) {
    return `<div class="vp"><b>${ls.length} lines use this road</b><div class="pick">${ls.map((li) =>
      `<button type="button" class="pick-row" data-vline="${li}" data-vpat="0">${badge(lines[li], 'sm')}<span>${esc(lineTitle(lines[li]))}</span></button>`).join('')}</div></div>`;
  }
  function buildNetwork() {
    DRAW_ORDER.forEach((op) => {
      if (net[op]) map.removeLayer(net[op]);
      if (stopLayers[op]) map.removeLayer(stopLayers[op]);
      // one layer per group of road segments shared by the same lines (built by tools/build.py)
      const g = L.layerGroup();
      veil.setStyle({ fillColor: cssVar('--bg') });
      const opColour = cssVar('--' + op);
      DATA.net[op].forEach(([parts, ls]) => {
        const c = op === 'mm' ? lineColour(lines[ls[0]]) : opColour;
        const ll = parts.map(decode);
        const pl = new FastPolyline(ll, { renderer: rMain, color: c, weight: op === 'sit' ? 2.2 : op === 'cp' ? 4.5 : 3, opacity: op === 'cp' ? 0.9 : 0.8, lineCap: 'round', lineJoin: 'round' });
        pl.bindTooltip(() => netTooltip(ls), { sticky: true, className: 'tt', direction: 'top', offset: [0, -6] });
        pl.on('click', (e) => {
          L.DomEvent.stop(e);
          if (ls.length === 1) selectLine(ls[0], 0);
          else L.popup({ className: 'veh-pop', maxWidth: 300 }).setLatLng(e.latlng).setContent(netPopup(ls)).openOn(map);
        });
        g.addLayer(pl);
        // railway symbol: light dashes along the dark line
        if (op === 'cp') g.addLayer(new FastPolyline(ll, { renderer: rMain, color: cssVar('--panel'), weight: 1.6, dashArray: '6 8', opacity: 0.9, interactive: false }));
      });
      net[op] = g;
      const sg = L.layerGroup();
      liveStops.filter((s) => s.op === op).forEach((s) => {
        const m = new FastCircleMarker(s.ll, { renderer: rMain, radius: op === 'cp' ? 5.5 : op === 'mm' ? 4.5 : 3.5, color: lineColourOp(op), weight: op === 'cp' ? 3 : 2, fillColor: cssVar('--panel'), fillOpacity: 1 });
        m.bindTooltip(() => `<b>${esc(s.name)}</b><br>${esc(OPS[op].name)} · ${linesAt(s).length} line(s)`, { className: 'tt', direction: 'top', offset: [0, -4] });
        m.on('click', (e) => { L.DomEvent.stop(e); selectStop(s.i); });
        sg.addLayer(m);
      });
      stopLayers[op] = sg;
    });
    applyVisibility();
  }
  function lineColourOp(op) { return op === 'mm' ? cssVar('--mm') : cssVar('--' + op); }

  // Layers are only added/removed when something changes; dimming is one opacity change on each
  // pane (composited by the GPU) instead of restyling thousands of canvas shapes.
  function applyVisibility() {
    const dim = !!state.sel;
    const showStops = map.getZoom() >= 14;
    DRAW_ORDER.forEach((op) => {
      const on = state.on[op];
      if (on && !map.hasLayer(net[op])) net[op].addTo(map);
      if (!on && map.hasLayer(net[op])) map.removeLayer(net[op]);
      const st = on && showStops;
      if (st && !map.hasLayer(stopLayers[op])) stopLayers[op].addTo(map);
      if (!st && map.hasLayer(stopLayers[op])) map.removeLayer(stopLayers[op]);
    });
    if (dim && !map.hasLayer(veil)) veil.addTo(map);
    if (!dim && map.hasLayer(veil)) map.removeLayer(veil);
    if (dim) {
      // layers added since (stops at zoom 14, a re-enabled overlay) must stay under the veil
      veil.bringToFront();
      selLayer.eachLayer((l) => l.bringToFront && l.bringToFront());
    }
    hooks.onView();
    $('#hint').hidden = dim;
    $('#hint').textContent = showStops ? 'Click a line or a stop on the map' : 'Click a line on the map · zoom in to see stops';
  }
  map.on('zoomend', applyVisibility);

  const selLayer = L.layerGroup().addTo(map);
  new ResizeObserver(() => map.invalidateSize()).observe(document.getElementById('map'));

  function drawPattern(Ln, p, { casing = true, weight = 5, labels = true, stopsToo = true } = {}) {
    const c = lineColour(Ln);
    if (casing) L.polyline(p.pts, { renderer: rMain, color: cssVar('--panel'), weight: weight + 5, opacity: 0.95, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(selLayer);
    L.polyline(p.pts, { renderer: rMain, color: c, weight, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false, dashArray: p.src === 'stops' ? '3 10' : null }).addTo(selLayer);
    if (stopsToo) {
      p.s.forEach((si, k) => {
        const s = stops[si], end = k === 0 || k === p.s.length - 1;
        const m = L.circleMarker(s.ll, { renderer: rMain, radius: end ? 7 : 5, color: end ? cssVar('--ink') : c, weight: end ? 3 : 2.5, fillColor: end ? c : cssVar('--panel'), fillOpacity: 1 });
        m.bindTooltip(`<b>${esc(s.name)}</b><br>Stop ${k + 1} of ${p.s.length}`, { className: 'tt', direction: 'top', offset: [0, -5] });
        m.on('click', (e) => { L.DomEvent.stop(e); selectStop(si); });
        m.addTo(selLayer);
      });
    }
    if (labels) {
      [[p.s[0], 'From'], [p.s[p.s.length - 1], 'To']].forEach(([si, w]) => {
        L.tooltip({ permanent: true, direction: 'top', className: 'endlabel', offset: [0, -10], interactive: false })
          .setLatLng(stops[si].ll).setContent(`${w}: ${esc(stops[si].name)}`).addTo(selLayer);
      });
    }
  }

  function panelPad() {
    const narrow = matchMedia('(max-width: 760px)').matches;
    return narrow ? { paddingTopLeft: [40, 44], paddingBottomRight: [40, 20] } : { paddingTopLeft: [80, 60], paddingBottomRight: [80, 40] };
  }

  // ------------------------------------------------------------------ selection
  function selectLine(li, pi = 0, { fit = true, push = true } = {}) {
    const Ln = lines[li];
    if (!state.on[Ln.op]) { state.on[Ln.op] = true; renderToggles(); }
    state.sel = { type: 'line', li, pi };
    selLayer.clearLayers();
    drawPattern(Ln, Ln.pats[pi]);
    applyVisibility();
    if (fit) map.fitBounds(L.latLngBounds(Ln.pats[pi].pts), { ...panelPad(), maxZoom: 16 });
    if (push) setHash(`line-${Ln.op}-${Ln.slug || Ln.code}`);
    renderView();
    showViewTop();
  }

  function selectStop(si, { fit = true, push = true } = {}) {
    const s = stops[si];
    state.sel = { type: 'stop', si };
    selLayer.clearLayers();
    const at = linesAt(s);
    at.forEach(({ L: Ln, pats }) => pats.forEach((p) => drawPattern(Ln, p, { casing: true, weight: 3, labels: false, stopsToo: false })));
    L.circle(s.ll, { renderer: rMain, radius: NEARBY_M, color: cssVar('--muted'), weight: 1.5, dashArray: '4 6', fill: false, interactive: false }).addTo(selLayer);
    nearbyStops(s).forEach(({ s: n }) => {
      L.circleMarker(n.ll, { renderer: rMain, radius: 5, color: lineColourOp(n.op), weight: 2.5, fillColor: cssVar('--panel'), fillOpacity: 1 })
        .bindTooltip(`<b>${esc(n.name)}</b><br>${esc(OPS[n.op].name)}`, { className: 'tt', direction: 'top', offset: [0, -5] })
        .on('click', (e) => { L.DomEvent.stop(e); selectStop(n.i); }).addTo(selLayer);
    });
    L.circleMarker(s.ll, { renderer: rMain, radius: 16, color: cssVar('--ink'), weight: 2, opacity: 0.6, fill: false, interactive: false }).addTo(selLayer);
    L.circleMarker(s.ll, { renderer: rMain, radius: 10, color: cssVar('--panel'), weight: 4, fillColor: lineColourOp(s.op), fillOpacity: 1, interactive: false }).addTo(selLayer);
    applyVisibility();
    if (fit) map.setView(s.ll, Math.max(map.getZoom(), 16));
    if (push) setHash(`stop-${stopKey(s)}`);
    renderView();
    showViewTop();
  }

  function clearSel() {
    state.sel = null; selLayer.clearLayers(); applyVisibility(); setHash(''); renderView();
  }

  function nearbyStops(s) {
    const out = [];
    for (const n of liveStops) {
      if (n === s) continue;
      if (Math.abs(n.ll[0] - s.ll[0]) > 0.004 || Math.abs(n.ll[1] - s.ll[1]) > 0.005) continue;
      const d = metres(s.ll, n.ll);
      if (d <= NEARBY_M) out.push({ s: n, d });
    }
    return out.sort((a, b) => a.d - b.d);
  }

  // ------------------------------------------------------------------ hash
  function setHash(h) {
    try { history.replaceState(null, '', h ? '#' + h : location.pathname + location.search); } catch (e) { /* file:// in some browsers */ }
  }
  function readHash() {
    const h = decodeURIComponent(location.hash.slice(1));
    let m = h.match(/^line-(smtuc|mm|sit|cp)-(.+)$/);
    if (m) {
      const Ln = lines.find((l) => l.op === m[1] && (l.slug || l.code) === m[2]);
      if (Ln) return selectLine(Ln.li, 0, { push: false });
    }
    m = h.match(/^plan-([a-z]+-\w+)~([a-z]+-\w+)$/);
    if (m && stopByKey.has(m[1]) && stopByKey.has(m[2])) return hooks.planFromHash(stopByKey.get(m[1]), stopByKey.get(m[2]));
    m = h.match(/^stop-([a-z]+-\w+)$/);
    if (m && stopByKey.has(m[1])) return selectStop(stopByKey.get(m[1]), { push: false });
    // links from before stop codes were used: numbers, valid only for the build that made them
    m = h.match(/^plan-(\d+)-(\d+)$/);
    if (m) return hooks.planFromHash(+m[1], +m[2]);
    m = h.match(/^stop-(\d+)$/);
    if (m && stops[+m[1]]) return selectStop(+m[1], { push: false });
  }

  // ------------------------------------------------------------------ panel: toggles
  function renderToggles() {
    const counts = {};
    OP_ORDER.forEach((op) => { counts[op] = { l: lines.filter((l) => l.op === op).length, s: liveStops.filter((s) => s.op === op).length }; });
    $('#toggles').innerHTML = OP_ORDER.map((op) => `
      <button type="button" class="op-toggle" id="tg-${op}" data-op="${op}" aria-pressed="${state.on[op]}" style="--c:var(--${op})">
        <span class="sw" aria-hidden="true"></span>
        <span class="nm">${esc(OPS[op].name)}<small>${esc(OPS[op].long)}</small></span>
        <span class="ct">${counts[op].l} lines<br>${counts[op].s.toLocaleString('pt-PT')} stops</span>
      </button>`).join('');
  }
  $('#toggles').addEventListener('click', (e) => {
    const b = e.target.closest('.op-toggle'); if (!b) return;
    const op = b.dataset.op; state.on[op] = !state.on[op];
    b.setAttribute('aria-pressed', state.on[op]);
    if (!state.on[op] && state.sel && state.sel.type !== 'plan') {
      const selOp = state.sel.type === 'line' ? lines[state.sel.li].op : stops[state.sel.si].op;
      if (selOp === op) { clearSel(); return; }
    }
    applyVisibility();
    if (!state.sel) renderView();
  });

  // ------------------------------------------------------------------ panel: views
  function renderView() {
    const v = $('#view');
    if (state.sel?.type === 'line') v.innerHTML = lineView();
    else if (state.sel?.type === 'stop') v.innerHTML = stopView();
    else if (state.sel?.type === 'plan') hooks.planRender(v);
    else v.innerHTML = homeView();
  }

  function lineRow(Ln) {
    const via = Ln.op === 'mm' ? (Ln.colourName ? `Linha ${Ln.colourName}` : '')
      : Ln.op === 'cp' ? `${Ln.typeName}${Ln.movec ? '' : ' · not covered by MOVE-C'}` : '';
    return `<li><button type="button" class="row" data-line="${Ln.li}">${badge(Ln)}<span class="t">${esc(lineTitle(Ln))}${via ? `<small>${esc(via)}</small>` : ''}</span></button></li>`;
  }

  function homeView() {
    const q = fold(state.q.trim());
    let html = '';
    if (q) {
      const ls = lines.filter((l) => state.on[l.op] && (fold(l.code) === q || fold(l.code).startsWith(q) || fold(lineTitle(l)).includes(q)))
        .sort((a, b) => (fold(b.code) === q) - (fold(a.code) === q));
      // exact name first, then names starting with the search, then any match
      const seen = new Set(), found = [];
      for (const s of liveStops) {
        const n = fold(s.name);
        if (!state.on[s.op] || !n.includes(q)) continue;
        const k = s.op + '|' + s.name; if (seen.has(k)) continue; seen.add(k);
        found.push({ s, rank: n === q ? 0 : n.startsWith(q) ? 1 : 2 });
      }
      found.sort((a, b) => a.rank - b.rank);
      const ss = found.slice(0, 40).map((f) => f.s);
      // stops first: picking two stops is how journeys are planned
      if (ss.length) html += `<div class="group-h"><span class="label">Stops</span><span class="label">${ss.length}${ss.length >= 40 ? '+' : ''}</span></div><ul class="list">${ss.map((s) => `
        <li><button type="button" class="row" data-stop="${s.i}"><span class="stop-ico" style="--c:var(--${s.op})"><i></i></span>
        <span class="t">${esc(s.name)}<small>${esc(OPS[s.op].name)} · ${[...new Set(linesAt(s).map((e) => e.L.code))].slice(0, 8).join(', ')}</small></span></button></li>`).join('')}</ul>`;
      if (ls.length) html += `<div class="group-h"><span class="label">Lines</span><span class="label">${ls.length}</span></div><ul class="list">${ls.slice(0, 60).map(lineRow).join('')}</ul>`;
      if (!html) html = `<p class="empty">Nothing matches “${esc(state.q)}” in the overlays that are switched on.</p>`;
      return html;
    }
    OP_ORDER.filter((op) => state.on[op]).forEach((op) => {
      const ls = lines.filter((l) => l.op === op);
      html += `<div class="group-h"><span class="label">${esc(OPS[op].name)}</span><span class="label">${ls.length} lines</span></div><ul class="list">${ls.map(lineRow).join('')}</ul>`;
    });
    return html || '<p class="empty">Switch on an overlay to list its lines.</p>';
  }

  const SRC_NOTE = {
    gtfs: 'Route drawn from the official SMTUC GTFS shape.',
    kmz: 'Route traced along the official Metrobus corridor (Metro Mondego network file).',
    osrm: 'Path computed between consecutive stops on the OpenStreetMap road network. Short stretches may differ from the real bus route.',
    stops: 'No road path computed for this variant yet. The dashed line joins the stops in order and does not follow roads.',
    stations: 'CP does not publish track shapes. The line is drawn through every station along the railway, so curves between stations are simplified.',
    rail: 'CP does not publish track shapes. The route is traced along the railway tracks mapped in OpenStreetMap.',
    'rail-partial': 'CP does not publish track shapes. The route is traced along the railway tracks mapped in OpenStreetMap, except a short stretch drawn straight between stations where the mapped track is incomplete.',
  };

  function roadLabel(r) {
    const m = r.match(/^(.*?)\s*\(([^)]+)\)$/);
    const isRef = (t) => /^(A|IC|IP|EN|ER|EM|CM|N|R|VCI|VL)\s?-?\s?\d/.test(t);
    if (m) return `${esc(m[1])} <span class="road-ref">${esc(m[2])}</span>`;
    if (isRef(r)) return `<span class="road-ref">${esc(r)}</span>`;
    return esc(r);
  }

  function lineView() {
    const Ln = lines[state.sel.li], p = Ln.pats[state.sel.pi], c = lineColour(Ln);
    const opName = OPS[Ln.op].name + (Ln.op === 'mm' && Ln.colourName ? ` · Linha ${Ln.colourName}` : '') + (Ln.op === 'cp' ? ` · ${Ln.typeName}` : '');
    // which CP services MOVE-C covers is not published per service type; this is the working assumption
    const movecNote = Ln.op !== 'cp' ? '' : Ln.movec
      ? '<p class="note" style="margin:0 0 10px">Covered by MOVE-C passes within the Região de Coimbra (Urbano, Regional and InterRegional trains).</p>'
      : '<p class="note" style="margin:0 0 10px">Not covered by MOVE-C as far as we know: Intercidades and Alfa Pendular usually need a CP ticket.</p>';
    const variants = Ln.pats.map((q) => `
      <button type="button" class="variant" data-pat="${q.pi}" aria-pressed="${q.pi === p.pi}" style="--c:${c}">
        <span class="to">To ${esc(headsign(q))}</span><span class="km">${fmtKm(q.km)}</span>
        <span class="meta">From ${esc(origin(q))} · ${q.s.length} stops${q.f ? ` · first ${q.f}, last ${q.l}` : ''} · ${q.n} scheduled trip${q.n === 1 ? '' : 's'}${q.var && q.var !== Ln.name ? `<br>${esc(q.var)}` : ''}</span>
      </button>`).join('');

    const stopList = p.s.map((si, k) => {
      const s = stops[si];
      const others = linesAt(s).filter((e) => e.L.li !== Ln.li);
      const chips = others.slice(0, 5).map((e) => { const oc = lineColour(e.L); return `<span class="xb" style="--c:${oc};--tc:${textOn(oc)}">${esc(e.L.code)}</span>`; }).join('')
        + (others.length > 5 ? `<span class="xb" style="--c:var(--faint)">+${others.length - 5}</span>` : '');
      const end = k === 0 || k === p.s.length - 1;
      return `<li class="${end ? 'end' : ''}"><button type="button" data-stop="${si}"><span class="dot" aria-hidden="true"></span><span class="nm">${esc(s.name)}</span><span class="x">${chips}</span></button></li>`;
    }).join('');

    const roads = p.r.length
      ? `<ol class="roads">${p.r.map(([n, m]) => `<li><span>${roadLabel(n)}</span><span>${fmtM(m)}</span></li>`).join('')}</ol>`
      : `<p class="note">${Ln.op === 'mm' ? 'Metrobus runs on its own dedicated busway for most of the route; road names are not listed.'
        : Ln.op === 'cp' ? 'Trains run on the railway, so no roads are listed.' : 'Road names are not available for this variant.'}</p>`;

    return `
      <button type="button" class="back" data-act="home">← All lines</button>
      <div class="d-head">${badge(Ln)}<div><h2>${esc(lineTitle(Ln))}</h2><div class="op">${esc(opName)}</div></div></div>
      ${movecNote}${hooks.lineLiveHtml(Ln)}
      <div class="section"><span class="label">Variants · ${Ln.pats.length}</span><div class="variants">${variants}</div></div>
      <div class="section"><span class="label">Stops · ${p.s.length}</span><p class="note" style="margin:0">Badges show other lines that also call at the stop.</p><ol class="stops" style="--c:${c}">${stopList}</ol></div>
      <div class="section"><span class="label">Roads taken, in order</span>${roads}<p class="note" style="margin:0">${esc(SRC_NOTE[p.src] || '')}</p></div>`;
  }

  function stopView() {
    const s = stops[state.sel.si];
    const at = linesAt(s);
    const served = at.map((e) => `
      <button type="button" class="served-row" data-line="${e.L.li}" data-pat="${e.pats[0].pi}">${badge(e.L)}
      <span class="t">${esc(lineTitle(e.L))}<small>${[...e.heads].map((h) => (h === 'terminus' ? 'Ends here' : 'To ' + esc(h))).join(' · ')}</small></span></button>`).join('');

    const near = nearbyStops(s);
    // collapse same-name same-operator stops (opposite sides of the street)
    const groups = new Map();
    near.forEach(({ s: n, d }) => {
      const k = n.op + '|' + n.name;
      if (!groups.has(k)) groups.set(k, { n, d, lines: new Map() });
      linesAt(n).forEach((e) => groups.get(k).lines.set(e.L.li, e.L));
    });
    const nearHtml = [...groups.values()].slice(0, 14).map((g) => `
      <div class="nearby-item nearby"><h4><button type="button" class="linklike" data-stop="${g.n.i}">${esc(g.n.name)}</button><span>${esc(OPS[g.n.op].name)} · ${fmtM(g.d)}</span></h4>
      <div class="chips">${[...g.lines.values()].map((Ln) => `<button type="button" class="chip-btn" data-line="${Ln.li}" title="${esc(lineTitle(Ln))}">${badge(Ln, 'sm')}</button>`).join('')}</div></div>`).join('');

    const allCodes = new Set(at.map((e) => e.L.op + e.L.code));
    groups.forEach((g) => g.lines.forEach((Ln) => allCodes.add(Ln.op + Ln.code)));

    return `
      <button type="button" class="back" data-act="home">← All lines</button>
      <div class="d-head"><span class="stop-ico" style="--c:var(--${s.op})"><i style="width:18px;height:18px;border-width:4px"></i></span>
        <div><h2>${esc(s.name)}</h2><div class="op">${esc(OPS[s.op].name)}${s.code ? ` · stop ${esc(s.code)}` : ''}</div></div></div>
      ${hooks.planButtonsHtml(s)}
      <div class="section" id="deps">${hooks.departuresHtml(s)}</div>
      <div class="section"><span class="label">Lines stopping here · ${at.length}</span><div class="served">${served || '<p class="empty">No scheduled service at this stop.</p>'}</div></div>
      <div class="section"><span class="label">Within ${NEARBY_M} m walk · ${allCodes.size} lines in total</span>
        ${nearHtml || '<p class="note" style="margin:0">No other stops within ' + NEARBY_M + ' m.</p>'}</div>`;
  }

  $('#view').addEventListener('click', (e) => {
    const t = e.target.closest('[data-line],[data-stop],[data-pat],[data-act]');
    if (!t) return;
    if (t.dataset.act === 'home') return clearSel();
    if (t.dataset.line) return selectLine(+t.dataset.line, t.dataset.pat ? +t.dataset.pat : 0);
    if (t.dataset.stop) return selectStop(+t.dataset.stop);
    if (t.dataset.pat && state.sel?.type === 'line') return selectLine(state.sel.li, +t.dataset.pat);
  });

  $('#q').addEventListener('input', (e) => {
    state.q = e.target.value;
    if (state.sel) { state.sel = null; selLayer.clearLayers(); applyVisibility(); setHash(''); }
    renderView();
  });
  $('#q').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = $('#view [data-line],#view [data-stop]');
    if (first) first.click();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.sel) clearSel(); });

  // ------------------------------------------------------------------ vehicles (timetable + SMTUC GPS)
  const GPS_URL = 'https://api.planner.agit.pt/v1/datasets/smtuc/realtime/vehicles';
  const GPS_MAX_AGE_S = 300;
  const veh = {
    on: true, ready: false, offsetMs: 0, tt: null,
    dayCache: new Map(), patRows: new Map(), tripRow: new Map(),
    gps: { byRow: new Map(), loose: [], at: 0, ok: null },
    markers: new Map(), active: [], lastDeps: 0,
  };
  const vehLayer = L.layerGroup().addTo(map);

  // --- Lisbon wall clock, independent of the viewer's time zone
  const LIS = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  function lisbon(ms) {
    const p = Object.fromEntries(LIS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, secs: +p.hour * 3600 + +p.minute * 60 + +p.second };
  }
  function lisbonToMs(date, secs) {
    const [y, m, d] = date.split('-').map(Number);
    const guess = Date.UTC(y, m - 1, d) + secs * 1000;
    const l = lisbon(guess);
    const [ly, lm, ld] = l.date.split('-').map(Number);
    const off = Date.UTC(ly, lm - 1, ld) + l.secs * 1000 - guess;
    return guess - off;
  }
  function addDays(date, n) {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
  const nowMs = () => Date.now() + veh.offsetMs;
  const hhmm = (secs) => { const s = ((secs % 86400) + 86400) % 86400; return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`; };

  // --- calendars
  function runsOn(c, date) {
    const [from, bits] = veh.tt.cal[c];
    const i = Math.round((Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) - Date.UTC(+from.slice(0, 4), +from.slice(4, 6) - 1, +from.slice(6, 8))) / 864e5);
    return i >= 0 && bits[i] === '1';
  }
  function dayRows(date) {
    if (!veh.dayCache.has(date)) {
      const out = [];
      veh.tt.j.forEach((r, i) => { const c = r[2]; if (Array.isArray(c) ? c.some((x) => runsOn(x, date)) : runsOn(c, date)) out.push(i); });
      veh.dayCache.set(date, out);
      if (veh.dayCache.size > 6) veh.dayCache.delete(veh.dayCache.keys().next().value);
    }
    return veh.dayCache.get(date);
  }

  // --- geometry along a pattern
  function cum(p) {
    if (!p.cum) { p.cum = [0]; for (let i = 1; i < p.pts.length; i++) p.cum.push(p.cum[i - 1] + metres(p.pts[i - 1], p.pts[i])); }
    return p.cum;
  }
  function pointAt(p, d) {
    const c = cum(p);
    let lo = 0, hi = c.length - 1;
    if (d <= 0) return p.pts[0];
    if (d >= c[hi]) return p.pts[hi];
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c[mid] <= d) lo = mid; else hi = mid; }
    const f = (d - c[lo]) / ((c[hi] - c[lo]) || 1);
    return [p.pts[lo][0] + f * (p.pts[hi][0] - p.pts[lo][0]), p.pts[lo][1] + f * (p.pts[hi][1] - p.pts[lo][1])];
  }
  // where a trip is `rel` seconds after its first departure
  function progress(p, prof, rel) {
    const n = p.s.length;
    for (let k = 0; k < n; k++) {
      const a = prof[2 * k], d = prof[2 * k + 1];
      if (rel <= d) {
        if (rel >= a || k === 0) return { k, next: k, dist: p.sd[k], at: true };
        const pd = prof[2 * k - 1], f = (rel - pd) / ((a - pd) || 1);
        return { k: k - 1, next: k, dist: p.sd[k - 1] + f * (p.sd[k] - p.sd[k - 1]), at: false };
      }
    }
    return { k: n - 1, next: n - 1, dist: p.sd[n - 1], at: true };
  }
  // scheduled offset (s) at a distance along the route: turns a GPS fix into a delay
  function relAtDist(p, prof, d) {
    for (let k = 0; k < p.s.length - 1; k++) {
      if (d <= p.sd[k + 1]) {
        const span = p.sd[k + 1] - p.sd[k];
        const f = span > 0 ? Math.max(0, (d - p.sd[k]) / span) : 0;
        return prof[2 * k + 1] + f * (prof[2 * k + 2] - prof[2 * k + 1]);
      }
    }
    return prof[prof.length - 2];
  }
  // GPS fix -> distance along the route and delay. Among route points within 150 m, take the one
  // closest to where the timetable puts the bus, so loops and shared stretches do not mismatch.
  function gpsProgress(p, prof, ll, rel, schedDist) {
    const c = cum(p);
    let bi = -1, bestGap = Infinity;
    for (let i = 0; i < p.pts.length; i++) {
      if (metres(ll, p.pts[i]) > 150) continue;
      const gap = Math.abs(c[i] - schedDist);
      if (gap < bestGap) { bestGap = gap; bi = i; }
    }
    if (bi < 0) return null;
    return { along: c[bi], delay: Math.round(rel - relAtDist(p, prof, c[bi])) };
  }

  // --- which trips run now (today's service, plus yesterday's trips running past midnight)
  function computeActive() {
    const { date, secs } = lisbon(nowMs());
    const out = [];
    [[date, secs], [addDays(date, -1), secs + 86400]].forEach(([d, T]) => {
      for (const i of dayRows(d)) {
        const r = veh.tt.j[i], prof = veh.tt.prof[r[4]], rel = T - r[3];
        if (rel >= 0 && rel <= prof[prof.length - 2]) out.push({ i, r, rel, prof });
      }
    });
    return out;
  }

  function lineVisible(li) {
    const Ln = lines[li];
    if (!state.on[Ln.op]) return false;
    if (state.sel?.type === 'line') return li === state.sel.li;
    if (state.sel?.type === 'stop') return stops[state.sel.si].serves.some((x) => x.li === li);
    if (state.sel?.type === 'plan') return hooks.planLines().has(li);
    return true;
  }

  function vehIcon(Ln, live) {
    const c = lineColour(Ln);
    return L.divIcon({ className: 'veh-wrap', iconSize: [0, 0], html: `<span class="veh ${live ? 'gps' : 'sched'}" style="--c:${c};--tc:${textOn(c)}">${esc(Ln.code)}</span>` });
  }
  function placeMarker(key, Ln, ll, live, info) {
    let m = veh.markers.get(key);
    const sig = Ln.li + (live ? 'g' : 's');
    if (!m) {
      m = L.marker(ll, { icon: vehIcon(Ln, live), keyboard: false, riseOnHover: true });
      m.bindPopup(() => popupHtml(m._info), { className: 'veh-pop', maxWidth: 280 });
      m._sig = sig;
      vehLayer.addLayer(m);
      veh.markers.set(key, m);
    } else {
      m.setLatLng(ll);
      if (m._sig !== sig) { m.setIcon(vehIcon(Ln, live)); m._sig = sig; }
    }
    m._info = info;
    m._seen = true;
  }

  function tick() {
    if (!veh.ready) return;
    renderClock();
    veh.markers.forEach((m) => { m._seen = false; });
    const counts = Object.fromEntries(OP_ORDER.map((op) => [op, [0, 0]]));
    veh.active = veh.on ? computeActive() : [];
    if (veh.on) {
      const live = veh.offsetMs === 0;
      for (const a of veh.active) {
        const [li, pi] = a.r, Ln = lines[li], p = Ln.pats[pi];
        const g = live ? veh.gps.byRow.get(a.i) : null;
        counts[Ln.op][0]++;
        if (g) counts[Ln.op][1]++;
        if (!lineVisible(li)) continue;
        const pr = progress(p, a.prof, a.rel);
        const ll = g ? g.ll : pointAt(p, pr.dist);
        const gp = g ? gpsProgress(p, a.prof, g.ll, a.rel, pr.dist) : null;
        placeMarker('t' + a.i + (a.rel > 86400 ? 'y' : ''), Ln, ll, !!g, { Ln, p, a, pr, g, gp });
      }
      if (live) {
        // GPS vehicles whose trip id is not in the published timetable
        for (const g of veh.gps.loose) {
          const Ln = lines.find((l) => l.op === 'smtuc' && l.code === g.route);
          if (!Ln) continue;
          counts.smtuc[0]++; counts.smtuc[1]++;
          if (lineVisible(Ln.li)) placeMarker('g' + g.id, Ln, g.ll, true, { Ln, g, loose: true });
        }
      }
    }
    veh.markers.forEach((m, k) => { if (!m._seen) { vehLayer.removeLayer(m); veh.markers.delete(k); } });
    renderStats(counts);
    const lv = $('#line-live');
    if (lv && state.sel?.type === 'line') lv.outerHTML = hooks.lineLiveHtml(lines[state.sel.li]);
    if (state.sel?.type === 'stop' && Date.now() - veh.lastDeps > 20000) {
      const el = $('#deps'); if (el) el.innerHTML = hooks.departuresHtml(stops[state.sel.si]);
      veh.lastDeps = Date.now();
    }
  }

  function fmtDelay(s) {
    if (s == null) return '';
    const m = Math.round(s / 60);
    if (Math.abs(m) < 1) return 'on time';
    return m > 0 ? `about ${m} min late` : `about ${-m} min early`;
  }

  function popupHtml(info) {
    const { Ln, p, a, pr, g, gp, loose } = info;
    const delay = gp ? gp.delay : null;
    const head = loose ? '' : `To ${esc(headsign(p))}`;
    let body = '';
    if (!loose) {
      let next, at;
      if (gp) {
        next = p.sd.findIndex((d) => d > gp.along + 20);
        if (next < 0) next = p.s.length - 1;
        at = false;
      } else {
        next = pr.at ? pr.k : pr.next;
        at = pr.at;
      }
      const nextStop = stops[p.s[next]];
      const due = a.r[3] + a.prof[2 * next];
      const late = delay != null && Math.abs(delay) >= 60 ? ` · expected ${hhmm(due + delay)}` : '';
      body += `<div>${at ? 'At' : 'Next stop'}: <b>${esc(nextStop.name)}</b> · ${hhmm(due)}${late}</div>`;
      body += `<div class="muted">Left ${esc(origin(p))} at ${hhmm(a.r[3])} · arrives ${hhmm(a.r[3] + a.prof[a.prof.length - 2])}</div>`;
    }
    const src = g
      ? `<span class="pill gps">Live GPS</span> updated ${Math.max(0, Math.round((Date.now() - g.t) / 1000))} s ago${delay != null ? ' · ' + fmtDelay(delay) : ' · off the drawn route'}`
      : '<span class="pill sched">Timetable estimate</span> position from the schedule, not GPS';
    return `<div class="vp">${badge(Ln, 'sm')} <b>${head}</b><div class="muted">${esc(OPS[Ln.op].name)}${loose ? ' · trip not in the published timetable' : ''}</div>
      ${body}<div class="src">${src}</div>
      <button type="button" class="vp-btn" data-vline="${Ln.li}" data-vpat="${p ? p.pi : 0}">Show line ${esc(Ln.code)}</button></div>`;
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-vline]'); if (!b) return;
    map.closePopup(); selectLine(+b.dataset.vline, +b.dataset.vpat);
  });

  // --- SMTUC GPS
  async function pollGps() {
    if (!veh.ready || !veh.on || veh.offsetMs !== 0) return;
    try {
      const res = await fetch(GPS_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      const byRow = new Map(), loose = [];
      for (const v of body.data || []) {
        const loc = (v.locations || [])[0];
        const t = Date.parse(v.observedAt);
        if (!loc || !(Date.now() - t < GPS_MAX_AGE_S * 1000)) continue;
        const g = { id: v.vehicleId, ll: [loc.lat, loc.lon], t, route: v.routeId };
        const row = veh.tripRow.get(v.tripId);
        if (row != null) byRow.set(row, g); else loose.push(g);
      }
      veh.gps = { byRow, loose, at: Date.now(), ok: true };
    } catch (err) {
      veh.gps = { byRow: new Map(), loose: [], at: Date.now(), ok: false };
    }
    tick();
  }

  // --- panel: clock, stats, line + stop sections
  function renderClock() {
    const { date, secs } = lisbon(nowMs());
    const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)));
    const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    $('#clock').innerHTML = `<b>${hhmm(secs)}</b> ${esc(day)}${veh.offsetMs ? ' <span class="pill sched">chosen time</span>' : ''}`;
  }
  function renderStats(c) {
    if (!veh.on) { $('#vstats').textContent = 'Vehicles hidden'; return; }
    const gpsNote = veh.offsetMs !== 0 ? 'Live GPS only at the current time'
      : veh.gps.ok === false ? 'SMTUC GPS unavailable, showing timetable only'
        : veh.gps.ok ? `${c.smtuc[1]} SMTUC on live GPS` : 'Connecting to SMTUC GPS…';
    $('#vstats').innerHTML = OP_ORDER.filter((op) => state.on[op]).map((op) => `<span><b>${c[op][0]}</b> ${esc(OPS[op].name)}</span>`).join('') + `<span class="gpsnote">${esc(gpsNote)}</span>`;
  }

  hooks.onView = () => { if (veh.ready) tick(); };
  hooks.lineLiveHtml = (Ln) => {
    if (!veh.ready || !veh.on) return '';
    const act = veh.active.filter((a) => a.r[0] === Ln.li);
    const g = act.filter((a) => veh.offsetMs === 0 && veh.gps.byRow.has(a.i)).length;
    return `<p class="note live-note" id="line-live">${act.length ? `<b>${act.length}</b> vehicle${act.length === 1 ? '' : 's'} on this line now${g ? `, ${g} on live GPS` : ''}. Click one on the map for its next stop.` : 'No vehicle on this line right now, according to the timetable.'}</p>`;
  };
  hooks.departuresHtml = (s) => {
    if (!veh.ready) return '<span class="label">Next departures</span><p class="note" style="margin:0">Loading timetables…</p>';
    const { date, secs } = lisbon(nowMs());
    const today = new Set(dayRows(date)), yday = new Set(dayRows(addDays(date, -1)));
    const out = [];
    for (const { li, pi, pos } of s.serves) {
      const p = lines[li].pats[pi];
      if (pos === p.s.length - 1) continue;
      for (const i of veh.patRows.get(li + ':' + pi) || []) {
        const r = veh.tt.j[i], prof = veh.tt.prof[r[4]], dep = r[3] + prof[2 * pos + 1];
        [[today, dep], [yday, dep - 86400]].forEach(([set, T]) => {
          if (set.has(i) && T >= secs - 60 && T <= secs + 3 * 3600) out.push({ T, li, p, i });
        });
      }
    }
    out.sort((a, b) => a.T - b.T);
    const rows = out.slice(0, 12).map((o) => {
      const Ln = lines[o.li], mins = Math.round((o.T - secs) / 60);
      const g = veh.offsetMs === 0 ? veh.gps.byRow.get(o.i) : null;
      return `<li><button type="button" data-line="${o.li}" data-pat="${o.p.pi}"><span class="dt">${hhmm(o.T)}</span>${badge(Ln, 'sm')}<span class="dh">To ${esc(headsign(o.p))}${g ? ' <span class="pill gps">GPS</span>' : ''}</span><span class="dm">${mins <= 0 ? 'now' : mins < 60 ? `${mins} min` : ''}</span></button></li>`;
    }).join('');
    return `<span class="label">Next departures${veh.offsetMs ? ' from chosen time' : ''}</span>${rows ? `<ol class="deps">${rows}</ol>` : '<p class="note" style="margin:0">No departures in the next 3 hours.</p>'}<p class="note" style="margin:0">Scheduled times. SMTUC buses on live GPS are marked.</p>`;
  };

  // --- controls
  $('#veh-toggle').addEventListener('click', (e) => {
    veh.on = !veh.on; e.currentTarget.setAttribute('aria-pressed', veh.on);
    tick(); if (veh.on) pollGps();
  });
  $('#time-btn').addEventListener('click', () => {
    const f = $('#time-form'); f.hidden = !f.hidden;
    if (!f.hidden) { const { date, secs } = lisbon(nowMs()); $('#t-date').value = date; $('#t-time').value = hhmm(secs); }
  });
  $('#time-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const d = $('#t-date').value, t = $('#t-time').value;
    if (!d || !t) return;
    const [h, m] = t.split(':').map(Number);
    veh.offsetMs = lisbonToMs(d, h * 3600 + m * 60) - Date.now();
    $('#time-form').hidden = true; tick(); renderView();
  });
  $('#t-now').addEventListener('click', () => { veh.offsetMs = 0; $('#time-form').hidden = true; tick(); pollGps(); renderView(); });

  function vehFail(msg) {
    $('#clock').textContent = 'Vehicles unavailable';
    $('#vstats').textContent = msg;
  }
  function initVehicles() {
    clearTimeout(slowTimer);
    veh.tt = window.TIMETABLE;
    if (!veh.tt || !Array.isArray(veh.tt.j)) return vehFail('timetable.js loaded but holds no timetable. Upload the timetable.js produced by the same build as data.js.');
    if (veh.tt.generated !== DATA.generated) {
      return vehFail(`timetable.js (${veh.tt.generated || 'older build'}) and data.js (${DATA.generated}) come from different builds. Upload both files from the same build.`);
    }
    veh.tt.j.forEach((r, i) => {
      const k = r[0] + ':' + r[1];
      if (!veh.patRows.has(k)) veh.patRows.set(k, []);
      veh.patRows.get(k).push(i);
      if (r[5]) veh.tripRow.set(r[5], i);
    });
    veh.ready = true;
    try { tick(); } catch (err) { veh.ready = false; return vehFail('Vehicle positions failed: ' + err.message); }
    renderView(); pollGps();
    setInterval(() => { if (!document.hidden) tick(); }, 2000);
    setInterval(() => { if (!document.hidden) pollGps(); }, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - veh.gps.at > 30000) pollGps(); });
  }
  map.on('zoomend', () => map.getContainer().classList.toggle('zlow', map.getZoom() < 13));
  map.getContainer().classList.toggle('zlow', map.getZoom() < 13);
  // The build stamp in the URL makes each deploy fetch its own timetable instead of a cached one.
  const ttScript = document.createElement('script');
  ttScript.src = 'timetable.js?v=' + encodeURIComponent(DATA.generated);
  ttScript.onload = initVehicles;
  ttScript.onerror = () => { clearTimeout(slowTimer); vehFail('timetable.js was not found next to index.html. Upload it with the other files.'); };
  const slowTimer = setTimeout(() => { if (!veh.ready) $('#vstats').textContent = 'Still downloading timetables (1 MB)…'; }, 8000);
  document.head.appendChild(ttScript);

  // ------------------------------------------------------------------ user location
  // The position stays in the browser: it is only used to draw the dot and centre the map.
  const REGION = L.latLngBounds([39.8, -8.95], [40.7, -7.65]); // Região de Coimbra, with margin
  const me = { ll: null, dot: null, acc: null, watch: null, state: 'idle', autoCentre: false, userAsked: false };
  const LOC_MSG = {
    idle: 'Show my location',
    locating: 'Finding your location…',
    on: 'Centre on my location',
    denied: 'Location is blocked for this site. Allow it in the browser settings to see your position.',
    unavailable: 'Your location is not available right now.',
    insecure: 'Location only works when the site is opened over https.',
    unsupported: 'This browser cannot share its location.',
  };

  let locBtn = null;
  const LocateControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const bar = L.DomUtil.create('div', 'leaflet-bar locate-bar');
      locBtn = L.DomUtil.create('button', 'locate-btn', bar);
      locBtn.type = 'button';
      locBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      L.DomEvent.disableClickPropagation(bar);
      L.DomEvent.on(locBtn, 'click', () => locate({ userAsked: true }));
      setLocState(me.state);
      return bar;
    },
  });
  new LocateControl().addTo(map);

  function setLocState(s) {
    me.state = s;
    if (!locBtn) return;
    locBtn.dataset.state = s;
    locBtn.title = LOC_MSG[s];
    locBtn.setAttribute('aria-label', LOC_MSG[s]);
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
  }

  function centreOnMe() {
    if (!me.ll) return;
    if (REGION.contains(me.ll)) map.setView(me.ll, Math.max(map.getZoom(), 15));
    else if (me.userAsked) toast('You are outside the Região de Coimbra, so the map stays where it is.');
  }

  function onPosition(pos) {
    const { latitude, longitude, accuracy } = pos.coords;
    me.ll = [latitude, longitude];
    const acc = Math.round(accuracy);
    if (!me.dot) {
      me.dot = L.marker(me.ll, {
        icon: L.divIcon({ className: 'me-wrap', iconSize: [0, 0], html: '<span class="me-dot"></span>' }),
        keyboard: false, zIndexOffset: 1000,
      }).addTo(map);
      // on the shared canvas: a second canvas would block clicks on the network again
      me.acc = L.circle(me.ll, { renderer: rMain, radius: acc, interactive: false, weight: 1 }).addTo(map);
    }
    me.dot.setLatLng(me.ll).bindTooltip(`You are here · within ${fmtM(acc)}`, { className: 'tt', direction: 'top', offset: [0, -10] });
    me.acc.setLatLng(me.ll).setRadius(Math.min(acc, 2000))
      .setStyle({ color: cssVar('--focus'), fillColor: cssVar('--focus'), fillOpacity: 0.1, opacity: acc > 2000 ? 0 : 0.5 });
    const first = me.state !== 'on';
    setLocState('on');
    if (me.userAsked || (first && me.autoCentre && !state.sel)) centreOnMe();
    me.userAsked = false;
    me.autoCentre = false;
  }

  function onPositionError(err) {
    const state = err.code === 1 ? 'denied' : 'unavailable';
    if (err.code === 1) stopWatching();
    // on the automatic first try, stay quiet; the button still explains what happened
    if (me.userAsked) toast(LOC_MSG[state]);
    me.userAsked = false;
    me.autoCentre = false;
    if (me.state !== 'on' || err.code === 1) setLocState(state);
  }

  function startWatching() {
    if (me.watch != null) return;
    me.watch = navigator.geolocation.watchPosition(onPosition, onPositionError, { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 });
  }
  function stopWatching() {
    if (me.watch != null) navigator.geolocation.clearWatch(me.watch);
    me.watch = null;
  }

  function locate({ userAsked = false, autoCentre = false } = {}) {
    if (!('geolocation' in navigator)) { setLocState('unsupported'); if (userAsked) toast(LOC_MSG.unsupported); return; }
    if (!window.isSecureContext) { setLocState('insecure'); if (userAsked) toast(LOC_MSG.insecure); return; }
    me.userAsked = userAsked;
    me.autoCentre = autoCentre;
    if (userAsked && me.state === 'on' && me.ll) { centreOnMe(); me.userAsked = false; return; }
    if (me.state === 'denied' && me.watch == null && !userAsked) return;
    setLocState('locating');
    stopWatching();
    startWatching();
  }

  // Pause GPS while the tab is hidden (battery); resume without moving the map.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopWatching();
    else if (me.state === 'on') startWatching();
  });
  // Once the user moves the map or picks something, a late first fix must not yank the view.
  map.on('dragstart', () => { me.autoCentre = false; });

  // ------------------------------------------------------------------ journey planner (RAPTOR)
  // Round k finds the earliest arrival at every stop using at most k vehicles; walking transfers
  // (<= 400 m on foot, from tools/walk_fetch.py) are allowed after each ride and before the first.
  const MAX_RIDES = 3;   // up to two changes
  const CHANGE_S = 60;   // minimum slack to change vehicle
  const WALK_MPS = 1.2;  // walking speed
  const plan = { from: null, to: null, after: null, options: null, key: '', chosen: 0 };
  const netCache = new Map();
  let walkIdx = null;

  function walksFrom(si) {
    if (!walkIdx) {
      walkIdx = new Map();
      const w = veh.tt.walk || [];
      for (let i = 0; i < w.length; i += 3) {
        if (!walkIdx.has(w[i])) walkIdx.set(w[i], []);
        walkIdx.get(w[i]).push([w[i + 1], Math.ceil(w[i + 2] / WALK_MPS), w[i + 2]]);
      }
    }
    return walkIdx.get(si) || [];
  }

  // Trips running on a service day, grouped by pattern; yesterday's trips past midnight included.
  function network(date) {
    if (netCache.has(date)) return netCache.get(date);
    const pats = new Map(), stopPats = new Map();
    const add = (i, shift) => {
      const r = veh.tt.j[i], prof = veh.tt.prof[r[4]], key = r[0] + ':' + r[1];
      if (r[3] + shift + prof[prof.length - 2] < 0) return;
      if (!pats.has(key)) pats.set(key, { li: r[0], pi: r[1], s: lines[r[0]].pats[r[1]].s, trips: [] });
      pats.get(key).trips.push({ i, t0: r[3] + shift, prof });
    };
    dayRows(date).forEach((i) => add(i, 0));
    dayRows(addDays(date, -1)).forEach((i) => add(i, -86400));
    pats.forEach((P, key) => P.s.forEach((si, idx) => {
      if (!stopPats.has(si)) stopPats.set(si, []);
      stopPats.get(si).push([key, idx]);
    }));
    const net = { pats, stopPats };
    netCache.set(date, net);
    if (netCache.size > 3) netCache.delete(netCache.keys().next().value);
    return net;
  }

  function earliestTrip(P, idx, t) {
    let best = null, bd = Infinity;
    for (const tr of P.trips) {
      const d = tr.t0 + tr.prof[2 * idx + 1];
      if (d >= t && d < bd) { bd = d; best = tr; }
    }
    return best;
  }

  function raptor(net, from, to, T) {
    const N = stops.length;
    const tau = [new Float64Array(N).fill(Infinity)], rnd = [new Int8Array(N)];
    const rideP = [new Map()], walkP = [new Map()];
    tau[0][from] = T;
    let marked = new Set([from]);
    for (const [j, secs, m] of walksFrom(from)) {
      if (T + secs < tau[0][j]) { tau[0][j] = T + secs; walkP[0].set(j, { from, secs, m, t: T + secs }); marked.add(j); }
    }
    const best = tau[0].slice();
    for (let k = 1; k <= MAX_RIDES && marked.size; k++) {
      tau[k] = tau[k - 1].slice(); rnd[k] = rnd[k - 1].slice();
      rideP[k] = new Map(); walkP[k] = new Map();
      const Q = new Map();
      for (const si of marked) {
        for (const [key, idx] of net.stopPats.get(si) || []) if (!Q.has(key) || idx < Q.get(key)) Q.set(key, idx);
      }
      for (const [key, idx0] of Q) {
        const P = net.pats.get(key);
        let trip = null, board = -1, boardStop = -1, boardRound = 0;
        for (let i = idx0; i < P.s.length; i++) {
          const si = P.s[i];
          if (trip) {
            const a = trip.t0 + trip.prof[2 * i];
            if (a < Math.min(best[si], best[to])) {
              tau[k][si] = a; rnd[k][si] = k; best[si] = a;
              rideP[k].set(si, { key, trip, board, alight: i, boardStop, boardRound, t: a });
            }
          }
          const t = tau[k - 1][si];
          if (t < Infinity && i < P.s.length - 1) {
            const ready = t + (k > 1 ? CHANGE_S : 0);
            if (!trip || ready <= trip.t0 + trip.prof[2 * i + 1]) {
              const cand = earliestTrip(P, i, ready);
              if (cand && (!trip || cand.t0 + cand.prof[2 * i + 1] < trip.t0 + trip.prof[2 * i + 1])) {
                trip = cand; board = i; boardStop = si; boardRound = rnd[k - 1][si];
              }
            }
          }
        }
      }
      // walk on from where the rides of this round got off (never walk twice in a row)
      for (const [si, e] of [...rideP[k]]) {
        for (const [j, secs, m] of walksFrom(si)) {
          const t = e.t + secs;
          if (t < best[j] && t < best[to]) { tau[k][j] = t; rnd[k][j] = k; best[j] = t; walkP[k].set(j, { from: si, secs, m, t }); }
        }
      }
      marked = new Set([...rideP[k].keys(), ...walkP[k].keys()]);
    }
    return { tau, rnd, rideP, walkP };
  }

  function backtrack(res, k, to) {
    const legs = [];
    let r = res.rnd[k][to], s = to, mustRide = false;
    for (let guard = 0; guard < 12; guard++) {
      const W = mustRide ? null : res.walkP[r].get(s), R = res.rideP[r] && res.rideP[r].get(s);
      if (W && W.t === res.tau[r][s]) {
        legs.unshift({ type: 'walk', from: W.from, to: s, secs: W.secs, m: W.m, arr: W.t });
        s = W.from; mustRide = r > 0;
        if (r === 0) break;
        continue;
      }
      if (!R) break;
      legs.unshift({ type: 'ride', li: veh.tt.j[R.trip.i][0], pi: veh.tt.j[R.trip.i][1], trip: R.trip, board: R.board, alight: R.alight,
        from: R.boardStop, to: s, dep: R.trip.t0 + R.trip.prof[2 * R.board + 1], arr: R.t });
      s = R.boardStop; r = R.boardRound; mustRide = false;
    }
    return legs;
  }

  function journeysFrom(net, from, to, T) {
    const res = raptor(net, from, to, T);
    const out = [];
    let lastArr = Infinity;
    for (let k = 1; k < res.tau.length; k++) {
      const a = res.tau[k][to];
      if (a < lastArr && res.rnd[k][to] === k) {
        const legs = backtrack(res, k, to);
        // arriving at the sibling stop point of the destination (same spot, or same name) is arriving
        const last = legs[legs.length - 1];
        if (last && last.type === 'walk' && legs.length > 1 && (last.m < 30 || stops[last.from].name === stops[last.to].name)) legs.pop();
        const rides = legs.filter((l) => l.type === 'ride');
        if (rides.length) {
          const walkBefore = legs[0].type === 'walk' ? legs[0].secs : 0;
          out.push({ legs, rides: rides.length, dep: rides[0].dep - walkBefore, arr: legs[legs.length - 1].arr, walkM: legs.filter((l) => l.type === 'walk').reduce((x, l) => x + l.m, 0) });
          lastArr = a;
        }
      }
    }
    return out;
  }

  // A few journeys: the best ones leaving from T, then the next departures after each.
  function planJourneys() {
    const { date, secs } = lisbon(nowMs());
    const net = network(date);
    let T = plan.after != null ? plan.after : secs;
    const seen = new Set(), opts = [];
    for (let n = 0; n < 4 && opts.length < 5; n++) {
      const found = journeysFrom(net, plan.from, plan.to, T);
      if (!found.length) break;
      for (const j of found) {
        const sig = j.legs.map((l) => (l.type === 'ride' ? l.trip.i : 'w')).join('>');
        if (!seen.has(sig)) { seen.add(sig); opts.push(j); }
      }
      T = Math.min(...found.map((j) => j.legs.find((l) => l.type === 'ride').dep)) + 60;
    }
    // drop journeys another one beats outright: leaves no earlier, arrives no later, no more changes
    const beats = (b, a) => b !== a && b.dep >= a.dep && b.arr <= a.arr && b.rides <= a.rides
      && (b.dep > a.dep || b.arr < a.arr || b.rides < a.rides || b.walkM < a.walkM);
    const kept = opts.filter((a) => !opts.some((b) => beats(b, a)));
    kept.sort((a, b) => a.dep - b.dep || a.arr - b.arr);
    return { date, from: plan.after != null ? plan.after : secs, opts: kept.slice(0, 5) };
  }

  // --- geometry of a ride: the part of its route between boarding and alighting
  function rideGeometry(leg) {
    const p = lines[leg.li].pats[leg.pi], c = cum(p);
    const d0 = p.sd[leg.board], d1 = p.sd[leg.alight];
    const pts = [pointAt(p, d0)];
    for (let i = 0; i < p.pts.length; i++) if (c[i] > d0 && c[i] < d1) pts.push(p.pts[i]);
    pts.push(pointAt(p, d1));
    return pts;
  }

  function drawJourney(opt) {
    selLayer.clearLayers();
    const bounds = L.latLngBounds([]);
    opt.legs.forEach((leg) => {
      if (leg.type === 'walk') {
        const ll = [stops[leg.from].ll, stops[leg.to].ll];
        L.polyline(ll, { renderer: rMain, color: cssVar('--ink'), weight: 3, dashArray: '2 7', lineCap: 'round', interactive: false }).addTo(selLayer);
        ll.forEach((x) => bounds.extend(x));
        return;
      }
      const Ln = lines[leg.li], c = lineColour(Ln), pts = rideGeometry(leg);
      L.polyline(pts, { renderer: rMain, color: cssVar('--panel'), weight: 10, opacity: 0.95, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(selLayer);
      L.polyline(pts, { renderer: rMain, color: c, weight: 5, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(selLayer);
      pts.forEach((x) => bounds.extend(x));
      const p = Ln.pats[leg.pi];
      for (let k = leg.board; k <= leg.alight; k++) {
        const si = p.s[k], end = k === leg.board || k === leg.alight;
        L.circleMarker(stops[si].ll, { renderer: rMain, radius: end ? 6 : 3.5, color: end ? cssVar('--ink') : c, weight: end ? 3 : 2, fillColor: cssVar('--panel'), fillOpacity: 1 })
          .bindTooltip(`<b>${esc(stops[si].name)}</b>`, { className: 'tt', direction: 'top', offset: [0, -5] })
          .on('click', (e) => { L.DomEvent.stop(e); selectStop(si); }).addTo(selLayer);
      }
    });
    [[plan.from, 'From'], [plan.to, 'To']].forEach(([si, w]) => {
      L.tooltip({ permanent: true, direction: 'top', className: 'endlabel', offset: [0, -10], interactive: false })
        .setLatLng(stops[si].ll).setContent(`${w}: ${esc(stops[si].name)}`).addTo(selLayer);
    });
    return bounds;
  }

  // --- panel
  function setPlanEnd(which, si) {
    plan[which] = si;
    plan.options = null; plan.after = null; plan.chosen = 0;
    renderPlanBar();
    if (plan.from != null && plan.to != null) showPlan();
    else renderView();
  }
  function clearPlan() {
    plan.from = plan.to = plan.after = null; plan.options = null;
    renderPlanBar();
    if (state.sel?.type === 'plan') clearSel(); else renderView();
  }
  function showPlan({ push = true } = {}) {
    state.sel = { type: 'plan' };
    renderView();
    if (push) setHash(`plan-${stopKey(stops[plan.from])}~${stopKey(stops[plan.to])}`);
    showViewTop();
  }

  function renderPlanBar() {
    const bar = $('#planbar');
    if (plan.from == null && plan.to == null) { bar.hidden = true; return; }
    bar.hidden = false;
    const end = (si, label, which) => si == null
      ? `<span class="pe empty"><span class="pl">${label}</span>Pick a stop: search or click one on the map</span>`
      : `<span class="pe"><span class="pl">${label}</span><button type="button" class="linklike" data-stop="${si}">${esc(stops[si].name)}</button><button type="button" class="px" data-plan-clear="${which}" aria-label="Remove ${label.toLowerCase()} stop">×</button></span>`;
    bar.innerHTML = `<div class="pb-head"><span class="label">Journey</span>
      <span class="pb-act">${plan.from != null && plan.to != null ? '<button type="button" class="linklike small" data-plan-act="swap">Swap</button><button type="button" class="linklike small" data-plan-act="show">Show journeys</button>' : ''}<button type="button" class="linklike small" data-plan-act="clear">Clear</button></span></div>
      ${end(plan.from, 'From', 'from')}${end(plan.to, 'To', 'to')}`;
  }
  $('#planbar').addEventListener('click', (e) => {
    const t = e.target.closest('[data-plan-act],[data-plan-clear],[data-stop]');
    if (!t) return;
    if (t.dataset.stop) return selectStop(+t.dataset.stop);
    if (t.dataset.planClear) return setPlanEnd(t.dataset.planClear, null);
    const act = t.dataset.planAct;
    if (act === 'clear') return clearPlan();
    if (act === 'swap') { [plan.from, plan.to] = [plan.to, plan.from]; plan.options = null; plan.after = null; renderPlanBar(); return showPlan(); }
    if (act === 'show') return showPlan();
  });

  // Intercidades / Alfa Pendular legs: shown, but flagged as outside MOVE-C
  function notCovered(o) {
    const nc = [...new Set(o.legs.filter((l) => l.type === 'ride' && lines[l.li].movec === false).map((l) => lines[l.li].code))];
    return nc.length ? ` <span class="pill nc">${esc(nc.join(', '))} not covered by MOVE-C</span>` : '';
  }
  const dur = (s) => { const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; };

  hooks.planButtonsHtml = (s) => `<div class="plan-btns">
      <button type="button" class="btn ghost" data-plan-set="from" data-si="${s.i}"${plan.from === s.i ? ' aria-pressed="true"' : ''}>From here</button>
      <button type="button" class="btn ghost" data-plan-set="to" data-si="${s.i}"${plan.to === s.i ? ' aria-pressed="true"' : ''}>To here</button></div>`;
  $('#view').addEventListener('click', (e) => {
    const b = e.target.closest('[data-plan-set],[data-opt],[data-plan-later]');
    if (!b) return;
    e.stopPropagation();
    if (b.dataset.planSet) return setPlanEnd(b.dataset.planSet, +b.dataset.si);
    if (b.dataset.opt) { plan.chosen = +b.dataset.opt; return renderView(); }
    if (b.dataset.planLater) { plan.after = +b.dataset.planLater; plan.options = null; plan.chosen = 0; renderView(); }
  }, true);

  hooks.planView = () => {
    const A = stops[plan.from], B = stops[plan.to];
    let body;
    if (plan.from === plan.to) body = '<p class="note">Pick two different stops.</p>';
    else if (!veh.ready) body = '<p class="note">Loading timetables…</p>';
    else {
      const key = `${plan.from}-${plan.to}-${plan.after}-${Math.floor(nowMs() / 60000)}`;
      if (!plan.options || plan.key.split('-').slice(0, 3).join('-') !== key.split('-').slice(0, 3).join('-')) {
        const t0 = performance.now();
        plan.options = planJourneys(); plan.key = key; plan.ms = Math.round(performance.now() - t0);
        plan.chosen = Math.min(plan.chosen, Math.max(0, plan.options.opts.length - 1));
      }
      const { opts, from } = plan.options;
      if (!opts.length) body = `<p class="note">No journey found from ${hhmm(from)} with up to ${MAX_RIDES - 1} changes and walks of up to 400 m. Try a later time, or a stop on a main line.</p>`;
      else {
        const cards = opts.map((o, n) => {
          // short changes between stop points on the same spot are not worth a "walk" chip
          const chain = o.legs.filter((l) => l.type === 'ride' || l.m >= 30)
            .map((l) => (l.type === 'ride' ? badge(lines[l.li], 'sm') : `<span class="walk-ico" title="Walk ${fmtM(l.m)}">walk</span>`)).join('<span class="chev">›</span>');
          return `<button type="button" class="variant opt" data-opt="${n}" aria-pressed="${n === plan.chosen}" style="--c:var(--focus)">
            <span class="to">${hhmm(o.dep)} → ${hhmm(o.arr)}</span><span class="km">${dur(o.arr - o.dep)}</span>
            <span class="meta"><span class="chain">${chain}</span>${o.rides - 1 ? `${o.rides - 1} change${o.rides > 2 ? 's' : ''}` : 'Direct'}${o.walkM ? ` · ${fmtM(o.walkM)} walk` : ''}${notCovered(o)}</span></button>`;
        }).join('');
        const o = opts[plan.chosen];
        const legs = o.legs.map((l, n) => {
          if (l.type === 'walk') {
            // a walk is timed to reach the next vehicle, not from when the search started
            const next = o.legs[n + 1], start = next && next.type === 'ride' ? next.dep - l.secs : l.arr - l.secs;
            const toStop = `<button type="button" class="linklike" data-stop="${l.to}">${esc(stops[l.to].name)}</button>`;
            const what = l.m < 30 ? (n === 0 ? `Start from the ${esc(OPS[stops[l.to].op].name)} stop ${toStop}, at the same place` : `Change here to the ${esc(OPS[stops[l.to].op].name)} stop ${toStop}`)
              : stops[l.from].name === stops[l.to].name ? `Cross to the other ${toStop} stop (${fmtM(l.m)}, ${dur(l.secs)})`
                : `Walk ${fmtM(l.m)} (${dur(l.secs)}) to ${toStop}`;
            return `<li class="leg walk"><span class="lt">${hhmm(start)}</span><div>${what}</div></li>`;
          }
          const p = lines[l.li].pats[l.pi];
          return `<li class="leg ride" style="--c:${lineColour(lines[l.li])}"><span class="lt">${hhmm(l.dep)}</span><div>${badge(lines[l.li], 'sm')} <b>To ${esc(headsign(p))}</b>
            <div>Board at <button type="button" class="linklike" data-stop="${l.from}">${esc(stops[l.from].name)}</button></div>
            <div class="muted">${l.alight - l.board} stop${l.alight - l.board === 1 ? '' : 's'} · ${dur(l.arr - l.dep)}</div>
            <div>Get off at <button type="button" class="linklike" data-stop="${l.to}">${esc(stops[l.to].name)}</button> · ${hhmm(l.arr)}</div></div></li>`;
        }).join('');
        const last = opts[opts.length - 1].legs.find((l) => l.type === 'ride').dep;
        body = `<div class="variants">${cards}</div>
          <button type="button" class="linklike small later" data-plan-later="${last + 60}">Later journeys</button>
          <div class="section"><span class="label">Journey ${plan.chosen + 1} step by step</span><ol class="legs">${legs}</ol>
          <p class="note" style="margin:0">Scheduled times, with at least 1 min to change and walking at 4 km/h. Delays are not taken into account.</p></div>`;
      }
    }
    const when = plan.options ? hhmm(plan.options.from) : hhmm(lisbon(nowMs()).secs);
    return `<button type="button" class="back" data-act="home">← All lines</button>
      <div class="d-head"><span class="walk-ico big" aria-hidden="true">A→B</span><div><h2>${esc(A.name)} → ${esc(B.name)}</h2>
      <div class="op">Leaving from ${when}${veh.offsetMs ? ' (chosen time)' : ''} · ${esc(OPS[A.op].name)} → ${esc(OPS[B.op].name)}</div></div></div>
      <div class="section">${body}</div>`;
  };
  let fitted = '';
  hooks.planRender = (v) => {
    v.innerHTML = hooks.planView();
    const has = plan.options && plan.options.opts.length;
    const bounds = has ? drawJourney(plan.options.opts[plan.chosen]) : (selLayer.clearLayers(), null);
    applyVisibility();
    const fk = plan.key + ':' + plan.chosen;
    if (bounds && bounds.isValid() && fk !== fitted) { fitted = fk; map.fitBounds(bounds, { ...panelPad(), maxZoom: 16 }); }
  };
  hooks.planLines = () => {
    if (!plan.options || !plan.options.opts.length) return new Set();
    return new Set(plan.options.opts[plan.chosen].legs.filter((l) => l.type === 'ride').map((l) => l.li));
  };
  hooks.planFromHash = (a, b) => {
    if (!stops[a] || !stops[b]) return;
    plan.from = a; plan.to = b; plan.options = null; renderPlanBar(); showPlan({ push: false });
  };

  // ------------------------------------------------------------------ new version check
  // GitHub Pages lets browsers keep index.html for 10 minutes, so after a deploy a visitor can sit on
  // the previous version. Every few minutes, revalidate the page (a 304 when nothing changed) and
  // compare its app.js stamp with the running one; if it moved, offer a reload. Revalidating also
  // refreshes the cached copy, so a plain reload gets the new page.
  const VERSION_EVERY_MS = 5 * 60 * 1000;
  const stampOf = (html) => (html.match(/src="app\.js\?v=([^"]+)"/) || [])[1] || null;
  const runningStamp = stampOf(document.documentElement.outerHTML);
  let lastVersionCheck = Date.now();
  async function checkVersion() {
    if (!runningStamp || location.protocol === 'file:' || !$('#update').hidden) return;
    lastVersionCheck = Date.now();
    try {
      const res = await fetch(location.href.split('#')[0], { cache: 'no-cache' });
      if (!res.ok) return;
      const fresh = stampOf(await res.text());
      if (fresh && fresh !== runningStamp) $('#update').hidden = false;
    } catch (err) { /* offline or blocked: try again next time */ }
  }
  setInterval(() => { if (!document.hidden) checkVersion(); }, VERSION_EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastVersionCheck > VERSION_EVERY_MS) checkVersion();
  });
  $('#update-reload').addEventListener('click', () => location.reload());

  // ------------------------------------------------------------------ theme changes
  function retheme() {
    buildNetwork();
    const sel = state.sel;
    if (sel?.type === 'line') selectLine(sel.li, sel.pi, { fit: false, push: false });
    else if (sel?.type === 'stop') selectStop(sel.si, { fit: false, push: false });
    else renderView();
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', retheme);
  new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // ------------------------------------------------------------------ boot
  $('#foot').innerHTML = `Data: ${DATA.sources.map(esc).join(' · ')}. Built ${esc(DATA.generated)}. Code MIT, data ODbL 1.0.`;
  renderToggles();
  buildNetwork();
  renderView();
  requestAnimationFrame(() => {
    map.invalidateSize(); readHash();
    // centre on the visitor only when the page did not open on a linked line or stop
    locate({ autoCentre: !state.sel });
  });
  window.addEventListener('hashchange', readHash);
})();
