# MOVE-C Network Map

Interactive map of the public transport operators in the MOVE-C intermodal system (Região de Coimbra):
SMTUC, Metro Mondego (Metrobus) and SIT Metropolitano. Each operator is a map overlay that can be
switched on and off.

- **Pick a line** (list, search, or click it on the map): the map draws the route and its stops, and
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
- Deep links: `#line-sit-205`, `#line-smtuc-38`, `#line-mm-U1`, `#stop-<n>`.

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
| SIT and SMTUC route geometry, road names | OSRM on OpenStreetMap | Neither published dataset has licensed shapes, so paths are computed stop to stop on the road network and can differ from the real route on short stretches |

Stretches where the computed road route is far longer than the distance between the two stops
(over 3× plus 1.5 km) are treated as routing errors: drawn straight and left out of the road list.

## Licence

Code: MIT ([LICENSE](LICENSE)). Data bundles `data.js` and `timetable.js`: ODbL 1.0 ([DATA_LICENSE.md](DATA_LICENSE.md)).

## Rebuild the data bundle

Scripts in `tools/` (Python 3, standard library only):

1. Download the three NeTEx ZIPs and the Metrobus KMZ; unzip into `data/`.
2. `python tools/parse_netex.py data/<op>/netex.xml <op>.json` for `sit`, `smtuc`, `metro-mondego`.
3. `python tools/osrm_fetch.py sit.json smtuc.json`: road-routes every unique stop sequence
   (about 1,500 requests at 1 per second; results cached in `osrm_cache/`, re-runs resume).
4. `python tools/build.py data.js`: writes `data.js` and `timetable.js`, the two bundles the page loads. Add `--smtuc-shapes` (with the
   SMTUC GTFS unzipped in `data/gsm/`) to use the official SMTUC shapes; that dataset has no licence
   yet, so don't publish a bundle built this way.
