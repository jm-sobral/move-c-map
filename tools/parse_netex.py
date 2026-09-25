"""Parse AGIT NeTEx EPIP exports into compact JSON: stops, lines, journey patterns."""
import json, sys, collections
import xml.etree.ElementTree as ET

NS = '{http://www.netex.org.uk/netex}'


def local(tag):
    return tag.rsplit('}', 1)[-1]


def txt(el, name):
    c = el.find(NS + name)
    return c.text.strip() if c is not None and c.text else None


def keyval(el, key):
    kl = el.find(NS + 'keyList')
    if kl is None:
        return None
    for kv in kl:
        if txt(kv, 'Key') == key:
            return txt(kv, 'Value')
    return None


def loc(el):
    l = el.find('.//' + NS + 'Location')
    if l is None:
        return None
    return round(float(txt(l, 'Latitude')), 6), round(float(txt(l, 'Longitude')), 6)


def parse(path):
    ssp = {}        # ScheduledStopPoint id -> dict
    lines = {}      # Line id -> dict
    routes = {}     # Route id -> dict (line, direction)
    sjp = {}        # ServiceJourneyPattern id -> dict(route, stops[], spijp->ssp)
    spijp = {}      # StopPointInJourneyPattern id -> ssp id
    trips = collections.Counter()  # sjp id -> journeys
    first_dep = collections.defaultdict(list)  # sjp id -> departure times at first stop
    trip_ids = collections.defaultdict(list)  # sjp id -> gtfs trip ids (sample)
    daytypes = collections.defaultdict(set)

    wanted = {'ScheduledStopPoint', 'Line', 'Route', 'ServiceJourneyPattern', 'ServiceJourney'}
    for ev, el in ET.iterparse(path, events=('end',)):
        t = local(el.tag)
        if t not in wanted:
            continue
        i = el.get('id')
        if t == 'ScheduledStopPoint':
            ll = loc(el)
            ssp[i] = {'n': txt(el, 'Name'), 'll': ll, 'code': txt(el, 'PublicCode'),
                      'gid': keyval(el, 'gtfs:stop_id')}
        elif t == 'Line':
            pres = el.find(NS + 'Presentation')
            lines[i] = {'name': txt(el, 'Name'), 'short': txt(el, 'ShortName'),
                        'mode': txt(el, 'TransportMode'), 'gid': keyval(el, 'gtfs:route_id'),
                        'color': txt(pres, 'Colour') if pres is not None else None,
                        'text': txt(pres, 'TextColour') if pres is not None else None}
        elif t == 'Route':
            lr = el.find(NS + 'LineRef')
            routes[i] = {'line': lr.get('ref') if lr is not None else None,
                         'dir': txt(el, 'DirectionType'), 'name': txt(el, 'Name')}
        elif t == 'ServiceJourneyPattern':
            rr = el.find(NS + 'RouteRef')
            stops = []
            for sp in el.find(NS + 'pointsInSequence'):
                ref = sp.find(NS + 'ScheduledStopPointRef').get('ref')
                spijp[sp.get('id')] = ref
                stops.append((int(sp.get('order')), ref))
            stops.sort()
            sjp[i] = {'route': rr.get('ref') if rr is not None else None,
                      'stops': [s for _, s in stops]}
        elif t == 'ServiceJourney':
            p = el.find(NS + 'ServiceJourneyPatternRef').get('ref')
            trips[p] += 1
            pts = el.find(NS + 'passingTimes')
            if pts is not None and len(pts):
                d = txt(pts[0], 'DepartureTime')
                if d:
                    first_dep[p].append(d[:5])
            g = keyval(el, 'gtfs:trip_id')
            if g and len(trip_ids[p]) < 3:
                trip_ids[p].append(g)
            for dt in el.iter(NS + 'DayTypeRef'):
                daytypes[p].add(dt.get('ref'))
        el.clear()

    out_lines = []
    for lid, L in lines.items():
        pats = []
        for pid, P in sjp.items():
            R = routes.get(P['route'])
            if not R or R['line'] != lid:
                continue
            deps = sorted(first_dep[pid])
            pats.append({'id': pid, 'dir': R['dir'], 'stops': P['stops'], 'trips': trips[pid],
                         'first': deps[0] if deps else None, 'last': deps[-1] if deps else None,
                         'gtrips': trip_ids[pid]})
        out_lines.append({**L, 'id': lid, 'patterns': pats})
    return {'stops': ssp, 'lines': out_lines}


if __name__ == '__main__':
    src, dst = sys.argv[1], sys.argv[2]
    d = parse(src)
    json.dump(d, open(dst, 'w', encoding='utf-8'), ensure_ascii=False)
    np = sum(len(l['patterns']) for l in d['lines'])
    print(dst, 'stops', len(d['stops']), 'lines', len(d['lines']), 'patterns', np,
          'no-trip patterns', sum(1 for l in d['lines'] for p in l['patterns'] if not p['trips']))
