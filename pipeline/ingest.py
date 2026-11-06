#!/usr/bin/env python3
"""Ingest VinSolutions report exports into pipeline/data.json.

Sources it walks, recursively, in any mix:
  *.zip    a Google Takeout archive (extracted to a cache dir, then re-walked)
  *.mbox   a Takeout mail export — every .xlsx attachment is pulled out
  *.xlsx   a loose report export
  *.csv    a Matador "Users" activity export

Every workbook is classified from its **Filters** sheet, never from the filename or
the mail subject: Dealers / Date Range / Date Range Begin / Date Range End / Run Date /
Summary Level 1. The same report is often sent twice, so snapshots are de-duplicated on
(storeId, kind, period, begin, end, runDate).

Usage:
    python3 pipeline/ingest.py [SRC_DIR ...]     # default: ~/Desktop/Scott
    python3 pipeline/build.py                    # then: data.json -> assets/data.js
"""
import csv
import json
import os
import re
import shutil
import sys
import zipfile
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data.json")
DEFAULT_SRC = os.path.expanduser("~/Projects/Scott")
CACHE = os.path.join(HERE, ".cache")

# Stores kept out of the dashboard entirely, by slug. Empty today: Vern Eide Honda
# was excluded while its only export was a stale one-off from Jun 22 2026, but it
# joined the daily schedule on Jul 28 2026 along with nine other rooftops, so it is
# back in. Excluded stores are always reported at the end of a run, never dropped
# silently.
EXCLUDE_STORES = {"777-nissan"}  # dropped at the client's request, 2026-08-28

# Dealer groups, matched against the store name. A group only surfaces in the UI
# when at least two of its stores actually have data, so listing future clients
# here (Lindsay, Lehigh Valley, Herson's) costs nothing until they onboard.
STORE_GROUPS = [
    ("vern-eide", "Vern Eide", "vern eide"),
    ("armstrong", "Armstrong", "armstrong"),
    ("lindsay", "Lindsay", "lindsay"),
    ("vinart", "Vinart Group", "lehigh valley"),   # Lehigh Valley Honda/Hyundai/Acura + MB Porsche of Lehigh Valley (Momentum)
    ("hersons", "Herson's", "herson"),
    ("garavel", "Garavel", "garavel"),
    ("el-cajon", "El Cajon", "el cajon"),       # Honda of El Cajon + Toyota of El Cajon (DriveCentric)
]


def group_for(store_name):
    low = store_name.lower()
    for gid, gname, needle in STORE_GROUPS:
        if needle in low:
            return gid, gname
    return None, None

MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
HOUSE_ACCOUNT = re.compile(r"\b(team|house)\b", re.IGNORECASE)
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #

def slug(name):
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").strip().lower())
    return s.strip("-")


def combined_name(dealers):
    """Name a report that covers several rooftops at once.

    Some groups report two rooftops as one unit (Vern Eide's Sioux City store sends
    "Vern Eide Honda Sioux City, Vern Eide Hyundai Sioux City" in a single export).
    The shared words at each end are the store's real identity, so
    "Vern Eide Honda Sioux City" + "Vern Eide Hyundai Sioux City" becomes
    "Vern Eide Sioux City (combined)" — derived from the Filters sheet, never from
    the mail subject. Falls back to joining the names when nothing is shared.
    """
    parts = [d.strip() for d in dealers.split(",") if d.strip()]
    if len(parts) == 1:
        return parts[0]
    words = [p.split() for p in parts]
    head = []
    for i in range(min(len(w) for w in words)):
        token = words[0][i]
        if all(w[i] == token for w in words):
            head.append(token)
        else:
            break
    tail = []
    for i in range(1, min(len(w) for w in words) - len(head) + 1):
        token = words[0][-i]
        if all(w[-i] == token for w in words):
            tail.insert(0, token)
        else:
            break
    shared = head + tail
    if not shared:
        return " + ".join(parts)
    return " ".join(shared) + " (combined)"


def parse_dt(value):
    """'Jul  2 2026  8:10AM' / 'Jun  1 2026 12:00AM' -> date string 'YYYY-MM-DD'."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d")
    parts = re.sub(r"\s+", " ", str(value).strip()).split(" ")
    if len(parts) < 3 or parts[0][:3] not in MONTHS:
        return None
    try:
        return datetime(int(parts[2]), MONTHS.index(parts[0][:3]) + 1, int(parts[1])).strftime("%Y-%m-%d")
    except ValueError:
        return None


def num(value):
    if value is None or value == "":
        return 0
    try:
        f = float(value)
    except (TypeError, ValueError):
        return 0
    return int(f) if f == int(f) else round(f, 6)


def cell(row, idx, col):
    if col not in idx:
        return ""
    v = row[idx[col]]
    return "" if v is None else str(v).strip()


# --------------------------------------------------------------------------- #
# source discovery: zip / mbox / xlsx / csv
# --------------------------------------------------------------------------- #

def unpack_zips(paths, log):
    """Extract every zip into CACHE and return the extra roots to walk."""
    roots = []
    for p in paths:
        target = os.path.join(CACHE, "zip", slug(os.path.basename(p))[:60])
        try:
            shutil.rmtree(target, ignore_errors=True)
            os.makedirs(target, exist_ok=True)
            with zipfile.ZipFile(p) as zf:
                zf.extractall(target)
            roots.append(target)
            log.append("unzipped %s" % os.path.basename(p))
        except Exception as exc:  # noqa: BLE001 - a bad archive must not abort the run
            log.append("SKIP zip %s: %s" % (os.path.basename(p), exc))
    return roots


def extract_mbox(path, log):
    """Pull every .xlsx attachment out of an mbox. Returns list of file paths."""
    import mailbox

    out_dir = os.path.join(CACHE, "mbox", slug(os.path.basename(path))[:60])
    shutil.rmtree(out_dir, ignore_errors=True)
    os.makedirs(out_dir, exist_ok=True)
    found, seen = [], set()
    try:
        box = mailbox.mbox(path)
    except Exception as exc:  # noqa: BLE001
        log.append("SKIP mbox %s: %s" % (os.path.basename(path), exc))
        return []
    for msg in box:
        for part in msg.walk():
            fname = part.get_filename()
            if not fname or not fname.lower().endswith(".xlsx"):
                continue
            try:
                payload = part.get_payload(decode=True)
            except Exception:  # noqa: BLE001
                continue
            if not payload:
                continue
            name, i = fname, 1
            while name in seen:
                name = "%s__%d.xlsx" % (fname[:-5], i)
                i += 1
            seen.add(name)
            dest = os.path.join(out_dir, name)
            with open(dest, "wb") as fh:
                fh.write(payload)
            found.append(dest)
    log.append("mbox %s -> %d xlsx attachments" % (os.path.basename(path), len(found)))
    return found


def discover(src_dirs, log):
    """Walk the sources and return (xlsx_paths, matador_csv_paths, other_csv_paths, pdf_paths)."""
    xlsx, csvs, other_csvs, pdfs, goals, mboxes, zips = [], [], [], [], [], [], []
    momentum, focus = [], []

    def walk(roots):
        for root in roots:
            if os.path.isfile(root):
                classify(root)
                continue
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames[:] = [d for d in dirnames if d != os.path.basename(CACHE)]
                for fn in filenames:
                    classify(os.path.join(dirpath, fn))

    def classify(path):
        low = path.lower()
        base = os.path.basename(path)
        if base.startswith("~$") or base.startswith("."):
            return
        if low.endswith(".xlsx"):
            xlsx.append(path)
        elif low.endswith(".mbox"):
            mboxes.append(path)
        elif low.endswith(".zip"):
            zips.append(path)
        elif low.endswith(".csv") and "sales goals" in base.lower():
            goals.append(path)        # per-rep goals + teams, hand-maintained
        elif low.endswith(".csv") and "matador" in base.lower():
            csvs.append(path)
        elif low.endswith(".csv") and "salesperson stats" in base.lower():
            momentum.append(path)     # Momentum (Vinart Group) daily MTD salesperson CSVs
        elif low.endswith(".csv") and FOCUS_NAME.match(base):
            focus.append(path)        # Reynolds Focus: written by the crm-bots Focus bot
        elif low.endswith(".csv"):
            other_csvs.append(path)   # sniffed later — Covideo names everything report.csv
        elif low.endswith(".pdf"):
            pdfs.append(path)         # DriveCentric KPI Comparison Reports

    walk(src_dirs)
    if zips:
        walk(unpack_zips(zips, log))
    for mb in mboxes:
        xlsx.extend(extract_mbox(mb, log))
    return xlsx, csvs, other_csvs, pdfs, goals, momentum, focus


# --------------------------------------------------------------------------- #
# workbook parsing
# --------------------------------------------------------------------------- #

def read_filters(wb):
    out = {}
    if "Filters" not in wb.sheetnames:
        return out
    for row in wb["Filters"].iter_rows(values_only=True):
        if not row or row[0] is None:
            continue
        key = re.sub(r"\s+", " ", str(row[0])).strip()
        if not key or key == "Filter Name":
            continue
        out[key] = str(row[2]).strip() if len(row) > 2 and row[2] is not None else ""
    return out


def read_report(wb):
    rows = [r for r in wb["Report"].iter_rows(values_only=True)
            if any(v is not None and str(v).strip() != "" for v in r)]
    if not rows:
        return [], {}
    header = [re.sub(r"\s+", " ", str(h)).strip() if h is not None else "" for h in rows[0]]
    return rows[1:], {h: i for i, h in enumerate(header) if h}


def metrics_from(row, idx):
    """Normalize one report row into the metrics bag the dashboard consumes.

    "Internet Actual Contact %" is an internet-only measure: VinSolutions writes a
    literal 0 for Phone / Walk-in / Referral / PreviousCustomer rows, and copies the
    *internet* rate onto the store TOTAL row. So the derived contacted count is only
    meaningful where the rate is non-zero, and the TOTAL row's count has to be based
    on internet good leads, not on all good leads — see reconcile_total() below.
    """
    good = num(row[idx["Good Leads"]]) if "Good Leads" in idx else 0
    contact_pct = num(row[idx["Internet Actual Contact %"]]) if "Internet Actual Contact %" in idx else 0
    set_of_contacted = num(row[idx["Appts Set of Contacted %"]]) if "Appts Set of Contacted %" in idx else 0
    appt_set_pct = num(row[idx["Appts Set %"]]) if "Appts Set %" in idx else None

    # Percentages alone cannot be aggregated, so derive the underlying counts.
    contacted = int(round(contact_pct * good)) if contact_pct else 0
    if appt_set_pct is not None:
        appts_set = int(round(appt_set_pct * good))
    else:
        appts_set = int(round(set_of_contacted * contacted))

    return {
        "goodLeads": good,
        "sold": num(row[idx["Sold in Time Frame"]]) if "Sold in Time Frame" in idx else 0,
        "apptsShown": num(row[idx["Appts Shown"]]) if "Appts Shown" in idx else 0,
        "contactPct": contact_pct,
        "apptSetOfContactedPct": set_of_contacted,
        "apptSetPct": appt_set_pct,
        "contacted": contacted,
        "apptsSet": appts_set,
    }


def reconcile_total(total, by_lead_type):
    """Rebase the TOTAL row's contacted / appts-set counts onto internet good leads.

    The export copies the internet contact rate onto the TOTAL row, so multiplying it
    by all-lead-type good leads invents contacts that were never reported (509 leads x
    the 60.06% internet rate = 306 "contacts" when only 206 internet leads were
    actually contacted). Engagement is an internet measure throughout this dashboard,
    so the store total carries the internet counts and says so.
    """
    if not total:
        return total
    internet = None
    for node in by_lead_type:
        if (node.get("leadType") or "").strip().lower() == "internet":
            internet = node.get("metrics")
            break
    if not internet:
        total["contacted"] = 0
        total["apptsSet"] = 0
        total["contactScope"] = "none"
        return total
    total["contacted"] = internet.get("contacted", 0)
    total["apptsSet"] = internet.get("apptsSet", 0)
    total["contactScope"] = "internet"
    return total


def parse_kpi(rows, idx):
    """Hierarchical KPI report -> (total, byLeadType). Depth varies by export."""
    total = None
    by_lead_type = []
    cur_lt = None
    cur_inv = None
    has_dealer = "Dealer" in idx

    for row in rows:
        dealer = cell(row, idx, "Dealer")
        lt = cell(row, idx, "Lead Type")
        inv = cell(row, idx, "Inventory Type")
        make = cell(row, idx, "Vehicle Make")

        if dealer == "TOTAL" or lt == "TOTAL":
            total = metrics_from(row, idx)
            continue
        # dealer-level subtotal row (Dealer summary exports)
        if has_dealer and dealer and not lt and not inv and not make:
            if total is None:
                total = metrics_from(row, idx)
            continue
        if lt and not inv and not make:
            cur_lt = {"leadType": lt, "metrics": metrics_from(row, idx), "byInventory": []}
            by_lead_type.append(cur_lt)
            cur_inv = None
        elif lt and inv and not make:
            if cur_lt is None or cur_lt["leadType"] != lt:
                cur_lt = {"leadType": lt, "metrics": None, "byInventory": []}
                by_lead_type.append(cur_lt)
            cur_inv = {"inventoryType": inv, "metrics": metrics_from(row, idx), "byMake": []}
            cur_lt["byInventory"].append(cur_inv)
        elif lt and inv and make and cur_inv is not None:
            cur_inv["byMake"].append({"make": make, "metrics": metrics_from(row, idx)})

    return reconcile_total(total, by_lead_type), by_lead_type


def parse_sales(rows, idx):
    """Per-user activity. Handles both the flat "User" report and the grouped
    "User Group" variant, where a group subtotal row carries a blank User and the
    grand total sits in the group column."""
    reps, totals = [], None

    def value(row, col):
        """None (not 0) when a column is absent — some stores' exports omit
        Texts Out entirely, and a real zero must not be invented for them."""
        return num(row[idx[col]]) if col in idx else None

    for row in rows:
        user = cell(row, idx, "User")
        group = cell(row, idx, "User Group")
        # grand total: "TOTAL" in whichever column leads this report
        is_total = user == "TOTAL" or (group == "TOTAL" and not user)
        if not is_total:
            if not user:
                continue  # group subtotal row — its members are listed individually
            if HOUSE_ACCOUNT.search(user):
                continue  # CRM house accounts are not people
        rec = {
            "name": "TOTAL" if is_total else user,
            "group": group or None,
            "goodLeads": value(row, "Good Leads"),
            "sold": value(row, "Sold in Time Frame"),
            "videos": value(row, "Videos"),   # only in hand-built sheets (entered from Covideo)
            "apptsScheduled": value(row, "Appts Scheduled"),
            "apptsShown": value(row, "Appts Shown"),
            "shownPct": value(row, "Appts Shown %"),
            "calls": value(row, "Calls Out"),
            "emails": value(row, "Emails Out"),
            "texts": value(row, "Texts Out"),
        }
        if is_total:
            totals = rec
        else:
            reps.append(rec)
    return reps, totals


def parse_workbook(path):
    """-> snapshot dict, or raises with a reason."""
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        if "Report" not in wb.sheetnames:
            raise ValueError("no Report sheet")
        filters = read_filters(wb)
        dealer_field = filters.get("Dealers", "").strip()
        if not dealer_field:
            raise ValueError("Filters has no Dealers value")
        dealer = combined_name(dealer_field)
        level = filters.get("Summary Level 1", "").strip()
        if not level:
            raise ValueError("Filters has no Summary Level 1")

        begin = parse_dt(filters.get("Date Range Begin"))
        end = parse_dt(filters.get("Date Range End"))
        run = parse_dt(filters.get("Run Date"))
        if not run:
            raise ValueError("Filters has no usable Run Date")

        date_range = filters.get("Date Range", "").strip()
        if date_range == "Previous Month MTD":
            period = "prior"
        elif date_range == "Current Month":
            period = "current"
        else:
            # Custom Date Range: current if it lands in the run date's own month.
            period = "current" if (begin or "")[:7] == (run or "")[:7] else "prior"

        rows, idx = read_report(wb)
        # "User Group" is the same per-rep report with an extra grouping column
        # (Sommer's reports its teams that way); both are salesperson activity.
        snap = {
            "storeId": slug(dealer),
            "storeName": dealer,
            "dealers": [d.strip() for d in dealer_field.split(",") if d.strip()],
            "kind": "sales" if level in ("User", "User Group") else "kpi",
            "period": period,
            "dateRange": date_range,
            "begin": begin,
            "end": end,
            "runDate": run,
            "source": os.path.basename(path),
            "rowCount": len(rows),
        }
        if snap["kind"] == "sales":
            reps, totals = parse_sales(rows, idx)
            if not reps and totals is None:
                raise ValueError("sales report had no usable user rows")
            snap["reps"] = reps
            snap["repTotals"] = totals
            snap["total"] = None
            snap["byLeadType"] = []
        else:
            total, by_lt = parse_kpi(rows, idx)
            if total is None and not by_lt:
                raise ValueError("KPI report had no usable rows")
            if total is None:
                # No TOTAL row: sum the lead-type subtotals rather than silently
                # shipping a snapshot with a missing store total.
                total = {k: 0 for k in ("goodLeads", "sold", "apptsShown", "contacted", "apptsSet")}
                for b in by_lt:
                    for k in list(total):
                        total[k] += (b["metrics"] or {}).get(k, 0)
                total["contactPct"] = (total["contacted"] / total["goodLeads"]) if total["goodLeads"] else 0
                total["apptSetOfContactedPct"] = (total["apptsSet"] / total["contacted"]) if total["contacted"] else 0
                total["apptSetPct"] = None
                snap["totalDerived"] = True
            snap["total"] = total
            snap["byLeadType"] = by_lt
            snap["reps"] = None
            snap["repTotals"] = None
        return snap
    finally:
        wb.close()


def parse_goals(path, log):
    """'Sales Goals <Store>.csv' (User, Team, Sales Goal) — the per-rep monthly
    goals and team rosters Scott keeps in his Sales Activity workbook."""
    store = slug(re.sub(r"(?i)^sales\s+goals\s+", "", os.path.basename(path)[:-4]).strip())
    out = []
    try:
        with open(path, newline="", encoding="utf-8-sig") as fh:
            for r in csv.DictReader(fh):
                name = (r.get("User") or "").strip()
                if not name:
                    continue
                goal = (r.get("Sales Goal") or "").strip()
                out.append({
                    "storeId": store,
                    "name": name,
                    "team": (r.get("Team") or "").strip() or None,
                    "salesGoal": float(goal) if goal else None,
                })
    except Exception as exc:  # noqa: BLE001
        log.append("SKIP goals %s: %s" % (os.path.basename(path), exc))
    return out


# The Sioux City rooftops are one store in the CRM exports ("Vern Eide Sioux City
# (combined)"), so their Matador activity rolls up to that combined store.
MATADOR_STORE_OVERRIDES = {
    "vern-eide-honda-sioux-city": "vern-eide-sioux-city-combined",
    "vern-eide-hyundai-sioux-city": "vern-eide-sioux-city-combined",
}

# A Matador organization maps to one dashboard store and its locations roll up to
# it (a sales floor and its service drive are the same dealership, and the CRM
# reports them as one) — the location is kept on every row so the dashboard can
# still show which one the activity came from. These locations are the exception:
# they are separate dealerships that merely share an organization, so they keep
# their own identity instead of inflating the parent store.
MATADOR_SEPARATE_LOCATIONS = {"sommer-s-buick-gmc", "sommer-s-subaru"}


# The bot rewrites every org's CSV on each run, so a file that has not been
# touched for this long belongs to an org/location pair the bot no longer
# produces (early runs mislabelled some downloads with another org's name).
MATADOR_MAX_AGE_DAYS = 3


def select_matador_files(paths, log):
    """Drop stale Matador CSVs and, within an organization, byte-identical
    location copies. Matador's "Download Users CSV" is organization-wide, so
    every location of an org yields the same file; summing those copies would
    double every rep's texts and videos."""
    import hashlib
    from datetime import timedelta
    cutoff = datetime.now() - timedelta(days=MATADOR_MAX_AGE_DAYS)
    fresh = []
    for path in sorted(paths):
        if datetime.fromtimestamp(os.path.getmtime(path)) < cutoff:
            log.append("SKIP matador %s: not refreshed in %d days" % (os.path.basename(path), MATADOR_MAX_AGE_DAYS))
            continue
        fresh.append(path)
    def parts(path):
        stem = re.sub(r"(?i)^matador\s+mtd\s+stats\s+", "", os.path.basename(path)[:-4]).strip()
        org, _, loc = stem.partition(" -- ")
        return org.strip(), (loc.strip() or org.strip())

    # the copy named after the org itself wins over its "- Service" twins
    fresh.sort(key=lambda p: (slug(parts(p)[0]), 0 if parts(p)[1] == parts(p)[0] else 1, p))
    keep, seen = [], {}
    for path in fresh:
        org = parts(path)[0]
        with open(path, "rb") as fh:
            digest = hashlib.md5(fh.read()).hexdigest()
        key = (slug(org), digest)
        if key in seen:
            log.append("SKIP matador %s: identical to %s" % (os.path.basename(path), os.path.basename(seen[key])))
            continue
        seen[key] = path
        keep.append(path)
    return keep


def parse_matador(path, log):
    out = []
    # "Matador MTD Stats <organization> -- <location>.csv"; older exports carry
    # only one name, in which case it is both.
    stem = re.sub(r"(?i)^matador\s+mtd\s+stats\s+", "", os.path.basename(path)[:-4]).strip()
    org, _, location = stem.partition(" -- ")
    location = location.strip() or org
    if slug(location) in MATADOR_SEPARATE_LOCATIONS:
        store = slug(location)
    else:
        store = MATADOR_STORE_OVERRIDES.get(slug(org), slug(org))
    try:
        with open(path, newline="", encoding="utf-8-sig") as fh:
            for r in csv.DictReader(fh):
                out.append({
                    "storeId": store,
                    "location": location,
                    "name": (r.get("User") or "").strip(),
                    "role": (r.get("User Role") or "").strip(),
                    "lastActivity": (r.get("Last Activity") or "").strip()[:10],
                    "apptsCreated": int(r.get("Appointments Created") or 0),
                    "videosSent": int(r.get("Videos Sent") or 0),
                    "messagesSent": int(r.get("Sent Messages") or 0),
                    "reviewInvites": int(r.get("Review Invites Sent") or 0),
                    "clientsMessaged": int(r.get("Clients Messaged") or 0),
                    "assignedClients": int(r.get("Assigned Clients") or 0),
                })
    except Exception as exc:  # noqa: BLE001
        log.append("SKIP matador %s: %s" % (os.path.basename(path), exc))
    return out


# --------------------------------------------------------------------------- #
# DriveCentric "KPI Comparison Report" PDFs (Bay Ridge, El Cajon, Garavel x2)
# --------------------------------------------------------------------------- #

# One page per store per day: sections per lead source (store total first, then
# Showroom / Phone / Internet / Campaign / Service / Chat), each with rows
# This Month / Previous MTD / Last Month and 11 columns:
#   Net Leads, Engagement %, Appt Due, App Created, Appts Created %,
#   Appt Show, Appt Show %, Appt Sold, Appt Sold %, Total Delivered, Closing %
# PyMuPDF's text stream lists all data blocks first, then the section labels;
# each label is the line right before a "Net Leads" header, and the first label
# is the store name (its block is the store total — verified: total Net Leads
# equals the sum of the sections, which parse_dc_pdf asserts per file).

DC_ROW_LABELS = ("This Month", "Previous MTD", "Last Month")
# Showroom is DriveCentric's walk-in traffic; mapping it keeps the dashboard's
# fixed Internet/Phone/Walk-in rows meaningful. The other sources (Campaign,
# Service, Chat) stay out of the visible rows but inside the store total, the
# same treatment Referral/PreviousCustomer get on VinSolutions stores.
DC_LEAD_TYPES = {"Showroom": "Walk-in", "Phone": "Phone", "Internet": "Internet",
                 "Campaign": "Campaign", "Service": "Service", "Chat": "Chat"}


def dc_value(s):
    s = s.strip()
    if s == "-" or s == "":
        return None
    if s.endswith("%"):
        try:
            return float(s[:-1].replace(",", "")) / 100.0
        except ValueError:
            return None
    try:
        return float(s.replace(",", ""))
    except ValueError:
        return None


# Column order is NOT stable across DriveCentric's template versions (August
# 2026 files list Engagement % last, September files list it second), so each
# file's header run is tokenised into these names, longest match first.
DC_COLUMNS = ["netleads", "engagement%", "apptdue", "appcreated", "apptscreated%",
              "apptshow", "apptshow%", "apptsold", "apptsold%", "totaldelivered", "deliveredclosing%"]
# Oct 2026: some stores' templates add New Leads / Used Leads next to Net Leads.
DC_OPTIONAL = ["newleads", "usedleads"]


def dc_columns(header_lines):
    blob = re.sub(r"[^a-z%]", "", "".join(header_lines).lower())
    cols, pos = [], 0
    by_len = sorted(DC_COLUMNS + DC_OPTIONAL, key=len, reverse=True)
    while pos < len(blob):
        for name in by_len:
            if blob.startswith(name, pos):
                cols.append(name)
                pos += len(name)
                break
        else:
            raise ValueError("unrecognised PDF column header near %r" % blob[pos:pos + 20])
    if sorted(c for c in cols if c in DC_COLUMNS) != sorted(DC_COLUMNS) or len(cols) != len(set(cols)):
        raise ValueError("PDF columns %s do not match the known set" % cols)
    return cols


def dc_inventory(vals, cols):
    """New / Used lead counts when the template carries them (lead counts only;
    the other columns are not broken down by inventory in this report)."""
    v = dict(zip(cols, vals))
    out = []
    for key, label in (("newleads", "New"), ("usedleads", "Used")):
        if key in v and v[key] is not None:
            out.append({"inventoryType": label, "key": label.lower(),
                        "metrics": {"goodLeads": int(v[key]), "sold": None, "apptsShown": None, "contactPct": None,
                                    "apptSetOfContactedPct": None, "apptSetPct": None, "contacted": None, "apptsSet": None},
                        "byMake": []})
    return out


def dc_metrics(vals, cols):
    """One DriveCentric row -> the same metrics bag VinSolutions rows produce."""
    v = dict(zip(cols, vals))
    good = int(v.get("netleads") or 0)
    engagement = v.get("engagement%")
    if engagement is not None and engagement > 1.5:
        raise ValueError("engagement %r is not a percentage — column order misread" % engagement)
    appts_set = int(v.get("appcreated") or 0)
    shown = int(v.get("apptshow") or 0)
    sold = v.get("totaldelivered") or 0
    contacted = int(round(engagement * good)) if engagement else 0
    return {
        "goodLeads": good,
        "sold": sold,
        "apptsShown": shown,
        "contactPct": engagement or 0,
        "apptSetOfContactedPct": (appts_set / contacted) if contacted else 0,
        "apptSetPct": None,
        "contacted": contacted,
        "apptsSet": appts_set,
    }


# DriveCentric "Activity Report - Users": one row per salesperson for a one-week
# window (Sat-Fri), 20 cells after each name in this order. Verified against the
# rendered header on 2026-09-26; the 20th column has no header and is always 0.
DC_USER_COLS = ["totalOpps", "showroom", "showroomSoldPct", "phone", "phoneSoldPct",
                "internet", "internetSoldPct", "internetSold", "campaign", "campaignSoldPct",
                "apptsScheduled", "apptsCreated", "apptsShow", "calls", "texts", "emails",
                "videos", "sold", "delivered", "_blank"]


def dc_cell(s):
    """'1,709' -> 1709, '37.3%' -> 0.373, '-' / '—' / text -> None."""
    s = (s or "").strip()
    if not s or s in ("-", "\u2014", "\u2013"):
        return None
    if s.endswith("%"):
        try:
            return float(s[:-1].replace(",", "")) / 100.0
        except ValueError:
            return None
    try:
        return float(s.replace(",", ""))
    except ValueError:
        return None


def parse_dc_users(lines, path, run):
    """'Activity Report - Users' -> ONE sales snapshot covering the report's week.
    Line 1 is the window, line 2 the store, then the store's own total row and
    one row per person; the column labels trail at the end of the text stream."""
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})\s*-\s*(\d{1,2})/(\d{1,2})/(\d{4})", lines[1])
    if not m:
        raise ValueError("users report without a date window: %r" % lines[1])
    begin = date(int(m.group(3)), int(m.group(1)), int(m.group(2)))
    end = date(int(m.group(6)), int(m.group(4)), int(m.group(5)))
    store_name = lines[2].strip()

    def to_int(v):
        return int(round(v)) if v is not None else None

    def rep_from(name, cells):
        v = dict(zip(DC_USER_COLS, cells))
        return {
            "name": name,
            "group": None,
            "goodLeads": to_int(v.get("totalOpps")),
            "sold": to_int(v.get("delivered")),          # same meaning as the KPI report's Total Delivered
            "apptsScheduled": to_int(v.get("apptsScheduled")),
            "apptsShown": to_int(v.get("apptsShow")),
            "shownPct": None,
            "calls": to_int(v.get("calls")),
            "emails": to_int(v.get("emails")),
            "texts": to_int(v.get("texts")),
            "videos": to_int(v.get("videos")),
        }

    reps, totals = [], None
    i = 2
    n = len(DC_USER_COLS)
    while i + n < len(lines):
        name = lines[i].strip()
        cells = [dc_cell(x) for x in lines[i + 1:i + 1 + n]]
        if all(c is None for c in cells):
            break                                   # reached the trailing column labels
        rec = rep_from("TOTAL" if name == store_name else name, cells)
        if name == store_name:
            totals = rec
        elif name and not HOUSE_ACCOUNT.search(name):
            reps.append(rec)
        i += 1 + n
    if not reps:
        raise ValueError("users report had no salesperson rows")
    return [{
        "storeId": slug(store_name),
        "storeName": store_name,
        "dealers": [store_name],
        "kind": "sales",
        "period": "current",
        "dateRange": "Custom Date Range",
        "begin": begin.isoformat(),
        "end": end.isoformat(),
        "runDate": run.isoformat(),
        "source": os.path.basename(path),
        "crm": "DriveCentric",
        # A Sat-Fri week is a disjoint block (window); a block that starts on the
        # 1st and runs longer than a week is a cumulative month-to-date snapshot.
        "window": begin.day != 1 or (end - begin).days == 6,
        "rowCount": len(reps) + 1,
        "reps": reps,
        "repTotals": totals,
        "total": None,
        "byLeadType": [],
    }]


# DriveCentric "Salesman Activity Report MTD" (scheduled since 2026-11-05 for Bay
# Ridge x2 and Garavel CJDR): one cumulative month-to-date row per salesperson,
# 8 cells after each name: Calls, Emails, Texts, Video Sent, Appts Created,
# Appts Show, Delivered, Total Good Leads. Layout: title, date range (or "-"),
# store name, the 8 store totals, then name + 8 cells per rep, then the labels.
DC_MTD_TITLE = "Salesman Activity Report MTD"
DC_MTD_COLS = ["calls", "emails", "texts", "videos", "apptsScheduled", "apptsShown", "sold", "goodLeads"]
DC_MTD_LABELS = {"Calls", "Emails", "Texts", "Video", "Sent", "Appts", "Created", "Show", "Delivered", "Total", "Good", "Leads"}


def parse_dc_salesman_mtd(lines, path, run):
    """'Salesman Activity Report MTD' -> [sales snapshot] for the month to date."""
    body = [ln for ln in lines[1:] if ln not in DC_MTD_LABELS and not ln.startswith("Page ")]
    rng = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4}) - (\d{1,2})/(\d{1,2})/(\d{4})$", body[0] if body else "")
    if rng or body[0] == "-":
        body = body[1:]
    if rng:
        begin = date(int(rng.group(3)), int(rng.group(1)), int(rng.group(2)))
    else:
        begin = run.replace(day=1)
    store_name = body[0] if body else ""
    if not store_name or re.fullmatch(r"[-\d.,%]+", store_name):
        raise ValueError("MTD report: store name not found")
    n = len(DC_MTD_COLS)

    def rec(name, cells):
        v = {}
        for key, c in zip(DC_MTD_COLS, cells):
            x = dc_cell(c)
            v[key] = int(round(x)) if x is not None else None
        return {"name": name, "group": None, "goodLeads": v["goodLeads"], "sold": v["sold"],
                "apptsScheduled": v["apptsScheduled"], "apptsShown": v["apptsShown"], "shownPct": None,
                "calls": v["calls"], "emails": v["emails"], "texts": v["texts"], "videos": v["videos"]}

    totals = rec("TOTAL", body[1:1 + n])
    reps = []
    i = 1 + n
    while i + n < len(body) + 1 and i < len(body):
        name = body[i]
        cells = body[i + 1:i + 1 + n]
        if len(cells) < n or any(dc_cell(c) is None for c in cells):
            break
        if not HOUSE_ACCOUNT.search(name):
            reps.append(rec(name, cells))
        i += 1 + n
    if not reps:
        raise ValueError("MTD report had no usable rows")
    return [{
        "storeId": slug(store_name), "storeName": store_name, "dealers": [store_name],
        "kind": "sales", "period": "current" if begin.month == run.month and begin.year == run.year else "prior",
        "dateRange": "Month to Date",
        "begin": begin.isoformat(), "end": run.isoformat(), "runDate": run.isoformat(),
        "source": os.path.basename(path), "crm": "DriveCentric",
        "window": False, "rowCount": len(reps) + 1,
        "reps": reps, "repTotals": totals, "total": None, "byLeadType": [],
    }]


def parse_dc_pdf(path):
    """-> snapshots for one DriveCentric PDF: [current, prior] for a KPI
    Comparison Report, or [sales] for an Activity Report - Users."""
    import fitz  # PyMuPDF

    doc = fitz.open(path)
    try:
        # a store with many sections spills onto a second page (the last rows
        # and a repeated section header), so read every page in order
        lines = []
        for page in doc:
            lines.extend(ln.strip() for ln in page.get_text().splitlines() if ln.strip())
    finally:
        doc.close()

    m = re.search(r"-(\d{1,2})-(\d{1,2})-(\d{4})\.pdf$", os.path.basename(path))
    if not m:
        raise ValueError("no run date in PDF filename")
    run = date(int(m.group(3)), int(m.group(1)), int(m.group(2)))

    if lines and lines[0].startswith("Activity Report - Users"):
        return parse_dc_users(lines, path, run)
    if lines and lines[0].startswith(DC_MTD_TITLE):
        return parse_dc_salesman_mtd(lines, path, run)

    # section labels: the line right before each "Net Leads" header, and this
    # file's column order from the first section's header run
    heads = [j for j in range(1, len(lines)) if lines[j] == "Net Leads"]
    labels = []
    for j in heads:                      # a page break repeats the section header
        if lines[j - 1] not in labels:
            labels.append(lines[j - 1])
    if not labels:
        raise ValueError("unrecognised PDF layout (no section headers)")
    cols = dc_columns(lines[heads[0]:(heads[1] - 1 if len(heads) > 1 else len(lines))])
    ncol = len(cols)

    # data rows: every run of numeric lines before the header block, cut into
    # rows of ncol values. Rows arrive in order (This Month, Previous MTD, Last
    # Month per section) and a row label can go missing at a page break, so the
    # labels are assigned by position rather than read from the text.
    numeric = re.compile(r"^[-\d.,%]+$|^[\u2014\u2013-]$")

    def read_blocks(greedy):
        """Each row label is followed by its ncol values. With greedy=True a
        label may also own the next row when its own label was lost at a page
        break (the values then run on without a label in between)."""
        out, i, limit = [], 0, len(lines)   # row labels never occur inside the header text
        while i < limit:
            if lines[i] in DC_ROW_LABELS:
                vals = [dc_value(v) for v in lines[i + 1:i + 1 + ncol]]
                out.append((lines[i], vals))
                i += 1 + ncol
                if greedy:
                    start = DC_ROW_LABELS.index(out[-1][0])
                    k = 1
                    while i + ncol <= limit and all(numeric.match(x) for x in lines[i:i + ncol]) \
                            and (i + ncol >= limit or not numeric.match(lines[i + ncol])):
                        out.append((DC_ROW_LABELS[(start + k) % 3], [dc_value(v) for v in lines[i:i + ncol]]))
                        i += ncol
                        k += 1
            else:
                i += 1
        return out

    blocks = read_blocks(False)
    if len(blocks) != 3 * len(labels):
        blocks = read_blocks(True)
    if len(blocks) != 3 * len(labels):
        raise ValueError("unrecognised PDF layout (%d blocks, %d labels)" % (len(blocks), len(labels)))

    store_name = labels[0]
    per_section = {}          # label -> {rowLabel: vals}
    for bi, (row_label, vals) in enumerate(blocks):
        per_section.setdefault(labels[bi // 3], {})[row_label] = vals

    def build(row_label, period, begin, end, date_range=None):
        by_lt = []
        for sec, rows in per_section.items():
            if sec == store_name:
                continue
            lt = DC_LEAD_TYPES.get(sec, sec)
            by_lt.append({"leadType": lt, "metrics": dc_metrics(rows[row_label], cols),
                          "byInventory": dc_inventory(rows[row_label], cols)})
        total = dc_metrics(per_section[store_name][row_label], cols)
        check = sum((n["metrics"]["goodLeads"] for n in by_lt))
        if check != total["goodLeads"]:
            raise ValueError("section leads %d != total %d (%s)" % (check, total["goodLeads"], row_label))
        return {
            "storeId": slug(store_name),
            "storeName": store_name,
            "dealers": [store_name],
            "kind": "kpi",
            "period": period,
            "dateRange": date_range or ("Current Month" if period == "current" else "Previous Month MTD"),
            "begin": begin.isoformat(),
            "end": end.isoformat(),
            "runDate": run.isoformat(),
            "source": os.path.basename(path),
            "crm": "DriveCentric",
            "rowCount": len(by_lt) + 1,
            "total": reconcile_total(total, by_lt),
            "byLeadType": by_lt,
            "reps": None,
            "repTotals": None,
        }

    prev_last = date(run.year, run.month, 1) - timedelta(days=1)
    prior_end = date(prev_last.year, prev_last.month, min(run.day, prev_last.day))
    out = [
        build("This Month", "current", date(run.year, run.month, 1), run),
        build("Previous MTD", "prior", date(prev_last.year, prev_last.month, 1), prior_end),
    ]
    # "Last Month" is the whole previous month as DriveCentric sees it today.
    # Deliveries get posted days after the sale, so the report run on the last
    # morning of a month undercounts it (Bay Ridge Oct 2026: 284 on the Oct 31
    # run, 313 by Nov 4). This row, dated the month's last day, supersedes the
    # last-morning snapshot in the dashboard and keeps the closed month honest.
    if prior_end != prev_last:
        out.append(build("Last Month", "prior", date(prev_last.year, prev_last.month, 1), prev_last, "Last Month"))
    return out


# Covideo's own "Vern Eide Honda Sioux City" is one of the two dealers the KPI
# reports combine into a single store, so its activity lands on the combined id.
COVIDEO_STORE_OVERRIDES = {"vern-eide-honda-sioux-city": "vern-eide-sioux-city-combined"}


# --------------------------------------------------------------------------- #
# Momentum (Vinart Group): "Salesperson Stats MTD" CSV, scheduled daily per store
# --------------------------------------------------------------------------- #

# Every Momentum store schedules the same report from its own sender domain, so
# pull.py tags the file with that domain; the file itself never names the store.
MOMENTUM_STORES = {
    "vinartcars.com": "Lehigh Valley Honda",
    "lvhyundai.vinartautos.com": "Lehigh Valley Hyundai",
    "acura.vinartautos.com": "Lehigh Valley Acura",
    "drive.mbporschelehighvalley.com": "MB Porsche of Lehigh Valley",
}
MOMENTUM_NAME = re.compile(r"^[0-9a-f]{15,16}-\[(?P<dom>[a-z0-9.-]+)\] (?P<name>.*)_(?P<ms>\d{13})\.csv$", re.IGNORECASE)
MOMENTUM_COLS = {"Name", "Prospects", "Internet Prospects", "Internet Sales", "Total Sales",
                 "Outbound Calls", "Outbound Emails", "Outbound Texts", "Outbound Videos",
                 "Appts Created", "Show Appts"}


def momentum_identity(path):
    """-> (store_name, is_combined, run_date) from the tagged file name, or raises."""
    m = MOMENTUM_NAME.match(os.path.basename(path))
    if not m:
        raise ValueError("Momentum: file is not tagged with its sender domain (re-pull with the current pull.py)")
    store = MOMENTUM_STORES.get(m.group("dom").lower())
    if not store:
        raise ValueError("Momentum: unknown sender domain %s" % m.group("dom"))
    # the epoch is the local run time; UTC-4/5 keeps the calendar day for US East
    run = datetime.fromtimestamp(int(m.group("ms")) / 1000, timezone(timedelta(hours=-5))).date()
    return store, "combined" in m.group("name").lower(), run


def parse_momentum(path):
    """-> [kpi snapshot, sales snapshot] for one Momentum salesperson-stats CSV.
    The report is cumulative month-to-date and run daily; the run date is the
    epoch-ms suffix Momentum puts in the file name."""
    store, combined, run = momentum_identity(path)
    if combined:
        raise ValueError("Momentum: combined report covers several stores, use the per-store schedule")
    with open(path, newline="", encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh))
    cols = set(rows[0].keys()) if rows else set()
    if not MOMENTUM_COLS <= cols:
        raise ValueError("Momentum: unexpected columns %s" % sorted(cols - MOMENTUM_COLS)[:5])

    def n(row, key):
        v = (row.get(key) or "").strip().replace(",", "").replace("%", "")
        try:
            return int(float(v)) if v else 0
        except ValueError:
            return 0

    def rep_from(row):
        return {
            "name": (row.get("Name") or "").strip(),
            "group": (row.get("Team") or "").strip() or None,
            "goodLeads": n(row, "Internet Prospects"),
            "sold": n(row, "Total Sales"),
            "apptsScheduled": n(row, "Appts Created"),
            "apptsShown": n(row, "Show Appts"),
            "shownPct": None,
            "calls": n(row, "Outbound Calls"),
            "emails": n(row, "Outbound Emails"),
            "texts": n(row, "Outbound Texts"),
            "videos": n(row, "Outbound Videos"),
        }

    reps, totals = [], None
    for row in rows:
        name = (row.get("Name") or "").strip()
        if not name:
            continue
        if name.lower().startswith("total"):
            totals = rep_from(row)
            totals["name"] = "TOTAL"
        elif not HOUSE_ACCOUNT.search(name):
            reps.append(rep_from(row))
    if not reps:
        raise ValueError("Momentum report had no usable rows")
    if totals is None:
        totals = rep_from({})
        totals["name"] = "TOTAL"
        for k in ("goodLeads", "sold", "apptsScheduled", "apptsShown", "calls", "emails", "texts", "videos"):
            totals[k] = sum(r[k] or 0 for r in reps)

    begin = run.replace(day=1)
    common = {
        "storeId": slug(store), "storeName": store, "dealers": [store],
        "period": "current", "dateRange": "Month to Date",
        "begin": begin.isoformat(), "end": run.isoformat(), "runDate": run.isoformat(),
        "source": os.path.basename(path), "crm": "Momentum",
    }
    kpi = dict(common, kind="kpi", rowCount=1, byLeadType=[], total={
        "goodLeads": totals["goodLeads"], "sold": totals["sold"],
        "apptsShown": totals["apptsShown"], "apptsSet": totals["apptsScheduled"],
        "contacted": 0, "contactPct": 0, "apptSetOfContactedPct": 0, "apptSetPct": None,
    })
    sales = dict(common, kind="sales", window=False, rowCount=len(reps) + 1,
                 reps=reps, repTotals=totals, total=None, byLeadType=[])
    return [kpi, sales]


def parse_momentum_files(paths):
    """-> [(path, snapshots | reason)]. Guard: when several store senders deliver a
    byte-identical file on the same day, the schedules all point at one saved
    report and the file says nothing about any single store, so nothing is loaded."""
    import hashlib
    by_day = defaultdict(lambda: defaultdict(set))   # run date -> md5 -> {store}
    ident = {}
    for path in paths:
        try:
            store, combined, run = momentum_identity(path)
        except ValueError:
            continue
        if combined:
            continue
        with open(path, "rb") as fh:
            digest = hashlib.md5(fh.read()).hexdigest()
        ident[path] = (run, digest)
        by_day[run][digest].add(store)
    out = []
    for path in sorted(paths):
        run_digest = ident.get(path)
        if run_digest and len(by_day[run_digest[0]][run_digest[1]]) > 1:
            out.append((path, "Momentum: identical report sent by %d stores, schedules point at the same saved report"
                        % len(by_day[run_digest[0]][run_digest[1]])))
            continue
        try:
            out.append((path, parse_momentum(path)))
        except Exception as exc:  # noqa: BLE001
            out.append((path, str(exc)))
    return out


# --------------------------------------------------------------------------- #
# Reynolds Focus (Herson's Honda / Kia): no export, no scheduled email. The Focus
# bot in the private crm-bots repo opens each shared report, sets the date range
# (and the Stock Type for the KPI report), and reads the grid off the screen into
#   "Focus <store> <report>[ <stock>] <begin> <end>.csv"
# with a '#'-prefixed metadata block on top (store, report, stockType, begin, end,
# range, dateRangeOnScreen, extractedAt). Four reports per store and range:
#   kpi (x3 stock passes new/used/all), activity, sold, calls.
# --------------------------------------------------------------------------- #

FOCUS_NAME = re.compile(
    r"^Focus (?P<store>.+?) (?P<report>kpi|activity|sold|calls)(?: (?P<stock>new|used|all))?"
    r" (?P<begin>\d{4}-\d{2}-\d{2}) (?P<end>\d{4}-\d{2}-\d{2})\.csv$", re.IGNORECASE)
FOCUS_KPI_COLS = {"Prospect Type", "Prospects Entered", "Duplicate Leads", "Prospects Sold",
                  "Appts Scheduled", "Appt Kept"}
FOCUS_ACTIVITY_COLS = {"Completed By", "Phone Calls / Complete", "Emails / Complete",
                       "Text Messages / Complete", "Text Messages / Videos Sent",
                       "Appointments / Scheduled", "Appointments / Complete"}
FOCUS_SOLD_COLS = {"Salesperson", "Prospects", "Total # Units Sold"}
FOCUS_CALLS_COLS = {"User", "Completed", "Confirmed by Telephony"}
FOCUS_STOCK_LABEL = {"new": "New", "used": "Used"}      # "used" pass = Certified + Used


def read_focus_csv(path):
    """-> (meta, headers, rows). Mirrors crm-bots/focus/grid.py:read_csv."""
    meta, headers, rows = {}, None, []
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for row in csv.reader(fh):
            if not row:
                continue
            if row[0].startswith("# "):
                meta[row[0][2:]] = row[1] if len(row) > 1 else ""
            elif headers is None:
                headers = row
            else:
                rows.append(row)
    return meta, headers or [], rows


def focus_num(value):
    v = (value or "").strip().replace(",", "").replace("%", "")
    if not v or ":" in v:            # blank cells are zeros; durations are not counts
        return 0
    try:
        return int(float(v))
    except ValueError:
        return 0


def focus_person(name):
    """Focus writes "Last, First"; the dashboard joins reps across tools by
    "First Last"."""
    name = (name or "").strip()
    if "," in name:
        last, first = name.split(",", 1)
        return ("%s %s" % (first.strip(), last.strip())).strip()
    return name


def focus_table(path, required):
    """-> (meta, [dict per row], total dict or None). The last row is Focus's
    Total footer when its first cell says so."""
    meta, headers, rows = read_focus_csv(path)
    missing = required - set(headers)
    if missing:
        raise ValueError("Focus %s: missing columns %s" % (os.path.basename(path), sorted(missing)))
    recs = [dict(zip(headers, r)) for r in rows]
    total = None
    if recs and (recs[-1].get(headers[0]) or "").strip().lower() == "total":
        total = recs.pop()
    return meta, recs, total


def focus_kpi_metrics(rec):
    """Scott: leads are Prospects Entered minus the duplicates. Focus has no
    contact rate, so engagement stays empty (contactScope none)."""
    good = focus_num(rec.get("Prospects Entered")) - focus_num(rec.get("Duplicate Leads"))
    return {
        "goodLeads": max(good, 0),
        "sold": focus_num(rec.get("Prospects Sold")),
        "apptsShown": focus_num(rec.get("Appt Kept")),
        "contactPct": 0, "apptSetOfContactedPct": 0, "apptSetPct": None,
        "contacted": 0,
        "apptsSet": focus_num(rec.get("Appts Scheduled")),
    }


def parse_focus_group(store, begin, end, run, files):
    """files: {(report, stock): path} for one store x range x run date
    -> [kpi snapshot?, sales snapshot?]. Raises when nothing usable is there."""
    period = "current" if begin[:7] == run[:7] else "prior"
    rng = "Month to Date" if period == "current" else "Previous Month"
    common = {
        "storeId": slug(store), "storeName": store, "dealers": [store],
        "period": period, "dateRange": rng,
        "begin": begin, "end": end, "runDate": run, "crm": "Reynolds Focus",
    }
    out = []

    # ---- KPI: the "all" pass is the store; new/used passes hang under each lead type
    if ("kpi", "all") in files:
        _, recs, total = focus_table(files[("kpi", "all")], FOCUS_KPI_COLS)
        passes = {}
        for stock, label in FOCUS_STOCK_LABEL.items():
            if ("kpi", stock) in files:
                _, prow, _ptot = focus_table(files[("kpi", stock)], FOCUS_KPI_COLS)
                passes[label] = {(r.get("Prospect Type") or "").strip(): r for r in prow}
        by_lead_type = []
        for rec in recs:
            lt = (rec.get("Prospect Type") or "").strip()
            if not lt:
                continue
            node = {"leadType": lt, "metrics": focus_kpi_metrics(rec), "byInventory": []}
            for label, rows_by_lt in passes.items():
                if lt in rows_by_lt:
                    node["byInventory"].append({"inventoryType": label,
                                                "metrics": focus_kpi_metrics(rows_by_lt[lt]), "byMake": []})
            by_lead_type.append(node)
        if not by_lead_type:
            raise ValueError("Focus KPI report had no lead-type rows")
        tot = focus_kpi_metrics(total) if total else None
        if tot is None:
            tot = focus_kpi_metrics({})
            for k in ("goodLeads", "sold", "apptsShown", "apptsSet"):
                tot[k] = sum(n["metrics"][k] for n in by_lead_type)
        tot["contactScope"] = "none"
        out.append(dict(common, kind="kpi", rowCount=len(by_lead_type), byLeadType=by_lead_type, total=tot,
                        source=os.path.basename(files[("kpi", "all")])))

    # ---- salesperson: activity (calls/emails/texts/videos/appts) + sold + telephony calls
    if ("activity", None) in files:
        _, arows, _atot = focus_table(files[("activity", None)], FOCUS_ACTIVITY_COLS)
        sold_by, calls_by = {}, {}
        if ("sold", None) in files:
            _, srows, _ = focus_table(files[("sold", None)], FOCUS_SOLD_COLS)
            sold_by = {focus_person(r.get("Salesperson")): r for r in srows}
        if ("calls", None) in files:
            _, crows, _ = focus_table(files[("calls", None)], FOCUS_CALLS_COLS)
            calls_by = {focus_person(r.get("User")): r for r in crows}

        def rep_from(a, name):
            s, c = sold_by.get(name, {}), calls_by.get(name, {})
            return {
                "name": name, "group": None,
                "goodLeads": focus_num(s.get("Prospects")),        # all lead types: Focus has no per-rep internet split
                "sold": focus_num(s.get("Total # Units Sold")),
                "apptsScheduled": focus_num(a.get("Appointments / Scheduled")),
                "apptsShown": focus_num(a.get("Appointments / Complete")),
                "shownPct": None,
                # Scott: the phone number is what the telephony system confirmed
                "calls": focus_num(c.get("Confirmed by Telephony")) if c else focus_num(a.get("Phone Calls / Complete")),
                "callsLogged": focus_num(a.get("Phone Calls / Complete")),
                "emails": focus_num(a.get("Emails / Complete")),
                "texts": focus_num(a.get("Text Messages / Complete")),
                "videos": focus_num(a.get("Text Messages / Videos Sent")),
            }

        reps = []
        for a in arows:
            name = focus_person(a.get("Completed By"))
            if name and not HOUSE_ACCOUNT.search(name):
                reps.append(rep_from(a, name))
        if not reps:
            raise ValueError("Focus activity report had no usable rows")
        totals = {"name": "TOTAL", "group": None, "shownPct": None}
        for k in ("goodLeads", "sold", "apptsScheduled", "apptsShown", "calls", "callsLogged", "emails", "texts", "videos"):
            totals[k] = sum(r[k] or 0 for r in reps)
        out.append(dict(common, kind="sales", window=False, rowCount=len(reps) + 1,
                        reps=reps, repTotals=totals, total=None, byLeadType=[],
                        source=os.path.basename(files[("activity", None)])))

    if not out:
        raise ValueError("Focus: neither the KPI (all stock types) nor the activity report is present")
    return out


def parse_focus_files(paths):
    """-> [(path, snapshots | reason)], one entry per store x range x run date
    (keyed on the KPI-all file, else the activity file). The run date is the
    extraction time stamped by the bot, falling back to the file's mtime."""
    groups = defaultdict(dict)
    for path in sorted(paths):
        m = FOCUS_NAME.match(os.path.basename(path))
        if not m:
            continue
        meta, _, _ = read_focus_csv(path)
        stamp = meta.get("extractedAt") or ""
        run = stamp[:10] if re.match(r"^\d{4}-\d{2}-\d{2}", stamp) else \
            datetime.fromtimestamp(os.path.getmtime(path)).strftime("%Y-%m-%d")
        store = meta.get("store") or m.group("store")
        key = (store, m.group("begin"), m.group("end"), run)
        groups[key][(m.group("report").lower(), (m.group("stock") or "").lower() or None)] = path
    out = []
    for (store, begin, end, run), files in sorted(groups.items()):
        lead = files.get(("kpi", "all")) or files.get(("activity", None)) or sorted(files.values())[0]
        try:
            out.append((lead, parse_focus_group(store, begin, end, run, files)))
        except Exception as exc:  # noqa: BLE001
            out.append((lead, str(exc)))
    return out


def gmail_order(path):
    # gmail-pull files are named <gmailMsgIdHex>-<name>; the id's high bits are
    # the message's internal timestamp, so the hex value orders by arrival.
    m = re.match(r"^([0-9a-f]{15,16})-", os.path.basename(path))
    if m:
        return int(m.group(1), 16)
    return int(os.path.getmtime(path) * 1000)


COVIDEO_SOURCE = {}     # storeId -> newest Covideo CSV that fed it (for the Data sources panel)


def parse_covideo(paths, log):
    """Daily Covideo MTD usage CSVs (per-user video activity, cumulative for the
    month). Reports repeat daily, so only the NEWEST rows per company are kept —
    a snapshot join, same idea as Matador."""
    per_company = {}
    n_files = 0
    for path in sorted(paths, key=gmail_order):
        try:
            with open(path, newline="", encoding="utf-8-sig") as fh:
                rdr = csv.DictReader(fh)
                cols = rdr.fieldnames or []
                if "Company Name" not in cols or "Videos Created" not in cols:
                    continue  # some other CSV, not Covideo's export
                rows = list(rdr)
        except Exception as exc:  # noqa: BLE001
            log.append("SKIP covideo %s: %s" % (os.path.basename(path), exc))
            continue
        n_files += 1
        by_co = {}
        for r in rows:
            co = (r.get("Company Name") or "").strip()
            # some exports repeat the header line mid-file; it is not a company
            if co and co.lower() != "company name":
                by_co.setdefault(co, []).append(r)
        for co in by_co:            # later (newer) files overwrite earlier ones
            per_company[co] = by_co[co]
            COVIDEO_SOURCE[COVIDEO_STORE_OVERRIDES.get(slug(co), slug(co))] = path

    def num(row, key):
        try:
            return int(row.get(key) or 0)
        except ValueError:
            return 0

    out = []
    for co, co_rows in per_company.items():
        sid = slug(co)
        sid = COVIDEO_STORE_OVERRIDES.get(sid, sid)
        for r in co_rows:
            name = (r.get("User Name") or "").strip()
            if not name:
                continue
            out.append({
                "storeId": sid,
                "name": name,
                "videosCreated": num(r, "Videos Created"),
                "videosSent": num(r, "Sent"),
                "views": num(r, "Total Views"),
                "ctaClicks": num(r, "CTA Clicks"),
            })
    if n_files:
        log.append("covideo: %d files, newest snapshot kept for %d companies" % (n_files, len(per_company)))
    return out


# --------------------------------------------------------------------------- #
# integrations — described, never invented; coverage is computed from the data
# --------------------------------------------------------------------------- #

INTEGRATIONS = [
    {"name": "VinSolutions", "type": "CRM", "api": "requested", "scheduledEmail": True,
     "note": "Enterprise Performance exports arrive daily by email from reportscheduler@motosnap.com. API access requested."},
    {"name": "Tekion", "type": "CRM", "api": "requested", "scheduledEmail": True,
     "note": "Has an API — access inquiry in progress. Reports can be scheduled by email."},
    {"name": "DriveCentric", "type": "CRM", "api": "unknown", "scheduledEmail": True,
     "note": "Daily KPI Comparison PDF arrives by scheduled email since Aug 2026 (Bay Ridge, El Cajon, Garavel x2)."},
    {"name": "Momentum", "type": "CRM", "api": "requested", "scheduledEmail": True,
     "note": "Has an API — asking about access. Reports can be scheduled."},
    {"name": "Reynolds Focus", "type": "CRM", "api": "none", "scheduledEmail": False,
     "note": "No export or scheduled email. The crm-bots Focus bot reads the shared reports off the screen nightly (Herson's Honda + Kia)."},
    {"name": "Matador", "type": "AI messaging", "api": "unknown", "scheduledEmail": False,
     "note": "Texts and videos sent. Activity is exported by hand from the Users tab; no scheduled email today."},
    {"name": "Covideo", "type": "Video outreach", "api": "unknown", "scheduledEmail": True,
     "note": "Daily MTD usage report arrives by scheduled email since Sep 2026 (Sommer's + Vern Eide)."},
]


def main(argv):
    src_dirs = [os.path.abspath(p) for p in argv[1:]] or [DEFAULT_SRC]
    log = []
    os.makedirs(CACHE, exist_ok=True)

    xlsx_paths, csv_paths, other_csv_paths, pdf_paths, goal_paths, momentum_paths, focus_paths = discover(src_dirs, log)
    print("sources: %s" % ", ".join(src_dirs))
    for line in log:
        print("  %s" % line)
    print("workbooks found: %d (+%d PDFs)" % (len(xlsx_paths), len(pdf_paths)))

    snapshots, skipped = [], []
    excluded = defaultdict(int)
    for path in sorted(xlsx_paths):
        try:
            snap = parse_workbook(path)
        except Exception as exc:  # noqa: BLE001 - one bad file must never abort
            skipped.append((os.path.basename(path), str(exc)))
            continue
        if snap["storeId"] in EXCLUDE_STORES:
            excluded[snap["storeName"]] += 1
            continue
        snapshots.append(snap)

    for path in sorted(pdf_paths):
        try:
            pdf_snaps = parse_dc_pdf(path)
        except Exception as exc:  # noqa: BLE001
            skipped.append((os.path.basename(path), str(exc)))
            continue
        for snap in pdf_snaps:
            if snap["storeId"] in EXCLUDE_STORES:
                excluded[snap["storeName"]] += 1
                continue
            snapshots.append(snap)

    for path, snaps_or_err in parse_momentum_files(momentum_paths):
        if isinstance(snaps_or_err, str):
            skipped.append((os.path.basename(path), snaps_or_err))
            continue
        for snap in snaps_or_err:
            if snap["storeId"] in EXCLUDE_STORES:
                excluded[snap["storeName"]] += 1
                continue
            snapshots.append(snap)

    for path, snaps_or_err in parse_focus_files(focus_paths):
        if isinstance(snaps_or_err, str):
            skipped.append((os.path.basename(path), snaps_or_err))
            continue
        for snap in snaps_or_err:
            if snap["storeId"] in EXCLUDE_STORES:
                excluded[snap["storeName"]] += 1
                continue
            snapshots.append(snap)

    # de-duplicate identical sends; keep the richer copy
    best = {}
    dupes = 0
    for snap in snapshots:
        key = (snap["storeId"], snap["kind"], snap["period"], snap["begin"], snap["end"], snap["runDate"])
        prev = best.get(key)
        if prev is None:
            best[key] = snap
        else:
            dupes += 1
            if snap["rowCount"] > prev["rowCount"]:
                best[key] = snap
    kept = sorted(best.values(), key=lambda s: (s["storeId"], s["kind"], s["period"], s["runDate"] or ""))

    matador = []
    matador_src = {}
    for path in select_matador_files(csv_paths, log):
        rows = parse_matador(path, log)
        for r in rows:
            matador_src[r["storeId"]] = path
        matador.extend(rows)
    # drop activity belonging to an excluded store rather than leaving it orphaned
    matador = [m for m in matador if m["storeId"] not in EXCLUDE_STORES]

    covideo = [c for c in parse_covideo(other_csv_paths, log) if c["storeId"] not in EXCLUDE_STORES]

    rep_goals = []
    for path in sorted(goal_paths):
        rep_goals.extend(parse_goals(path, log))
    rep_goals = [g for g in rep_goals if g["storeId"] not in EXCLUDE_STORES]

    # stores and coverage are derived from what actually parsed
    store_names, coverage = {}, defaultdict(lambda: {"runDates": set(), "months": set(), "kinds": set()})
    store_crm = {}
    for snap in kept:
        store_names[snap["storeId"]] = snap["storeName"]
        store_crm[snap["storeId"]] = snap.get("crm", "VinSolutions")
        cov = coverage[snap["storeId"]]
        cov["runDates"].add(snap["runDate"])
        if snap["kind"] == "kpi" and snap["period"] == "current":
            cov["currentRuns"] = cov.get("currentRuns", set()) | {snap["runDate"]}
        if snap["begin"]:
            cov["months"].add(snap["begin"][:7])
        cov["kinds"].add(snap["kind"])

    matador_stores = {m["storeId"] for m in matador}
    covideo_stores = {c["storeId"] for c in covideo}
    stores = []
    groups = {}
    for sid in sorted(store_names):
        gid, gname = group_for(store_names[sid])
        stores.append({
            "id": sid,
            "name": store_names[sid],
            "crm": store_crm.get(sid, "VinSolutions"),
            "tools": (["Matador"] if sid in matador_stores else []) +
                     (["Covideo"] if sid in covideo_stores else []),
            "location": None,
            "group": gid,
        })
        if gid:
            groups.setdefault(gid, {"id": gid, "name": gname, "storeIds": []})
            groups[gid]["storeIds"].append(sid)

    sources = build_sources(kept, xlsx_paths + pdf_paths + momentum_paths + focus_paths, matador_src, COVIDEO_SOURCE)

    data = {
        "generatedAt": datetime.now().strftime("%Y-%m-%d"),
        "sources": sources,
        "stores": stores,
        "groups": sorted(groups.values(), key=lambda g: g["name"]),
        "snapshots": kept,
        "matador": matador,
        "covideo": covideo,
        "repGoals": rep_goals,
        "integrations": INTEGRATIONS,
        "coverage": {
            sid: {
                "firstRun": min(c["runDates"]) if c["runDates"] else None,
                "lastRun": max(c["runDates"]) if c["runDates"] else None,
                # newest Current Month KPI report: what the store card actually shows.
                # A misconfigured schedule keeps sending "previous month" files daily,
                # so lastRun alone never goes stale (Lunde's, Oct 2026).
                "lastCurrent": max(c["currentRuns"]) if c.get("currentRuns") else None,
                "runDates": sorted(c["runDates"]),
                "months": sorted(c["months"]),
                "kinds": sorted(c["kinds"]),
            }
            for sid, c in coverage.items()
        },
        "ingest": {
            "workbooksFound": len(xlsx_paths),
            "parsed": len(snapshots),
            "unique": len(kept),
            "duplicatesDropped": dupes,
            "skipped": [{"file": f, "reason": r} for f, r in skipped],
        },
    }

    with open(OUT, "w") as fh:
        json.dump(data, fh, indent=1)

    print("parsed %d, unique %d (%d duplicate sends dropped), skipped %d"
          % (len(snapshots), len(kept), dupes, len(skipped)))
    for name, n in sorted(excluded.items()):
        print("  EXCLUDED %s: %d snapshots (listed in EXCLUDE_STORES)" % (name, n))
    for fname, reason in skipped:
        print("  SKIP %s: %s" % (fname, reason))
    print("\nstore coverage")
    for sid in sorted(coverage):
        c = data["coverage"][sid]
        per_kind = defaultdict(int)
        for snap in kept:
            if snap["storeId"] == sid:
                per_kind["%s/%s" % (snap["kind"], snap["period"])] += 1
        detail = ", ".join("%s=%d" % (k, v) for k, v in sorted(per_kind.items()))
        print("  %-20s %s -> %s  (%d run dates)  %s"
              % (store_names[sid], c["firstRun"], c["lastRun"], len(c["runDates"]), detail))
    if matador:
        print("matador rows: %d" % len(matador))
    if covideo:
        print("covideo rows: %d" % len(covideo))
    if rep_goals:
        print("rep goals: %d" % len(rep_goals))
    write_run_log(data, xlsx_paths, pdf_paths, csv_paths, other_csv_paths,
                  snapshots, kept, dupes, skipped, matador, covideo, src_dirs)
    print("\nwrote %s" % OUT)
    return 0


RUNS = os.path.join(HERE, "runs.jsonl")
RUNS_KEPT = 180        # ~3 months of twice-daily refreshes


def received_at(path):
    """When the file reached the inbox: the Gmail id encodes the message time;
    hand-copied files fall back to their modification time."""
    m = re.match(r"^([0-9a-f]{15,16})-", os.path.basename(path))
    ts = (int(m.group(1), 16) >> 20) / 1000.0 if m else os.path.getmtime(path)
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


SOURCE_LABELS = {
    ("kpi", "current"): "KPI report, Current Month",
    ("kpi", "prior"): "KPI report, Previous Month",
    ("kpi", "last"): "KPI report, Last Month (closed)",
    ("sales", "current"): "Salesperson report, Current Month",
    ("sales", "prior"): "Salesperson report, Previous Month",
}


def build_sources(kept, report_paths, matador_src, covideo_src):
    """The newest file behind every feed of every store, so an admin can check
    "is the dashboard reading the right document?" without opening a terminal.
    build.py --publish copies these files to S3 and the API hands out links."""
    by_name = {os.path.basename(p): p for p in report_paths}
    newest = {}
    for snap in kept:
        key = (snap["storeId"], snap["kind"], snap["period"])
        path = by_name.get(snap.get("source") or "")
        if not path:
            continue
        rank = (snap.get("runDate") or "", gmail_order(path))
        if key not in newest or rank > newest[key][0]:
            newest[key] = (rank, snap, path)
    out = []
    for (sid, kind, period), (_, snap, path) in sorted(newest.items()):
        out.append({
            "storeId": sid,
            "system": snap.get("crm", "VinSolutions"),
            "label": SOURCE_LABELS.get((kind, period), "%s %s" % (kind, period)),
            "kind": kind, "period": period,
            "file": os.path.basename(path), "path": path,
            "received": received_at(path),
            "runDate": snap.get("runDate"), "begin": snap.get("begin"), "end": snap.get("end"),
            "dateRange": snap.get("dateRange"),
        })
    for sid, path in sorted(matador_src.items()):
        out.append({"storeId": sid, "system": "Matador", "label": "Users export (CSV)", "kind": "matador", "period": None,
                    "file": os.path.basename(path), "path": path, "received": received_at(path),
                    "runDate": None, "begin": None, "end": None, "dateRange": "Month to date at export"})
    for sid, path in sorted(covideo_src.items()):
        out.append({"storeId": sid, "system": "Covideo", "label": "MTD usage report (CSV)", "kind": "covideo", "period": None,
                    "file": os.path.basename(path), "path": path, "received": received_at(path),
                    "runDate": None, "begin": None, "end": None, "dateRange": "Month to date at export"})
    return out


def write_run_log(data, xlsx, pdfs, mat_csv, other_csv, parsed, kept, dupes,
                  skipped, matador, covideo, src_dirs):
    """One line per refresh: what arrived, what it became, what failed.

    This is the dashboard's Logs page. It is written here rather than by the
    shell script because only the ingest knows what each file turned into, and
    "new snapshots" is the count that actually answers "did today's data land?"
    """
    prev = None
    try:
        with open(RUNS) as fh:
            lines = [ln for ln in fh.read().splitlines() if ln.strip()]
        prev = json.loads(lines[-1]) if lines else None
    except Exception:
        lines = []

    pull = None
    for d in src_dirs:
        candidate = os.path.join(d, ".last-pull.json")   # pull.py writes it beside gmail-pull/
        if os.path.exists(candidate):
            try:
                pull = json.load(open(candidate))
            except Exception:
                pull = None
            break

    before = (prev or {}).get("snapshots", {}).get("total", 0)
    stores = []
    for sid, cov in sorted(data["coverage"].items()):
        stores.append({"id": sid, "name": data_store_name(data, sid),
                       "through": cov.get("lastCurrent") or cov.get("lastRun"),
                       "lastAny": cov.get("lastRun")})

    now = datetime.now()
    today = now.date()
    stale = []
    for st in stores:
        try:
            through = datetime.strptime(st["through"], "%Y-%m-%d").date()
        except Exception:
            continue
        days = (today - through).days
        if days >= STALE_DAYS:
            stale.append({"id": st["id"], "name": st["name"], "through": st["through"], "days": days})
    rejected = [{"file": f, "reason": r} for f, r in skipped if not benign_skip(r)]
    # one Momentum problem produces a new file every day; alert on the reason once
    seen_reason = set()
    rejected = [r for r in rejected
                if not r["reason"].startswith("Momentum:")
                or (r["reason"] not in seen_reason and not seen_reason.add(r["reason"]))]
    for r in rejected:
        if r["reason"].startswith("Momentum:"):
            r["file"] = r["reason"]

    entry = {
        "at": now.strftime("%Y-%m-%d %H:%M"),
        "gmail": pull,
        "files": {"workbooks": len(xlsx), "pdfs": len(pdfs),
                  "matadorCsv": len(mat_csv), "otherCsv": len(other_csv)},
        "snapshots": {"total": len(kept), "new": max(0, len(kept) - before),
                      "parsed": len(parsed), "duplicatesDropped": dupes},
        "matadorRows": len(matador),
        "covideoRows": len(covideo),
        "stores": stores,
        "skipped": [{"file": f, "reason": r, "benign": benign_skip(r)} for f, r in skipped],
        "health": {"stale": stale, "rejected": len(rejected)},
    }
    lines.append(json.dumps(entry, separators=(",", ":")))
    with open(RUNS, "w") as fh:
        fh.write("\n".join(lines[-RUNS_KEPT:]) + "\n")

    # machine-readable summary for the runner's alert step (health_alert.py)
    with open(HEALTH, "w") as fh:
        json.dump({"at": entry["at"], "stale": stale, "rejected": rejected,
                   "newSnapshots": entry["snapshots"]["new"]}, fh, indent=1)


STALE_DAYS = 3          # a store with no report dated within the last 3 days
HEALTH = os.path.join(HERE, ".health.json")

# Exports that arrive empty (a day with no activity, or a report scheduled
# before the store's data exists) are rejected on purpose and are not a fault.
BENIGN_SKIPS = ("had no usable rows", "no usable user rows")  # includes "MTD report had no usable rows"


def benign_skip(reason):
    return any(b in reason for b in BENIGN_SKIPS)


def data_store_name(data, sid):
    for s in data.get("stores", []):
        if s["id"] == sid:
            return s["name"]
    return sid


if __name__ == "__main__":
    sys.exit(main(sys.argv))
