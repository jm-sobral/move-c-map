"""Build the compact data bundle (data.js) for the Coimbra transit map.

Sources
- NeTEx EPIP exports from AGIT (api.planner.agit.pt): stops, lines, journey patterns, first/last departures.
- SMTUC GTFS (dados.gov.pt): official SMTUC shapes, only with --smtuc-shapes (dataset has no licence yet).
- Rede Metrobus KMZ (dados.gov.pt): Metrobus corridor axes, used to trace Metro Mondego patterns.
- OSRM (router.project-osrm.org) road routes through the stops: SIT/SMTUC geometry and road names.
- OSRM foot profile (routing.openstreetmap.de) via tools/walk_fetch.py: walking transfers (walks.json).
- CP GTFS (publico.cp.pt, CC0) via tools/parse_gtfs_cp.py: trains in the region (cp.json).
"""
import csv, glob, hashlib, heapq, json, math, os, re, sys, collections, datetime

args = [a for a in sys.argv[1:] if not a.startswith('--')]
OUT = args[0] if args else 'data.js'
# SMTUC GTFS carries no licence on dados.gov.pt; its shapes are opt-in until one is published.
SMTUC_SHAPES = '--smtuc-shapes' in sys.argv
STAMP = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')  # shared by data.js and timetable.js
csv.field_size_limit(10**9)

# ---------------------------------------------------------------- geometry helpers
R = 6371000.0


def dist(a, b):
    la = math.radians((a[0] + b[0]) / 2)
    dx = math.radians(b[1] - a[1]) * math.cos(la)
    dy = math.radians(b[0] - a[0])
    return R * math.hypot(dx, dy)


def seg_dist(p, a, b):
    """Metres from p to segment ab (local equirectangular)."""
    k = math.cos(math.radians(p[0]))
    ax, ay = (a[1] - p[1]) * k, a[0] - p[0]
    bx, by = (b[1] - p[1]) * k, b[0] - p[0]
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0 if L == 0 else max(0, min(1, -(ax * dx + ay * dy) / L))
    x, y = ax + t * dx, ay + t * dy
    return math.hypot(x, y) * math.pi / 180 * R


def rdp(pts, tol=6.0):
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        best, idx = 0, -1
        for k in range(i + 1, j):
            d = seg_dist(pts[k], pts[i], pts[j])
            if d > best:
                best, idx = d, k
        if best > tol:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [p for p, k in zip(pts, keep) if k]


def encode(pts, prec=5):
    f = 10 ** prec
    out, plat, plon = [], 0, 0
    for lat, lon in pts:
        ilat, ilon = round(lat * f), round(lon * f)
        for v in (ilat - plat, ilon - plon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1f)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plon = ilat, ilon
    return ''.join(out)


def decode(s, prec=6):
    f = 10 ** prec
    pts, i, lat, lon = [], 0, 0, 0
    while i < len(s):
        vals = []
        for _ in range(2):
            shift = res = 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                res |= (b & 0x1f) << shift
                shift += 5
                if b < 0x20:
                    break
            vals.append(~(res >> 1) if res & 1 else res >> 1)
        lat += vals[0]
        lon += vals[1]
        pts.append((lat / f, lon / f))
    return pts


def length(pts):
    return sum(dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


# ---------------------------------------------------------------- inputs
ops = {k: json.load(open(f'{f}.json', encoding='utf-8'))
       for k, f in [('smtuc', 'smtuc'), ('mm', 'metro-mondego'), ('sit', 'sit'), ('cp', 'cp')]
       if k != 'cp' or os.path.exists('cp.json')}  # cp.json from tools/parse_gtfs_cp.py


def pattern_key(coords):
    return hashlib.sha1(json.dumps([tuple(c) for c in coords]).encode()).hexdigest()[:16]


def osrm_for(coords):
    p = f'osrm_cache/{pattern_key(coords)}.json'
    if not os.path.exists(p):
        return None
    return json.load(open(p))


def osrm_geom_roads(res, coords):
    """Geometry (lat,lon list) and road sequence from cached OSRM chunks. None if any chunk failed.
    A leg far longer than the stop-to-stop distance is a routing artefact: drawn straight, no road names."""
    if not res or any('error' in c for c in res):
        return None, None
    pts, seq = [], []
    legs = [lg for ch in res for lg in ch['legs']]
    for i, lg in enumerate(legs):
        if lg['d'] > 3 * dist(coords[i], coords[i + 1]) + 1500:
            if not pts or pts[-1] != coords[i]:
                pts.append(coords[i])
            pts.append(coords[i + 1])
            continue
        if True:
            for st in lg['steps']:
                g = decode(st['g'])
                if pts and g and pts[-1] == g[0]:
                    g = g[1:]
                pts += g
                name, ref = st['n'].strip(), st['r'].strip()
                label = name or ref
                if name and ref and ref not in name:
                    label = f'{name} ({ref})'
                if seq and (seq[-1][0] == label or not label):
                    seq[-1][1] += st['d']
                elif not label and not seq:
                    continue
                else:
                    seq.append([label, st['d']])
    roads = []
    for lab, d in seq:
        if d < 150 or not lab:
            continue
        if roads and roads[-1][0] == lab:
            roads[-1][1] += d
        else:
            roads.append([lab, d])
    return pts, [[l, round(d)] for l, d in roads]


# ---------------------------------------------------------------- SMTUC GTFS shapes
shapes = collections.defaultdict(list)
for r in (csv.DictReader(open('data/gsm/shapes.txt', encoding='utf-8-sig')) if SMTUC_SHAPES else []):
    shapes[r['shape_id']].append((int(r['shape_pt_sequence']), float(r['shape_pt_lat']), float(r['shape_pt_lon'])))
shapes = {k: [(a, b) for _, a, b in sorted(v)] for k, v in shapes.items()}
prefix_shapes = collections.defaultdict(set)
for r in (csv.DictReader(open('data/gsm/trips.txt', encoding='utf-8-sig')) if SMTUC_SHAPES else []):
    prefix_shapes[r['trip_id'].split('|')[0]].add(r['shape_id'])


K = math.cos(math.radians(40.2)) * math.pi / 180 * R
M = math.pi / 180 * R


def xy(p):
    return (p[1] * K, p[0] * M)


shapes_xy = {k: [xy(p) for p in v] for k, v in shapes.items()}


def d2(a, b):
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2


def nearest_idx(p, pts, lo=0):
    best, bi = 1e30, lo
    for i in range(lo, len(pts)):
        d = d2(p, pts[i])
        if d < best:
            best, bi = d, i
    return bi


def fit_shape(coords, cand):
    """Pick the candidate shape that passes closest to the stops, trimmed to first..last stop."""
    cxy = [xy(c) for c in coords]
    best = None
    for sid in cand:
        sp = shapes_xy.get(sid)
        if not sp:
            continue
        i0 = nearest_idx(cxy[0], sp)
        i1 = nearest_idx(cxy[-1], sp, i0)
        sub = sp[i0:i1 + 1]
        if len(sub) < 2:
            continue
        step = max(1, len(sub) // 400)
        samp = sub[::step]
        score = sum(math.sqrt(min(d2(c, q) for q in samp)) for c in cxy) / len(cxy)
        if best is None or score < best[0]:
            best = (score, shapes[sid][i0:i1 + 1], sid)
    return best


# ---------------------------------------------------------------- Metrobus KMZ graph
kml = open(glob.glob('data/kmz/*.kml')[0], encoding='utf-8').read()
lines_kml = []
for m in re.finditer(r'<LineString>.*?<coordinates>(.*?)</coordinates>', kml, re.S):
    pts = []
    for tok in m.group(1).split():
        x = tok.split(',')
        pts.append((float(x[1]), float(x[0])))
    if len(pts) > 1:
        lines_kml.append(pts)

nodes, adj = [], collections.defaultdict(list)
node_id = {}


def nid(p):
    k = (round(p[0], 6), round(p[1], 6))
    if k not in node_id:
        node_id[k] = len(nodes)
        nodes.append(k)
    return node_id[k]


for pts in lines_kml:
    dense = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        n = max(1, int(dist(a, b) / 15))
        for s in range(1, n + 1):
            dense.append((a[0] + (b[0] - a[0]) * s / n, a[1] + (b[1] - a[1]) * s / n))
    ids = [nid(p) for p in dense]
    for u, v in zip(ids, ids[1:]):
        w = dist(nodes[u], nodes[v])
        adj[u].append((v, w))
        adj[v].append((u, w))
# join loose ends: every node within 20 m of a node on a different polyline piece
grid = collections.defaultdict(list)
for i, (la, lo) in enumerate(nodes):
    grid[(int(la / 0.0003), int(lo / 0.0003))].append(i)
for i, (la, lo) in enumerate(nodes):
    if len(adj[i]) > 1:
        continue
    gx, gy = int(la / 0.0003), int(lo / 0.0003)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for j in grid[(gx + dx, gy + dy)]:
                if j != i and dist(nodes[i], nodes[j]) < 25 and all(v != j for v, _ in adj[i]):
                    w = dist(nodes[i], nodes[j])
                    adj[i].append((j, w))
                    adj[j].append((i, w))


def near_node(p):
    return min(range(len(nodes)), key=lambda i: dist(p, nodes[i]))


def dijkstra(a, b):
    D, prev, pq = {a: 0}, {}, [(0, a)]
    while pq:
        d, u = heapq.heappop(pq)
        if u == b:
            break
        if d > D[u]:
            continue
        for v, w in adj[u]:
            nd = d + w
            if nd < D.get(v, 1e18):
                D[v], prev[v] = nd, u
                heapq.heappush(pq, (nd, v))
    if b not in D:
        return None
    path = [b]
    while path[-1] != a:
        path.append(prev[path[-1]])
    return [nodes[i] for i in reversed(path)]


def trace_kmz(coords):
    out = []
    ns = [near_node(c) for c in coords]
    for (c0, c1), (a, b) in zip(zip(coords, coords[1:]), zip(ns, ns[1:])):
        seg = dijkstra(a, b)
        if not seg or length(seg) > 4 * dist(c0, c1) + 500:
            seg = [c0, c1]
        out += seg if not out else seg[1:]
    return out


def stop_dists(g, coords):
    """Metres along polyline g where each stop projects, never going backwards (loops safe)."""
    cum = [0.0]
    for a, b in zip(g, g[1:]):
        cum.append(cum[-1] + dist(a, b))
    out, seg = [], 0
    for n, c in enumerate(coords):
        best, bd = None, 1e18
        for k in range(seg, len(g) - 1 if n else 1):
            d = seg_dist(c, g[k], g[k + 1])
            if d < bd:
                bd, best = d, k
            elif bd < 30 and d > bd + 150:
                break  # first close pass taken; a loop coming back later must not win
        seg = best if best is not None else seg
        a, b = g[seg], g[min(seg + 1, len(g) - 1)]
        L = dist(a, b)
        t = 0 if L == 0 else max(0, min(1, (dist(a, c) ** 2 - dist(b, c) ** 2 + L * L) / (2 * L * L)))
        out.append(round(cum[seg] + t * L))
    for i in range(1, len(out)):
        out[i] = max(out[i], out[i - 1])
    return out


# ---------------------------------------------------------------- assemble
stops_out, stop_index = [], {}
for op, d in ops.items():
    for sid, s in d['stops'].items():
        stop_index[(op, sid)] = len(stops_out)
        stops_out.append([op, s['n'], s['ll'][0], s['ll'][1], s.get('code') or s.get('gid') or ''])

stats = collections.Counter()
lines_out = {}
pid_map = {}  # NeTEx ServiceJourneyPattern id -> output pattern dict
for op, d in ops.items():
    for L in d['lines']:
        code = L['name'] if op == 'mm' else L['short']
        colour_name = L['short'] if op == 'mm' else None
        # CP codes are service types (R, IC...) shared by several lines: key those by corridor
        key = (op, L['slug']) if op == 'cp' else (op, code)
        if key not in lines_out:
            lines_out[key] = {'op': op, 'code': code, 'name': None if op == 'mm' else L['name'],
                              'color': ('#' + L['color']) if L.get('color') else None,
                              'colourName': colour_name, 'pats': []}
            if op == 'cp':
                lines_out[key].update({'slug': L['slug'], 'movec': L['movec'], 'typeName': L['typeName']})
        LO = lines_out[key]
        seen = {}
        for P in L['patterns']:
            coords = [tuple(d['stops'][s]['ll']) for s in P['stops']]
            sig = tuple(P['stops'])
            if sig in seen:
                pid_map[P['id']] = seen[sig]
                continue
            geom, roads, src = None, None, None
            og, oroads = osrm_geom_roads(osrm_for(coords), coords)
            if op == 'smtuc' and SMTUC_SHAPES:
                cand = set()
                for t in P['gtrips']:
                    cand |= prefix_shapes.get(t.split('|')[0], set())
                if not cand:
                    cand = {k for k in shapes if k.split('_')[0] == L['short']}
                fit = fit_shape(coords, cand) if cand else None
                if fit and fit[0] < 60:
                    geom, src = fit[1], 'gtfs'
                roads = oroads
            elif op == 'mm':
                geom, src = trace_kmz(coords), 'kmz'
            elif op == 'cp':
                geom, src = [tuple(x) for x in P['geom']], P.get('geom_src', 'stations')
            else:
                roads = oroads
            if geom is None and og:
                geom, src = og, 'osrm'
            if geom is None:
                geom, src = coords, 'stops'
            stats[(op, src)] += 1
            g = rdp(geom, 5.0)
            g = [(round(a, 5), round(b, 5)) for a, b in g]
            pat = {
                '_g': g, 'dir': P['dir'], 'var': L['name'] if op != 'mm' else None,
                's': [stop_index[(op, s)] for s in P['stops']],
                'g': encode(g), 'sd': stop_dists(g, coords), 'km': round(length(geom) / 1000, 1),
                'r': roads or [], 'n': P['trips'], 'f': P['first'], 'l': P['last'], 'src': src}
            if P.get('head'):
                pat['h'] = P['head']  # a train's real destination when the map stops at the boundary
            LO['pats'].append(pat)
            seen[sig] = pat
            pid_map[P['id']] = pat


def sort_key(L):
    m = re.match(r'([A-Z]*)(\d*)(.*)', L['code'])
    return (L['op'], m.group(1), int(m.group(2) or 0), m.group(3), L['name'] or '')


out_lines = sorted(lines_out.values(), key=sort_key)
for L in out_lines:
    for p in L['pats']:
        p['dir'] = p['dir'] or 'outbound'
    # most extensive schedule first within each direction
    L['pats'].sort(key=lambda p: (p['dir'] != 'outbound', -len(p['s']), -p['km'], -p['n']))

# ---------------------------------------------------------------- network overview
# Every road segment once per operator, chained into polylines whose set of lines is constant.
# The overview draws these instead of every variant: ~5x fewer points to project on each zoom.
def network_chains(op):
    seg = collections.defaultdict(set)
    adj = collections.defaultdict(set)
    for li, L in enumerate(out_lines):
        if L['op'] != op:
            continue
        for p in L['pats']:
            pts = [(round(a * 1e5), round(b * 1e5)) for a, b in p['_g']]
            for u, v in zip(pts, pts[1:]):
                if u == v:
                    continue
                seg[(min(u, v), max(u, v))].add(li)
                adj[u].add(v)
                adj[v].add(u)
    key = lambda u, v: (min(u, v), max(u, v))

    def is_break(n):
        nb = list(adj[n])
        return len(nb) != 2 or seg[key(n, nb[0])] != seg[key(n, nb[1])]

    done, chains = set(), []

    def walk(start, nxt):
        path, prev, cur = [start, nxt], start, nxt
        done.add(key(start, nxt))
        ls = seg[key(start, nxt)]
        while not is_break(cur):
            (step,) = [x for x in adj[cur] if x != prev] or [None]
            if step is None or key(cur, step) in done or seg[key(cur, step)] != ls:
                break
            done.add(key(cur, step))
            path.append(step)
            prev, cur = cur, step
        chains.append([encode([(a / 1e5, b / 1e5) for a, b in path]), sorted(ls)])

    for n in list(adj):
        if is_break(n):
            for m in adj[n]:
                if key(n, m) not in done:
                    walk(n, m)
    for (u, v) in seg:
        if (u, v) not in done:
            walk(u, v)
    # one multi-part polyline per set of lines keeps the layer count low
    groups = collections.defaultdict(list)
    for enc, ls in chains:
        groups[tuple(ls)].append(enc)
    return [[parts, list(ls)] for ls, parts in groups.items()]


net = {op: network_chains(op) for op in ops}
print('network groups', {op: len(c) for op, c in net.items()})
for L in out_lines:
    for p in L['pats']:
        p.pop('_g', None)

bundle = {
    'net': net,
    'generated': STAMP,
    'sources': [
        'AGIT NeTEx EPIP (api.planner.agit.pt), 2026-09-23, CC BY 4.0',
        'Rede Metrobus KMZ, Metro Mondego (dados.gov.pt), 2026-08-17, CC BY',
        *(['SMTUC GTFS (dados.gov.pt), 2026-09-14'] if SMTUC_SHAPES else []),
        *([f"CP GTFS (publico.cp.pt), {ops['cp'].get('feed_date', '')}, CC0"] if 'cp' in ops else []),
        'Road paths: OSRM on © OpenStreetMap contributors, ODbL 1.0'],
    'stops': stops_out, 'lines': out_lines}
# ---------------------------------------------------------------- timetable bundle
idx = {}
for li, L in enumerate(out_lines):
    for pi, p in enumerate(L['pats']):
        idx[id(p)] = (li, pi)
cals, cal_idx, profs, prof_idx, rows = [], {}, [], {}, []
for op, d in ops.items():
    for dt, (frm, bits) in d['calendars'].items():
        cal_idx[(op, dt)] = len(cals)
        cals.append([frm, bits.rstrip('0') or '0'])
    for j in d['journeys']:
        p = pid_map.get(j['p'])
        if p is None or not j['cal']:
            continue
        t = [[a if a is not None else dd, dd if dd is not None else a] for a, dd in j['t']]
        start = t[0][1]
        key = tuple(v - start for pair in t for v in pair)
        if key not in prof_idx:
            prof_idx[key] = len(profs)
            profs.append(list(key))
        c = [cal_idx[(op, x)] for x in j['cal']]
        li, pi = idx[id(p)]
        rows.append([li, pi, c[0] if len(c) == 1 else c, start, prof_idx[key], j['trip'] if op == 'smtuc' else 0])
# walking transfers for the journey planner: served stops within WALK_MAX_M on foot (tools/walk_fetch.py)
WALK_MAX_M = 400
walk = []
served = sorted({si for L in out_lines for p in L['pats'] for si in p['s']})
at_coord = collections.defaultdict(list)
for si in served:
    at_coord[f'{stops_out[si][2]},{stops_out[si][3]}'].append(si)
for group in at_coord.values():  # separate stop points at the very same spot
    for a in group:
        for b in group:
            if a != b:
                walk += [a, b, 0]
if os.path.exists('walks.json'):
    for key, m in json.load(open('walks.json')).items():
        if m is None or m > WALK_MAX_M:
            continue
        ca, cb = key.split('|')
        for a in at_coord.get(ca, []):
            for b in at_coord.get(cb, []):
                walk += [a, b, m]
else:
    print('walks.json not found: journey planner will only change at the same stop')
print('walking transfers', len(walk) // 3)
tt = {'generated': STAMP, 'cal': cals, 'prof': profs, 'j': rows, 'walk': walk}
tjs = 'window.TIMETABLE=' + json.dumps(tt, ensure_ascii=False, separators=(',', ':')) + ';\n'
tpath = os.path.join(os.path.dirname(os.path.abspath(OUT)), 'timetable.js')
open(tpath, 'w', encoding='utf-8').write(tjs)
print('wrote', tpath, round(len(tjs.encode()) / 1e6, 2), 'MB', 'journeys', len(rows), 'profiles', len(profs), 'calendars', len(cals))

js = 'window.TRANSIT=' + json.dumps(bundle, ensure_ascii=False, separators=(',', ':')) + ';\n'
open(OUT, 'w', encoding='utf-8').write(js)
print('wrote', OUT, round(len(js.encode()) / 1e6, 2), 'MB', 'lines', len(out_lines), 'stops', len(stops_out))

# cache-bust the page's script tags so a deploy never mixes files from two builds
page = os.path.join(os.path.dirname(os.path.abspath(OUT)), 'index.html')
if os.path.exists(page):
    ver = STAMP.replace(' ', 'T').replace(':', '')
    html = open(page, encoding='utf-8').read()
    html = re.sub(r'src="(data|app)\.js(\?v=[^"]*)?"', lambda m: f'src="{m.group(1)}.js?v={ver}"', html)
    open(page, 'w', encoding='utf-8').write(html)
    print('stamped', page, ver)
print(dict(stats))
