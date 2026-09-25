"""Road-route each unique journey pattern (stop sequence) through the public OSRM demo server.
Cached per pattern in osrm_cache/, so re-runs resume. Polite: ~1 request/second."""
import json, hashlib, os, sys, time, urllib.request

CACHE = 'osrm_cache'
os.makedirs(CACHE, exist_ok=True)
CHUNK = 90


def fetch(coords):
    path = ';'.join(f'{lon},{lat}' for lat, lon in coords)
    url = (f'https://router.project-osrm.org/route/v1/driving/{path}'
           '?overview=full&geometries=polyline6&steps=true&continue_straight=false')
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'coimbra-transit-map (research)'})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except Exception as e:
            print('  retry', attempt, e, flush=True)
            time.sleep(5 * (attempt + 1))
    return None


def route(coords):
    """Returns list of chunk responses (legs kept separately)."""
    out = []
    i = 0
    while i < len(coords) - 1:
        part = coords[i:i + CHUNK]
        res = fetch(part)
        time.sleep(1.0)
        if not res or res.get('code') != 'Ok':
            out.append({'error': res.get('code') if res else 'none', 'n': len(part)})
        else:
            rt = res['routes'][0]
            out.append({'legs': [{'d': lg['distance'], 't': lg['duration'],
                                  'steps': [{'n': s.get('name', ''), 'r': s.get('ref', ''), 'd': s['distance'],
                                             'g': s['geometry']} for s in lg['steps']]}
                                 for lg in rt['legs']]})
        i += CHUNK - 1
    return out


def main(files):
    todo = {}
    for f in files:
        d = json.load(open(f, encoding='utf-8'))
        for L in d['lines']:
            for P in L['patterns']:
                coords = [tuple(d['stops'][s]['ll']) for s in P['stops']]
                key = hashlib.sha1(json.dumps(coords).encode()).hexdigest()[:16]
                todo[key] = coords
    keys = [k for k in todo if not os.path.exists(f'{CACHE}/{k}.json')]
    print('unique patterns', len(todo), 'to fetch', len(keys), flush=True)
    for n, k in enumerate(keys):
        res = route(todo[k])
        json.dump(res, open(f'{CACHE}/{k}.json', 'w'))
        if n % 25 == 0:
            print(n, '/', len(keys), flush=True)
    print('done', flush=True)


if __name__ == '__main__':
    main(sys.argv[1:])
