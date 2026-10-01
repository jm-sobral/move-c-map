"""Parse the official CP GTFS (publico.cp.pt/gtfs/gtfs.zip, CC0) into the same JSON shape as
parse_netex.py: stops, lines with patterns, journeys and calendars.

Scope: trains that call at a station inside the 19 municipalities of the Região de Coimbra
(tools/regiao-coimbra.geojson). Each trip is cut to its stations inside the region plus one station
beyond the boundary at each end (if within 60 km), so a train heading out still shows where it goes.

CP's route_short_name is the service type (U, R, IR, IC, AP), so lines are built per type and the
train's real end stations (e.g. R Coimbra-B – Aveiro), whatever part of the run falls in the region.
The feed has no track shapes. With an OpenStreetMap railway export, each station-to-station hop is
traced along the tracks; without one (or where tracing fails) it is drawn through every station on the
way, taking the intermediate stations of the stopping trains (U/R) where an express skips them.
MOVE-C coverage is assumed for U, R and IR, not for IC and AP.

Usage: python parse_gtfs_cp.py <unzipped gtfs dir> <region.geojson> <out.json> [osm-rail.json]
"""
import csv, collections, datetime, heapq, json, math, os, re, sys

STOPPING = {'U', 'R'}
MOVEC = {'U', 'R', 'IR'}
EXTEND_MAX_M = 60000
TYPE_NAME = {'U': 'Urbano', 'R': 'Regional', 'IR': 'InterRegional', 'IC': 'Intercidades', 'AP': 'Alfa Pendular'}


def rows(d, f):
    return list(csv.DictReader(open(os.path.join(d, f), encoding='utf-8-sig')))


def metres(a, b):
    k = math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot((b[1] - a[1]) * k, b[0] - a[0]) * math.pi / 180 * 6371000


def secs(hms):
    h, m, s = (int(x) for x in hms.split(':'))
    return h * 3600 + m * 60 + s


def in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]; xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def load_region(path):
    polys = []
    for f in json.load(open(path, encoding='utf-8'))['features']:
        for poly in f['geometry']['coordinates']:
            xs = [p[0] for p in poly[0]]; ys = [p[1] for p in poly[0]]
            polys.append(((min(xs), min(ys), max(xs), max(ys)), poly))

    def contains(lat, lon):
        for (x0, y0, x1, y1), poly in polys:
            if x0 <= lon <= x1 and y0 <= lat <= y1 and in_ring(lon, lat, poly[0]) \
                    and not any(in_ring(lon, lat, hole) for hole in poly[1:]):
                return True
        return False
    return contains


def slug(s):
    s = s.lower()
    for a, b in (('á', 'a'), ('à', 'a'), ('â', 'a'), ('ã', 'a'), ('é', 'e'), ('ê', 'e'), ('í', 'i'), ('ó', 'o'), ('ô', 'o'), ('õ', 'o'), ('ú', 'u'), ('ç', 'c')):
        s = s.replace(a, b)
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')


def rail_tracer(path):
    """Shortest path along OpenStreetMap railway tracks between two points, or None.

    `path` is an Overpass JSON export of all railway=rail ways with tags and geometry
    (data/osm-rail.json; query: way["railway"="rail"](39.75,-9.0,40.75,-7.6);out tags geom;).
    Ways that meet share node coordinates, so equal rounded coordinates join the graph."""
    if not path or not os.path.exists(path):
        return None
    nodes, adj = [], collections.defaultdict(list)
    idx = {}

    def nid(p):
        k = (round(p[0], 6), round(p[1], 6))
        if k not in idx:
            idx[k] = len(nodes)
            nodes.append(k)
        return idx[k]

    way_of = collections.defaultdict(set)
    for wi, w in enumerate(json.load(open(path, encoding='utf-8'))['elements']):
        g = [(p['lat'], p['lon']) for p in w.get('geometry', []) if p]
        if len(g) < 2:
            continue
        dense = [g[0]]
        for a, b in zip(g, g[1:]):  # vertices every <= 50 m so stations snap close to the track
            n = max(1, int(metres(a, b) / 50))
            dense += [(a[0] + (b[0] - a[0]) * s / n, a[1] + (b[1] - a[1]) * s / n) for s in range(1, n + 1)]
        ids = [nid(p) for p in dense]
        for i in ids:
            way_of[i].add(wi)
        # station tracks are often tagged siding/crossover: usable to pass a station, but dearer
        # than the main line so trains do not wander through yards
        cost = 3 if (w.get('tags') or {}).get('service') else 1
        for u, v in zip(ids, ids[1:]):
            if u != v:
                w_ = metres(nodes[u], nodes[v]) * cost
                adj[u].append((v, w_))
                adj[v].append((u, w_))
    grid = collections.defaultdict(list)
    for i, (la, lo) in enumerate(nodes):
        grid[(int(la / 0.005), int(lo / 0.005))].append(i)
    # OSM splits the line into many ways and some do not share an end node (station throats,
    # works on the Linha do Norte): join every dead end to the nearest other way within 200 m
    joined = 0
    for i in [i for i in range(len(nodes)) if len(adj[i]) == 1]:
        gx, gy = int(nodes[i][0] / 0.005), int(nodes[i][1] / 0.005)
        best, bd = None, 200
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in grid[(gx + dx, gy + dy)]:
                    if not (way_of[j] & way_of[i]):
                        d = metres(nodes[i], nodes[j])
                        if d < bd:
                            best, bd = j, d
        if best is not None:  # a join is a guess, so it costs like a station track
            adj[i].append((best, bd * 3))
            adj[best].append((i, bd * 3))
            joined += 1
    print('rail graph: joined', joined, 'loose track ends')

    def snap(p, max_m=300):
        gx, gy = int(p[0] / 0.005), int(p[1] / 0.005)
        best, bd = None, max_m
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for i in grid[(gx + dx, gy + dy)]:
                    d = metres(p, nodes[i])
                    if d < bd:
                        best, bd = i, d
        return best

    def trace(a, b):
        na, nb = snap(a), snap(b)
        if na is None or nb is None:
            return None
        cap = 1.6 * metres(a, b) + 3000  # anything longer is a wrong turn, not the line
        D, prev, pq = {na: 0}, {}, [(0, na)]
        while pq:
            d, u = heapq.heappop(pq)
            if u == nb:
                break
            if d > D[u]:
                continue
            for v, w in adj[u]:
                nd = d + w
                if nd <= cap and nd < D.get(v, 1e18):
                    D[v], prev[v] = nd, u
                    heapq.heappush(pq, (nd, v))
        if nb not in D:
            return None
        out = [nb]
        while out[-1] != na:
            out.append(prev[out[-1]])
        return [nodes[i] for i in reversed(out)]

    print('rail graph:', len(nodes), 'nodes from', path)
    return trace


def main(gtfs, region_path, out, rail_path=None):
    contains = load_region(region_path)
    trace = rail_tracer(rail_path)
    traced = {}
    stops = {s['stop_id']: s for s in rows(gtfs, 'stops.txt')}
    ll = {k: (round(float(s['stop_lat']), 6), round(float(s['stop_lon']), 6)) for k, s in stops.items()}
    inreg = {k for k, p in ll.items() if contains(*p)}
    routes = {r['route_id']: r for r in rows(gtfs, 'routes.txt')}
    trips = {t['trip_id']: t for t in rows(gtfs, 'trips.txt')}
    st = collections.defaultdict(list)
    for r in csv.DictReader(open(os.path.join(gtfs, 'stop_times.txt'), encoding='utf-8-sig')):
        st[r['trip_id']].append(r)
    for v in st.values():
        v.sort(key=lambda r: int(r['stop_sequence']))

    # station graph from stopping trains, for drawing expresses through the stations they skip
    adj = collections.defaultdict(dict)
    for tid, sts in st.items():
        if routes[trips[tid]['route_id']]['route_short_name'] in STOPPING:
            seq = [r['stop_id'] for r in sts]
            for a, b in zip(seq, seq[1:]):
                d = metres(ll[a], ll[b])
                adj[a][b] = adj[b][a] = d

    def via(a, b):
        # Some stopping trains skip stations too, so a direct a-b link may exist even where the track
        # runs past other stations. Scoring each hop by its length squared makes several short hops
        # along the line cheaper than one long jump; the length cap keeps it off branch lines.
        cap = 1.3 * metres(ll[a], ll[b]) + 2000
        D, prev, pq = {a: (0, 0)}, {}, [(0, 0, a)]
        while pq:
            c, d, u = heapq.heappop(pq)
            if u == b:
                break
            if (c, d) > D[u]:
                continue
            for v, w in adj[u].items():
                nc, nd = c + w * w, d + w
                if nd <= cap and (v not in D or nc < D[v][0]):
                    D[v], prev[v] = (nc, nd), u
                    heapq.heappush(pq, (nc, nd, v))
        if b not in D:
            return [a, b]
        path = [b]
        while path[-1] != a:
            path.append(prev[path[-1]])
        return path[::-1]

    # cut every train to its run through the region (+1 station each side)
    cut = {}
    for tid, sts in st.items():
        seq = [r['stop_id'] for r in sts]
        idx = [i for i, s in enumerate(seq) if s in inreg]
        if not idx:
            continue
        i0, i1 = idx[0], idx[-1]
        # one station beyond the boundary shows where the train heads, unless it is far away
        # (an Alfa Pendular's next call south of Coimbra-B can be Lisboa Oriente)
        if i0 > 0 and metres(ll[seq[i0 - 1]], ll[seq[i0]]) <= EXTEND_MAX_M:
            i0 -= 1
        if i1 < len(seq) - 1 and metres(ll[seq[i1 + 1]], ll[seq[i1]]) <= EXTEND_MAX_M:
            i1 += 1
        if i1 - i0 < 1:
            continue
        cut[tid] = sts[i0:i1 + 1]

    # calendars: GTFS weekly pattern + exceptions, as (first date, day bits) like the NeTEx export
    cal = {c['service_id']: c for c in rows(gtfs, 'calendar.txt')}
    exc = collections.defaultdict(dict)
    for c in rows(gtfs, 'calendar_dates.txt'):
        exc[c['service_id']][c['date']] = c['exception_type']
    D = lambda s: datetime.date(int(s[:4]), int(s[4:6]), int(s[6:]))
    wd = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

    def dates(sid):
        out = set()
        c = cal.get(sid)
        if c:
            d, end = D(c['start_date']), D(c['end_date'])
            while d <= end:
                if c[wd[d.weekday()]] == '1':
                    out.add(d)
                d += datetime.timedelta(1)
        for ds, e in exc[sid].items():
            (out.add if e == '1' else out.discard)(D(ds))
        return out

    calendars, cal_id, cal_of = {}, {}, {}  # identical day patterns share one calendar
    for tid in cut:
        sid = trips[tid]['service_id']
        if sid in cal_of:
            continue
        ds = dates(sid)
        if not ds:
            cal_of[sid] = None
            continue
        first, last = min(ds), max(ds)
        bits = ''.join('1' if first + datetime.timedelta(i) in ds else '0' for i in range((last - first).days + 1))
        key = (first.strftime('%Y%m%d'), bits)
        if key not in cal_id:
            cal_id[key] = f'cp:cal:{len(cal_id)}'
            calendars[cal_id[key]] = key
        cal_of[sid] = cal_id[key]

    # lines per service type + corridor, patterns per distinct station sequence
    lines, pats, journeys = {}, {}, []
    for tid, sts in cut.items():
        cid = cal_of.get(trips[tid]['service_id'])
        if cid is None:
            continue
        typ = routes[trips[tid]['route_id']]['route_short_name']
        seq = tuple(r['stop_id'] for r in sts)
        full = st[tid]  # name lines after where the train really starts and ends, not where the cut does
        names = (stops[full[0]['stop_id']]['stop_name'], stops[full[-1]['stop_id']]['stop_name'])
        ends = tuple(sorted(names))
        lkey = (typ, ends)
        if lkey not in lines:
            lines[lkey] = {'id': f'cp:{typ}:{slug(ends[0])}:{slug(ends[1])}', 'short': typ, 'name': f'{ends[0]} – {ends[1]}',
                           'slug': f'{typ.lower()}-{slug(ends[0])}-{slug(ends[1])}', 'mode': 'rail', 'gid': typ,
                           'color': None, 'text': None, 'movec': typ in MOVEC, 'typeName': TYPE_NAME.get(typ, typ),
                           'patterns': []}
        pk = (lkey, seq)
        if pk not in pats:
            # along the OSM tracks where possible; otherwise through the stations on the way
            geom, on_rail = [ll[seq[0]]], 0
            for a, b in zip(seq, seq[1:]):
                if trace and (a, b) not in traced:
                    traced[(a, b)] = trace(ll[a], ll[b])
                seg = traced.get((a, b)) if trace else None
                if seg:
                    on_rail += 1
                else:
                    seg = [ll[s] for s in via(a, b)]
                geom += seg[1:] if metres(geom[-1], seg[0]) < 1 else seg
            n_hops = len(seq) - 1
            pats[pk] = {'id': f'cp:pat:{len(pats)}', 'dir': 'outbound' if names[0] == ends[0] else 'inbound',
                        'stops': list(seq), 'trips': 0, 'first': None, 'last': None, 'gtrips': [],
                        'head': trips[tid]['trip_headsign'] or names[1], 'origin': names[0],
                        'geom': geom, 'geom_src': 'rail' if on_rail == n_hops else 'stations' if not on_rail else 'rail-partial'}
            lines[lkey]['patterns'].append(pats[pk])
        p = pats[pk]
        dep0 = sts[0]['departure_time'][:5]
        p['trips'] += 1
        p['first'] = min(p['first'] or dep0, dep0)
        p['last'] = max(p['last'] or dep0, dep0)
        journeys.append({'p': p['id'], 'trip': tid, 'cal': [cid],
                         't': [[secs(r['arrival_time']), secs(r['departure_time'])] for r in sts]})

    used = {s for p in pats.values() for s in p['stops']}
    out_stops = {s: {'n': stops[s]['stop_name'], 'll': ll[s], 'code': None, 'gid': s} for s in used}
    feed_date = datetime.date.fromtimestamp(os.path.getmtime(os.path.join(gtfs, 'stop_times.txt'))).isoformat()
    data = {'stops': out_stops, 'lines': list(lines.values()), 'journeys': journeys, 'calendars': calendars,
            'feed_date': feed_date}
    json.dump(data, open(out, 'w', encoding='utf-8'), ensure_ascii=False)
    by_type = collections.Counter(l['short'] for l in lines.values())
    print(out, 'stations', len(used), '(in region', len(used & inreg), ')', 'lines', len(lines), dict(by_type),
          'patterns', len(pats), 'journeys', len(journeys), 'calendars', len(calendars))
    if trace:
        ok = sum(1 for v in traced.values() if v)
        print('station-to-station hops traced on the tracks:', ok, 'of', len(traced),
              dict(collections.Counter(p['geom_src'] for p in pats.values())))


if __name__ == '__main__':
    main(*sys.argv[1:5])
