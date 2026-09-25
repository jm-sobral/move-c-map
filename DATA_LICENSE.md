# Data licence

`data.js` (the network data the map loads) is made available under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).

It is a derived database: the route paths and road names were computed on the OpenStreetMap road
network, and ODbL requires derived databases to be shared under the same licence. You may copy,
adapt and redistribute it, provided you credit the sources below and share any adapted database
under ODbL 1.0.

## Sources and attribution

| Source | Publisher | Licence | Used for |
|---|---|---|---|
| NeTEx EPIP exports for SMTUC, SIT Metropolitano and Metro Mondego (`api.planner.agit.pt`), published 2026-09-23 | AGIT – Agência para a Gestão do Sistema Intermodal da Região de Coimbra | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Stops, lines, schedule variants, first and last departures |
| "Rede Metrobus" KMZ ([dados.gov.pt](https://dados.gov.pt/pt/datasets/metro-mondego/)), 2026-08-17 | Metro Mondego, S.A. | CC BY | Metrobus route geometry |
| OpenStreetMap road network, routed with [OSRM](https://project-osrm.org/) | © OpenStreetMap contributors | [ODbL 1.0](https://www.openstreetmap.org/copyright) | SIT and SMTUC route paths, road names |

Map tiles shown on the page are © OpenStreetMap contributors and are not part of this repository.

## Not included

The SMTUC static GTFS on dados.gov.pt has official route shapes, but the dataset states no licence,
so its shapes are not in the published `data.js`. `tools/build.py --smtuc-shapes` builds a bundle
that uses them, for local use or for publishing once SMTUC confirms a licence.

Route paths for SIT and SMTUC are computed approximations, not operator-published routes. Timetable
information is indicative; check [SIT](https://sit-regiaodecoimbra.pt/linhas-e-horarios/),
[SMTUC](https://www.smtuc.pt/) and [Metro Mondego](https://www.metromondego.pt/) for official
schedules.
