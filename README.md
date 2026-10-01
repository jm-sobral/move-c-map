# MOVE-C Network Map

Interactive map of the public transport operators in the MOVE-C intermodal system (Região de Coimbra):
SMTUC, Metro Mondego (Metrobus), SIT Metropolitano and CP trains. Each operator is a map overlay that can be
switched on and off.

- **Pick a line** (list, search, or click it on the map; a road shared by several lines opens a
  chooser): the map draws the route and its stops, and
  the panel lists every variant, every stop in order (with the other lines calling there), and the
  roads the bus takes, in order, with distances.
- **Pick a stop** (search, or click it on the map from zoom 14): the panel lists every line that calls
  there with its destinations, plus the stops of any operator within a 250 m walk and their lines.
- **Vehicles now**: every trip running at the current time (Lisbon clock) is placed along its route by
  interpolating between its scheduled stop times. SMTUC buses reporting live GPS are shown at their
  real position (solid badge) with an estimated delay; everything else is a timetable estimate
  (dashed badge). Click a vehicle for its next stop. "Change time" shows the network at any date and
  time the timetables cover (GPS only applies to the current time).
- **Next departures** at the selected stop, for the next 3 hours.
- **Your location**: on first visit the browser asks to share your location. If you allow it and are in
  the Região de Coimbra, the map centres on you (unless the page was opened on a linked line or stop),
  and a blue dot with an accuracy ring follows you while the page is visible. The locate button
  (under the zoom buttons) brings the map back to you. The position never leaves the browser.
  Browsers only share location with pages served over https (or localhost).
- **Plan a journey**: on a stop, press "From here", then on another stop "To here". The planner
  searches every SMTUC, Metrobus and SIT trip on that day's timetable, with up to two changes and walks
  of up to 400 m between stops (real walking distances, so it never walks across the river). It lists
  up to five journeys from the current or chosen time, draws the selected one on the map, and shows
  its vehicles. Times are scheduled; delays are not taken into account. Journeys that use an
  Intercidades or Alfa Pendular train are flagged as not covered by MOVE-C.
- **CP trains**: every train calling in the region (Urbano, Regional, InterRegional, Intercidades,
  Alfa Pendular), cut to its stations inside the 19 municipalities plus the next station beyond. Lines
  are named after where the train really starts and ends, and departures show its real destination.
  MOVE-C coverage is assumed for Urbano, Regional and InterRegional trains only; CP has not published
  which services the pass covers. Trains have no live positions (CP publishes no open real-time feed).
- Deep links: `#line-sit-205`, `#line-smtuc-38`, `#line-mm-U1`, `#line-cp-u-coimbra-b-figueira-da-foz`,
  `#stop-<operator>-<stop code>` (e.g. `#stop-smtuc-1509`) and `#plan-<stop>~<stop>`
  (e.g. `#plan-sit-24423~cp-94_31039`). Stop codes come from the operators' data, so links keep working
  after a rebuild.

## Run

```bash
python -m http.server 8765 --directory coimbra-transit-map
```

Then open http://localhost:8765/#line-sit-205. The basemap uses OpenStreetMap tiles, so the page needs
internet access and should be served over http (not opened as a `file://`).

## Data

| Layer | Source | Notes |
|---|---|---|
| Stops, lines, variants, first/last departures (all operators) | AGIT NeTEx EPIP exports, `api.planner.agit.pt/v1/datasets/{smtuc,sit,metro-mondego}` | Published 2026-09-23, CC BY 4.0 |
| Metro Mondego route geometry | "Rede Metrobus" KMZ, dados.gov.pt | Stops joined along the official corridor axes |
| Timetables and calendars (all operators) | Same AGIT NeTEx exports | Every trip's stop times; shipped as `timetable.js` |
| SMTUC live vehicle positions | `api.planner.agit.pt/v1/datasets/smtuc/realtime/vehicles`, read by the browser every 30 s | Not stored in the repo. Licence still "pending operator confirmation" in the feed metadata |
| CP stations, trains, timetables | CP GTFS, `publico.cp.pt/gtfs/gtfs.zip` | Official, CC0, regenerated daily; it has no track shapes |
| CP track geometry | OpenStreetMap railway tracks via Overpass | Each station-to-station stretch is traced along the mapped tracks (113 of 115 on 2026-10-01); where the mapped track has a gap, that stretch is drawn straight between stations |
| Região de Coimbra boundary | CAOP (Direção-Geral do Território) via json.geoapi.pt | `tools/regiao-coimbra.geojson`, simplified to ~40 m; decides which stations are in the region |
| Walking transfers for the planner | OSRM foot profile on OpenStreetMap (routing.openstreetmap.de) | Stop pairs within 400 m on foot; shipped in `timetable.js` |
| SIT and SMTUC route geometry, road names | OSRM on OpenStreetMap | Neither published dataset has licensed shapes, so paths are computed stop to stop on the road network and can differ from the real route on short stretches |

Stretches where the computed road route is far longer than the distance between the two stops
(over 3× plus 1.5 km) are treated as routing errors: drawn straight and left out of the road list.

## Licence

Code: MIT ([LICENSE](LICENSE)). Data bundles `data.js` and `timetable.js`: ODbL 1.0 ([DATA_LICENSE.md](DATA_LICENSE.md)).

## Rebuild the data bundle

Scripts in `tools/` (Python 3, standard library only):

1. Download the three NeTEx ZIPs, the Metrobus KMZ and the CP GTFS (`publico.cp.pt/gtfs/gtfs.zip`);
   unzip into `data/` (CP into `data/cp/`). Save the railway tracks from OpenStreetMap as
   `data/osm-rail.json` with the Overpass query
   `[out:json][timeout:180];way["railway"="rail"](39.75,-9.0,40.75,-7.6);out tags geom;`
   (POST it to `https://overpass-api.de/api/interpreter`; tracks rarely change, so the saved file can be reused).
2. `python tools/parse_netex.py data/<op>/netex.xml <op>.json` for `sit`, `smtuc`, `metro-mondego`, and
   `python tools/parse_gtfs_cp.py data/cp tools/regiao-coimbra.geojson cp.json data/osm-rail.json` for CP
   (without the last argument, trains are drawn station to station).
3. `python tools/osrm_fetch.py sit.json smtuc.json`: road-routes every unique stop sequence
   (about 1,500 requests at 1 per second; results cached in `osrm_cache/`, re-runs resume).
4. `python tools/walk_fetch.py sit.json smtuc.json metro-mondego.json cp.json`: walking distances
   between stops within 400 m of each other, for the journey planner. Pairs already in `walks.json`
   are kept, so a rebuild only measures new stops (a first run is about 100 requests).
5. `python tools/build.py data.js`: writes `data.js` and `timetable.js`, the two bundles the page loads. Add `--smtuc-shapes` (with the
   SMTUC GTFS unzipped in `data/gsm/`) to use the official SMTUC shapes; that dataset has no licence
   yet, so don't publish a bundle built this way.

After a deploy, pages that are already open notice the new version within about 5 minutes (the build
stamps `app.js?v=` in `index.html`) and offer a "Reload" bar, so visitors are not left on a copy their
browser cached.
