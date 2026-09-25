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
