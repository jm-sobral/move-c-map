(function () {
  'use strict';

  const DATA = window.TRANSIT;
  const OPS = {
    smtuc: { name: 'SMTUC', long: 'Urban buses, Coimbra', full: 'Serviços Municipalizados de Transportes Urbanos de Coimbra' },
    mm: { name: 'Metro Mondego', long: 'Metrobus BRT', full: 'Metro Mondego — Sistema de Mobilidade do Mondego' },
    sit: { name: 'SIT Metropolitano', long: 'Regional buses, 19 municipalities', full: 'SIT Metropolitano da Região de Coimbra' },
  };
  const OP_ORDER = ['smtuc', 'mm', 'sit'];
  const NEARBY_M = 250;
  // Metrobus colours as published, softened where they vanish on a light basemap.
  const COLOUR_FIX = { '#00FF40': '#1f9d4a', '#FF0000': '#d6282b', '#0080FF': '#1673d1' };

  // ------------------------------------------------------------------ helpers
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

  function lineColour(L) {
    if (L.op === 'mm' && L.color) return COLOUR_FIX[L.color.toUpperCase()] || L.color;
    return cssVar('--' + L.op);
  }
  function headsign(p) { return stops[p.s[p.s.length - 1]].name; }
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
  const hooks = { onView() {}, departuresHtml() { return ''; }, lineLiveHtml() { return ''; } };

  // ------------------------------------------------------------------ state
  const state = {
    on: { smtuc: true, mm: true, sit: true },
    sel: null, // {type:'line', li, pi} | {type:'stop', si}
    q: '',
  };

  // ------------------------------------------------------------------ map
  const map = L.map('map', { preferCanvas: true, zoomControl: true, minZoom: 9, maxZoom: 19 })
    .setView([40.205, -8.43], 12);
  map.createPane('network'); map.getPane('network').style.zIndex = 400;
  map.createPane('stopsPane'); map.getPane('stopsPane').style.zIndex = 420;
  map.createPane('sel'); map.getPane('sel').style.zIndex = 450;
  map.createPane('selStops'); map.getPane('selStops').style.zIndex = 460;
  const rNet = L.canvas({ pane: 'network', tolerance: 5 });
  const rStops = L.canvas({ pane: 'stopsPane', tolerance: 3 });
  const rSel = L.canvas({ pane: 'sel', tolerance: 4 });
  const rSelStops = L.canvas({ pane: 'selStops', tolerance: 4 });

  // OpenStreetMap standard tiles; the dark theme re-tones them with a CSS filter on the tile pane.
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const net = {}, stopLayers = {};
  function buildNetwork() {
    OP_ORDER.forEach((op) => {
      if (net[op]) map.removeLayer(net[op]);
      if (stopLayers[op]) map.removeLayer(stopLayers[op]);
      const g = L.layerGroup();
      // draw regional lines below urban ones
      lines.filter((L) => L.op === op).forEach((Ln) => {
        const c = lineColour(Ln);
        Ln.pats.forEach((p) => {
          const pl = L.polyline(p.pts, { renderer: rNet, color: c, weight: op === 'sit' ? 2.2 : 3, opacity: 0.8, lineCap: 'round', lineJoin: 'round', dashArray: p.src === 'stops' ? '2 7' : null });
          pl.bindTooltip(`<b>${esc(OPS[op].name)} ${esc(Ln.code)}</b><br>${esc(lineTitle(Ln))}`, { sticky: true, className: 'tt', direction: 'top', offset: [0, -6] });
          pl.on('click', (e) => { L.DomEvent.stop(e); selectLine(Ln.li, p.pi); });
          pl._op = op;
          g.addLayer(pl);
        });
      });
      net[op] = g;
      const sg = L.layerGroup();
      liveStops.filter((s) => s.op === op).forEach((s) => {
        const m = L.circleMarker(s.ll, { renderer: rStops, radius: op === 'mm' ? 4.5 : 3.5, color: lineColourOp(op), weight: 2, fillColor: cssVar('--panel'), fillOpacity: 1 });
        m.bindTooltip(`<b>${esc(s.name)}</b><br>${esc(OPS[op].name)} · ${linesAt(s).length} line(s)`, { className: 'tt', direction: 'top', offset: [0, -4] });
        m.on('click', (e) => { L.DomEvent.stop(e); selectStop(s.i); });
        sg.addLayer(m);
      });
      stopLayers[op] = sg;
    });
    applyVisibility();
  }
  function lineColourOp(op) { return op === 'mm' ? cssVar('--mm') : cssVar('--' + op); }

  function applyVisibility() {
    const dim = !!state.sel;
    const showStops = map.getZoom() >= 14;
    OP_ORDER.forEach((op) => {
      const on = state.on[op];
      if (on && !map.hasLayer(net[op])) net[op].addTo(map);
      if (!on && map.hasLayer(net[op])) map.removeLayer(net[op]);
      net[op].eachLayer((l) => l.setStyle({ opacity: dim ? 0.16 : 0.8 }));
      const st = on && showStops;
      if (st && !map.hasLayer(stopLayers[op])) stopLayers[op].addTo(map);
      if (!st && map.hasLayer(stopLayers[op])) map.removeLayer(stopLayers[op]);
      stopLayers[op].eachLayer((l) => l.setStyle({ opacity: dim ? 0.35 : 1, fillOpacity: dim ? 0.35 : 1 }));
    });
    hooks.onView();
    $('#hint').hidden = dim;
    $('#hint').textContent = map.getZoom() >= 14 ? 'Click a line or a stop on the map' : 'Click a line on the map · zoom in to see stops';
  }
  map.on('zoomend', applyVisibility);

  const selLayer = L.layerGroup().addTo(map);
  new ResizeObserver(() => map.invalidateSize()).observe(document.getElementById('map'));

  function drawPattern(Ln, p, { casing = true, weight = 5, labels = true, stopsToo = true } = {}) {
    const c = lineColour(Ln);
    if (casing) L.polyline(p.pts, { renderer: rSel, color: cssVar('--panel'), weight: weight + 5, opacity: 0.95, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(selLayer);
    L.polyline(p.pts, { renderer: rSel, color: c, weight, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false, dashArray: p.src === 'stops' ? '3 10' : null }).addTo(selLayer);
    if (stopsToo) {
      p.s.forEach((si, k) => {
        const s = stops[si], end = k === 0 || k === p.s.length - 1;
        const m = L.circleMarker(s.ll, { renderer: rSelStops, radius: end ? 7 : 5, color: end ? cssVar('--ink') : c, weight: end ? 3 : 2.5, fillColor: end ? c : cssVar('--panel'), fillOpacity: 1 });
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
    if (push) setHash(`line-${Ln.op}-${Ln.code}`);
    renderView();
    $('#view').scrollTop = 0;
  }

  function selectStop(si, { fit = true, push = true } = {}) {
    const s = stops[si];
    state.sel = { type: 'stop', si };
    selLayer.clearLayers();
    const at = linesAt(s);
    at.forEach(({ L: Ln, pats }) => pats.forEach((p) => drawPattern(Ln, p, { casing: true, weight: 3, labels: false, stopsToo: false })));
    L.circle(s.ll, { renderer: rSel, radius: NEARBY_M, color: cssVar('--muted'), weight: 1.5, dashArray: '4 6', fill: false, interactive: false }).addTo(selLayer);
    nearbyStops(s).forEach(({ s: n }) => {
      L.circleMarker(n.ll, { renderer: rSelStops, radius: 5, color: lineColourOp(n.op), weight: 2.5, fillColor: cssVar('--panel'), fillOpacity: 1 })
        .bindTooltip(`<b>${esc(n.name)}</b><br>${esc(OPS[n.op].name)}`, { className: 'tt', direction: 'top', offset: [0, -5] })
        .on('click', (e) => { L.DomEvent.stop(e); selectStop(n.i); }).addTo(selLayer);
    });
    L.circleMarker(s.ll, { renderer: rSelStops, radius: 16, color: cssVar('--ink'), weight: 2, opacity: 0.6, fill: false, interactive: false }).addTo(selLayer);
    L.circleMarker(s.ll, { renderer: rSelStops, radius: 10, color: cssVar('--panel'), weight: 4, fillColor: lineColourOp(s.op), fillOpacity: 1, interactive: false }).addTo(selLayer);
    applyVisibility();
    if (fit) map.setView(s.ll, Math.max(map.getZoom(), 16));
    if (push) setHash(`stop-${si}`);
    renderView();
    $('#view').scrollTop = 0;
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
    let m = h.match(/^line-(smtuc|mm|sit)-(.+)$/);
    if (m) {
      const Ln = lines.find((l) => l.op === m[1] && l.code === m[2]);
      if (Ln) return selectLine(Ln.li, 0, { push: false });
    }
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
    if (!state.on[op] && state.sel) {
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
    else v.innerHTML = homeView();
  }

  function lineRow(Ln) {
    const via = Ln.op === 'mm' ? (Ln.colourName ? `Linha ${Ln.colourName}` : '') : '';
    return `<li><button type="button" class="row" data-line="${Ln.li}">${badge(Ln)}<span class="t">${esc(lineTitle(Ln))}${via ? `<small>${esc(via)}</small>` : ''}</span></button></li>`;
  }

  function homeView() {
    const q = fold(state.q.trim());
    let html = '';
    if (q) {
      const ls = lines.filter((l) => state.on[l.op] && (fold(l.code) === q || fold(l.code).startsWith(q) || fold(lineTitle(l)).includes(q)))
        .sort((a, b) => (fold(b.code) === q) - (fold(a.code) === q));
      const seen = new Set(), ss = [];
      for (const s of liveStops) {
        if (!state.on[s.op] || !fold(s.name).includes(q)) continue;
        const k = s.op + '|' + s.name; if (seen.has(k)) continue; seen.add(k); ss.push(s);
        if (ss.length >= 40) break;
      }
      if (ls.length) html += `<div class="group-h"><span class="label">Lines</span><span class="label">${ls.length}</span></div><ul class="list">${ls.slice(0, 60).map(lineRow).join('')}</ul>`;
      if (ss.length) html += `<div class="group-h"><span class="label">Stops</span><span class="label">${ss.length}${ss.length >= 40 ? '+' : ''}</span></div><ul class="list">${ss.map((s) => `
        <li><button type="button" class="row" data-stop="${s.i}"><span class="stop-ico" style="--c:var(--${s.op})"><i></i></span>
        <span class="t">${esc(s.name)}<small>${esc(OPS[s.op].name)} · ${linesAt(s).map((e) => e.L.code).slice(0, 8).join(', ')}</small></span></button></li>`).join('')}</ul>`;
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
    const opName = OPS[Ln.op].name + (Ln.op === 'mm' && Ln.colourName ? ` · Linha ${Ln.colourName}` : '');
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
      : `<p class="note">${Ln.op === 'mm' ? 'Metrobus runs on its own dedicated busway for most of the route; road names are not listed.' : 'Road names are not available for this variant.'}</p>`;

    return `
      <button type="button" class="back" data-act="home">← All lines</button>
      <div class="d-head">${badge(Ln)}<div><h2>${esc(lineTitle(Ln))}</h2><div class="op">${esc(opName)}</div></div></div>
      ${hooks.lineLiveHtml(Ln)}
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
    const counts = { smtuc: [0, 0], mm: [0, 0], sit: [0, 0] };
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

  function initVehicles() {
    veh.tt = window.TIMETABLE;
    veh.tt.j.forEach((r, i) => {
      const k = r[0] + ':' + r[1];
      if (!veh.patRows.has(k)) veh.patRows.set(k, []);
      veh.patRows.get(k).push(i);
      if (r[5]) veh.tripRow.set(r[5], i);
    });
    veh.ready = true;
    tick(); renderView(); pollGps();
    setInterval(() => { if (!document.hidden) tick(); }, 2000);
    setInterval(() => { if (!document.hidden) pollGps(); }, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - veh.gps.at > 30000) pollGps(); });
  }
  map.on('zoomend', () => map.getContainer().classList.toggle('zlow', map.getZoom() < 13));
  map.getContainer().classList.toggle('zlow', map.getZoom() < 13);
  const ttScript = document.createElement('script');
  ttScript.src = 'timetable.js';
  ttScript.onload = initVehicles;
  ttScript.onerror = () => { $('#vstats').textContent = 'Timetables could not be loaded.'; };
  document.head.appendChild(ttScript);

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
  requestAnimationFrame(() => { map.invalidateSize(); readHash(); });
  window.addEventListener('hashchange', readHash);
})();
