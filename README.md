# Dealer Performance Hub — Prototype

Single-file dashboard ("PaceBoard") that rolls up car-dealership client performance for the consulting team, with per-store drill-down:

- **Store overview** — every client store as a card with status (On pace / Watch / At risk), MTD KPIs vs the same days of last month, lead-source mix, and filters by CRM, tool, and status.
- **Store detail** — MTD KPI comparison by lead type (drill into inventory type and vehicle make) plus the salesperson activity table, with Matador AI activity merged per rep where available.
- **Data sources** — ingestion status for each CRM/tool (VinSolutions, Tekion, DriveCentric, Momentum, Matador, Covideo).

Live: https://crpozo.github.io/car-dealership/

## Data

Built from VinSolutions "Enterprise Performance" exports (run Jun 22 & Jul 2, 2026) for Vern Eide Honda, 777 Nissan and Armstrong Subaru, plus the Matador MTD user report for Vern Eide Honda. Stores flagged **DEMO** carry illustrative numbers only, to preview how clients on other CRMs plug into the same view.

## Rebuilding

`index.html` is generated — don't edit it by hand:

```
python3 pipeline/extract.py   # parse the report exports → pipeline/data.json
python3 pipeline/build.py     # inject data.json into pipeline/template.html → index.html
```

`extract.py` expects the raw report exports locally (path at the top of the file); the raw exports are intentionally not committed.
