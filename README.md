# The Internet Coaches Dashboard

Single-file dashboard that rolls up car-dealership client performance for the Internet Coaches team, with per-store drill-down.

Live: https://crpozo.github.io/car-dealership/

## Features

- **Store overview** — every client store with status (On pace / Watch / At risk), MTD KPIs vs the same days of last month, lead-source mix; filter by CRM, tool and status; global search (⌘F / Ctrl F); Export CSV of the current view.
- **Store detail** — MTD KPI comparison by lead type (drill into inventory type and vehicle make) plus the salesperson activity table, with Matador AI activity merged per rep where available.
- **Notifications** — the bell surfaces stores at risk / on watch, reps below the shown target, and data-source gaps; read state persists in the browser.
- **Settings** — status-model thresholds (at-risk / watch drops, no-baseline benchmarks, rep shown target) and number locale are editable and persist in `localStorage`.
- **Data sources** — ingestion status for each CRM/tool (VinSolutions, Tekion, DriveCentric, Momentum, Matador, Covideo).

## Data

Currently loaded: VinSolutions "Enterprise Performance" exports (run Jun 22 & Jul 2, 2026) for Vern Eide Honda, 777 Nissan and Armstrong Subaru, plus the Matador MTD user report for Vern Eide Honda. Only real client data is shown.

## Rebuilding after new report exports

`index.html` is generated — don't edit it by hand:

```
python3 pipeline/extract.py   # parse the report exports → pipeline/data.json
python3 pipeline/build.py     # inject data.json into pipeline/template.html → index.html
```

`extract.py` expects the raw report exports locally (path at the top of the file); the raw exports are intentionally not committed. Push to `main` deploys via GitHub Pages.
