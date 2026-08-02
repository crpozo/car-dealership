# The Internet Coaches Dashboard

Multi-page dashboard rolling up car-dealership client performance for the Internet Coaches
team, with per-store drill-down and real timeframe filtering.

Live: https://crpozo.github.io/car-dealership/

## Navigation

The shell is a left sidebar (Dashboard, one entry per store with data, Settings) with a
breadcrumb topbar; the timeframe control lives in the topbar. The overview leads with a
single summary band, then a searchable store roster with a cards ⇄ table toggle
(persisted per browser). Store cards carry a performance pill — the engagement colour
band spelled out as Good / Average / Needs attention, never an invented rating — and
explicit View store / Salesperson activity actions. Tabs exist only inside a store.

| Route | What it shows |
|---|---|
| `#/overview` | **The dashboard.** Headline metrics across all stores, a card per store, and the store table: total opportunities · internet leads · engagement % · appts set of contacted % · internet closing % · total sold (DMS) · sales goal + pace. Click any card or row to open that store. |
| `#/store/<id>` | Store → **Performance**: the store's headline metrics plus the lead-type table (opportunities · contact · appts · shown · sold), MTD vs the same period last month. Lead-type rows drill down: click Internet/Phone/Walk-in → New/Used/Certified → vehicle make, all respecting the selected timeframe. Makes sort by good leads. |
| `#/store/<id>/activity` | Store → **Salesperson activity**: opportunities · internet leads · calls · emails · texts · appts set · shown % · internet sold · total sold |
| `#/store/<id>/internet` | Store → **Internet performance**: good leads · engagement % · appts set % · appts shown % · calls · texts · emails · internet sold · internet closing % |

Breadcrumbs (`Overview / <store>`) get you back. `#/stores` still redirects to the
overview so older links keep working, and `Pages.activity(range)` / `Pages.internet(range)`
still render the cross-store versions if a global view is ever wanted again.

## Timeframe filtering

The header control applies to every page: Today · Yesterday · This week · This month (MTD) ·
Last month · This year · Custom range. The selection persists in `localStorage`.

This works because the CRM exports are **cumulative month-to-date snapshots** run daily.
Sorting a store's snapshots by run date and differencing consecutive ones yields per-day
values, which are then summed for any requested range. Whole-month ranges use the cumulative
snapshot directly rather than re-summing days.

Presets are anchored to the **newest snapshot in the data**, not the wall clock, so they
never resolve to an empty range. When a range is wider than the reports covering it, a
banner says so — a partial period is never presented as a complete one.

## Metrics

| Metric | Definition |
|---|---|
| Total opportunities | Good Leads, all lead types (store TOTAL row) |
| Good internet leads | Good Leads where Lead Type = Internet |
| Engagement % | Internet Actual Contact % — target **80%** |
| Appts set of contacted % | Appts set ÷ contacted — target **40%**, can legitimately exceed 100% |
| Internet closing rate | Internet Sold in Time Frame ÷ internet Good Leads |
| Total sold (DMS) | Sold in Time Frame, all lead types |

Conditional colours: green at/above target, amber within 15% below, red further below.
Colour is never the only signal — every coloured cell also carries an arrow glyph.

**Referral and PreviousCustomer** are deliberately not shown as lead-type rows, but their
Good Leads and Sold still count in the store TOTAL. At 777 Nissan those two sources carry
only 10 leads but 4 sales, so dropping them entirely would lose real revenue.

**Engagement is internet-scoped everywhere.** VinSolutions reports `Internet Actual Contact %`
for internet leads only — it writes a literal 0 on Phone/Walk-in/Referral/PreviousCustomer
rows and copies the internet rate onto the store TOTAL row. The pipeline therefore rebases
the total's contacted count onto internet good leads; multiplying the internet rate by
all-lead-type leads would invent contacts that were never reported.

## Pace

Pace answers "should they be here yet, given how much of the month has been worked?"

```
elapsedFraction = NETWORKDAYS(monthStart, asOf) / NETWORKDAYS(monthStart, monthEnd)
expected        = monthlySalesGoal * elapsedFraction
```

Saturdays count as working days by default (dealerships work them); toggle in Settings.
There is no holiday calendar, so a dealership holiday reads as a worked day.

For ranges shorter than a month the monthly goal is **pro-rated to the working days inside
the selected range** — judging a single day against a whole month's target would paint every
store red.

Sales goals are not present in the CRM exports. They are entered in Settings and stored in
the browser only; a store with no goal shows "no goal" and is never marked red.

## Data

Source: VinSolutions "Enterprise Performance" exports, emailed daily by
`reportscheduler@motosnap.com`, plus a Matador Users activity CSV.

Currently loaded: **271 snapshots across 12 stores**, through Jul 30 2026. 777 Nissan and
Armstrong Subaru report daily since Jul 1 2026; ten more rooftops joined Jul 28 2026, so
the newer stores now have real daily deltas of their own.

Report shapes handled, all detected from the Filters sheet:
- single-dealer KPI (Lead Type / Inventory Type / Vehicle Make). 8 of 11 KPI stores carry
  the Vehicle Make level; 777 Nissan, Armstrong Subaru and Gresham are scheduled without a
  make summary level, so their drill-down stops at inventory type
- multi-dealer KPI — Vern Eide's Sioux City store reports two rooftops in one export, so
  the shared words become the store name: "Vern Eide Sioux City (combined)"
- per-user sales (`Summary Level 1 = User`) and the grouped variant (`= User Group`,
  used by Sommer's), whose group subtotal rows are skipped so reps are not double counted

A store with no data in the selected range is **left out** of the cards and tables
entirely — no placeholder, no count. The list below is therefore the only record of which
clients are missing which scheduled reports; keep it current.

Missing scheduled reports (these are the stores that get hidden):
- **Armstrong Volkswagen** — no KPI report at all, only salesperson activity
- **Vern Eide Honda** — KPI Prev MTD arrives but KPI MTD does not
- **Vern Eide Mitsubishi**, **Vern Eide Sioux City** — no KPI Prev MTD, so no comparison
- **Armstrong Subaru**, **Armstrong Volkswagen**, **Vern Eide Sioux City** — no Sales Prev MTD
- Armstrong Subaru's salesperson report is scheduled on a **fixed Jul 1–15 custom date
  range** instead of MTD, so its activity page covers Jul 1–15 only.
- The per-user report has no internet/non-internet split, so per-rep "Internet leads" and
  "Internet sold" render "—" rather than a guess. Sommer's export also omits Texts Out
  entirely, which renders "—" rather than a fabricated zero.
- A store that joins mid-month has only a cumulative month-to-date block, so day/week
  ranges inside that block report no data instead of counting the block as one day.
- Explanatory footnotes under the tables are switched off (`footnotes()` in
  `assets/pages.js` returns ""). The caveats live on the column-header tooltips instead.

## Rebuilding after new report exports

`assets/data.js` is generated — don't edit it by hand.

```bash
python3 pipeline/ingest.py ~/Desktop/Scott   # exports -> pipeline/data.json
python3 pipeline/build.py                    # data.json -> assets/data.js
```

`ingest.py` walks a directory recursively and accepts loose `.xlsx`, a Google Takeout `.zip`,
a `.mbox` mail export (it pulls the attachments out itself) and Matador `.csv`. Every
workbook is classified from its **Filters** sheet — dealer, date range, run date and summary
level — never from the filename or email subject, and duplicate sends are de-duplicated.
Raw exports are intentionally not committed.

Run the logic tests by opening `assets/core.test.html` in a browser (131 assertions).

`build.py` also stamps a content hash onto the asset URLs in `index.html`, so a rebuild is
never served from a stale browser cache.

Push to `main` deploys via GitHub Pages.
