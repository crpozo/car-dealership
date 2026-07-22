# The Internet Coaches Dashboard

Multi-page dashboard rolling up car-dealership client performance for the Internet Coaches
team, with per-store drill-down and real timeframe filtering.

Live: https://crpozo.github.io/car-dealership/

## Navigation

There is **one** dashboard at the top level. Tabs exist only inside a store, because
"salesperson activity" and "internet performance" only mean something once you have
picked a store — a global tab bar had nothing meaningful to switch between.

| Route | What it shows |
|---|---|
| `#/overview` | **The dashboard.** Headline metrics across all stores, a card per store, and the store table: total opportunities · internet leads · engagement % · appts set of contacted % · internet closing % · total sold (DMS) · sales goal + pace. Click any card or row to open that store. |
| `#/store/<id>` | Store → **Performance**: the store's headline metrics plus the lead-type table (opportunities · contact · appts · shown · sold), MTD vs the same period last month |
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

Currently loaded: **116 snapshots** — 114 from the mailbox (777 Nissan and Armstrong Subaru,
daily Jul 1–22 2026) plus 2 from a manual Vern Eide Honda export (Jun 22 2026).

Known gaps, surfaced in the UI rather than hidden:
- Vern Eide Honda is not on the scheduled-report list — only the one June export exists.
- Armstrong Subaru's salesperson report is scheduled on a **fixed Jul 1–15 custom date
  range** instead of MTD, so its activity page covers Jul 1–15 only. Worth fixing in
  VinSolutions.
- The per-user report has no internet/non-internet split, so per-rep "Internet leads" and
  "Internet sold" render "—" rather than a guess.

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

Run the logic tests by opening `assets/core.test.html` in a browser (106 assertions).

Push to `main` deploys via GitHub Pages.
