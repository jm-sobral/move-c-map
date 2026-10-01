# Data licence

`data.js` and `timetable.js` (the network and timetable data the map loads) are made available under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).

It is a derived database: the route paths and road names were computed on the OpenStreetMap road
network, and ODbL requires derived databases to be shared under the same licence. You may copy,
adapt and redistribute it, provided you credit the sources below and share any adapted database
under ODbL 1.0.

## Sources and attribution

| Source | Publisher | Licence | Used for |
|---|---|---|---|
| NeTEx EPIP exports for SMTUC, SIT Metropolitano and Metro Mondego (`api.planner.agit.pt`), published 2026-09-23 | AGIT – Agência para a Gestão do Sistema Intermodal da Região de Coimbra | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Stops, lines, schedule variants, trip stop times and calendars |
| "Rede Metrobus" KMZ ([dados.gov.pt](https://dados.gov.pt/pt/datasets/metro-mondego/)), 2026-08-17 | Metro Mondego, S.A. | CC BY | Metrobus route geometry |
| CP GTFS ([publico.cp.pt/gtfs/gtfs.zip](https://publico.cp.pt/gtfs/gtfs.zip)) | CP – Comboios de Portugal, E.P.E. | CC0 1.0 | Train stations, trips, stop times and calendars |
| OpenStreetMap: road network routed with [OSRM](https://project-osrm.org/), railway tracks via Overpass | © OpenStreetMap contributors | [ODbL 1.0](https://www.openstreetmap.org/copyright) | SIT and SMTUC route paths, road names, walking distances between stops, CP railway track geometry |

Live SMTUC vehicle positions are fetched by the visitor's browser from AGIT's realtime API
(`api.planner.agit.pt/v1/datasets/smtuc/realtime/vehicles`) and are not part of this repository. The
feed's metadata lists its licence as pending operator confirmation.

Map tiles shown on the page are © OpenStreetMap contributors and are not part of this repository.

`tools/regiao-coimbra.geojson` (the outline of the 19 municipalities, used by the build to decide which
stations are in the region) is derived from the CAOP of the Direção-Geral do Território, obtained through
json.geoapi.pt and simplified.

## Not included

The SMTUC static GTFS on dados.gov.pt has official route shapes, but the dataset states no licence,
so its shapes are not in the published bundles. `tools/build.py --smtuc-shapes` builds a bundle
that uses them, for local use or for publishing once SMTUC confirms a licence.

Route paths for SIT and SMTUC are computed approximations, not operator-published routes. Timetable
information is indicative; check [SIT](https://sit-regiaodecoimbra.pt/linhas-e-horarios/),
[SMTUC](https://www.smtuc.pt/) and [Metro Mondego](https://www.metromondego.pt/) for official
schedules.
