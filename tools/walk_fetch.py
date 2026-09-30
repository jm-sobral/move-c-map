"""Walking distances between nearby stops, for journey-planner transfers.

Candidate pairs are served stops (any operator) within MAX_M in a straight line. Real walking
distances come from the OSRM foot profile on OpenStreetMap (routing.openstreetmap.de), so a pair on
opposite banks of the Mondego gets the detour via the bridge, not the straight line.
Pairs are packed into shared distance tables of up to 100 points (1 request per second).
Requests are cached in walk_cache/, so re-runs only fetch what is new. Writes walks.json:
{"lat,lon|lat,lon": metres} for every candidate pair, both directions.
"""
import hashlib, json, math, os, sys, time, urllib.request, collections

MAX_M = 400
TABLE = 100
URL = 'https://routing.openstreetmap.de/routed-foot/table/v1/driving/{}?annotations=distance'
CACHE = 'walk_cache'
os.makedirs(CACHE, exist_ok=True)


def metres(a, b):
    k = math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot((b[1] - a[1]) * k, b[0] - a[0]) * math.pi / 180 * 6371000


def served_coords(files):
    pts = set()
    for f in files:
        d = json.load(open(f, encoding='utf-8'))
        used = {s for L in d['lines'] for p in L['patterns'] for s in p['stops']}
        for sid in used:
            pts.add(tuple(d['stops'][sid]['ll']))
    return sorted(pts)


def candidate_pairs(pts):
    grid = collections.defaultdict(list)
    for i, p in enumerate(pts):
        grid[(int(p[0] / 0.004), int(p[1] / 0.005))].append(i)
    pairs = []
    for i, p in enumerate(pts):
        gx, gy = int(p[0] / 0.004), int(p[1] / 0.005)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in grid[(gx + dx, gy + dy)]:
                    if j > i and metres(p, pts[j]) <= MAX_M:
                        pairs.append((i, j))
    # spatial order so each table covers neighbouring stops
    pairs.sort(key=lambda ij: (int(pts[ij[0]][0] / 0.004), int(pts[ij[0]][1] / 0.005), ij))
    return pairs


def fetch(coords):
    key = hashlib.sha1(json.dumps(coords).encode()).hexdigest()[:16]
    path = f'{CACHE}/{key}.json'
    if os.path.exists(path):
        return json.load(open(path)), False
    url = URL.format(';'.join(f'{lon},{lat}' for lat, lon in coords))
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'move-c-map build (github.com/jm-sobral/move-c-map)'})
            with urllib.request.urlopen(req, timeout=60) as r:
                res = json.load(r)
            if res.get('code') == 'Ok':
                json.dump(res['distances'], open(path, 'w'))
                return res['distances'], True
            print('  bad response', res.get('code'), flush=True)
        except Exception as e:
            print('  retry', attempt, e, flush=True)
        time.sleep(5 * (attempt + 1))
    return None, True


def main(files):
    pts = served_coords(files)
    pairs = candidate_pairs(pts)
    print('served stop locations', len(pts), 'candidate pairs within', MAX_M, 'm:', len(pairs), flush=True)
    pair_set = set(pairs)
    by_stop = collections.defaultdict(list)
    for i, j in pairs:
        by_stop[i].append(j)
        by_stop[j].append(i)
    covered, out, batch, n_req = set(), {}, [], 0

    def flush(batch):
        nonlocal n_req
        coords = [pts[i] for i in batch]
        dist, fresh = fetch(coords)
        if fresh:
            n_req += 1
            time.sleep(1.0)
            if n_req % 25 == 0:
                print(n_req, 'requests,', len(covered), '/', len(pairs), 'pairs', flush=True)
        if dist is None:
            return
        pos = {i: k for k, i in enumerate(batch)}
        for i in batch:
            for j in by_stop[i]:
                if j in pos and (min(i, j), max(i, j)) in pair_set:
                    covered.add((min(i, j), max(i, j)))
                    d = dist[pos[i]][pos[j]]
                    if d is not None:
                        out[f'{pts[i][0]},{pts[i][1]}|{pts[j][0]},{pts[j][1]}'] = round(d)

    members = set()
    for i, j in pairs:
        if (i, j) in covered:
            continue
        need = (i not in members) + (j not in members)
        if len(batch) + need > TABLE:
            flush(batch)
            batch, members = [], set()
            if (i, j) in covered:
                continue
            need = 2
        for k in (i, j):
            if k not in members:
                batch.append(k)
                members.add(k)
    if batch:
        flush(batch)
    json.dump(out, open('walks.json', 'w'))
    walkable = sum(1 for d in out.values() if d <= MAX_M)
    print('done:', len(covered), 'pairs covered,', walkable // 2 if walkable else 0, 'about walkable within',
          MAX_M, 'm (both directions:', walkable, '), new requests', n_req, flush=True)


if __name__ == '__main__':
    main(sys.argv[1:])
