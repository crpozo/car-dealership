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
from datetime import date, datetime, timedelta

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
    ("lehigh-valley", "Lehigh Valley", "lehigh valley"),
    ("hersons", "Herson's", "herson"),
    ("garavel", "Garavel", "garavel"),
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
        elif low.endswith(".csv"):
            other_csvs.append(path)   # sniffed later — Covideo names everything report.csv
        elif low.endswith(".pdf"):
            pdfs.append(path)         # DriveCentric KPI Comparison Reports

    walk(src_dirs)
    if zips:
        walk(unpack_zips(zips, log))
    for mb in mboxes:
        xlsx.extend(extract_mbox(mb, log))
    return xlsx, csvs, other_csvs, pdfs, goals


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


def dc_columns(header_lines):
    blob = re.sub(r"[^a-z%]", "", "".join(header_lines).lower())
    cols, pos = [], 0
    by_len = sorted(DC_COLUMNS, key=len, reverse=True)
    while pos < len(blob):
        for name in by_len:
            if blob.startswith(name, pos):
                cols.append(name)
                pos += len(name)
                break
        else:
            raise ValueError("unrecognised PDF column header near %r" % blob[pos:pos + 20])
    if sorted(cols) != sorted(DC_COLUMNS):
        raise ValueError("PDF columns %s do not match the known set" % cols)
    return cols


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


def parse_dc_pdf(path):
    """-> [current snapshot, prior snapshot] for one DriveCentric PDF."""
    import fitz  # PyMuPDF

    doc = fitz.open(path)
    try:
        lines = [ln.strip() for ln in doc[0].get_text().splitlines() if ln.strip()]
    finally:
        doc.close()

    m = re.search(r"-(\d{1,2})-(\d{1,2})-(\d{4})\.pdf$", os.path.basename(path))
    if not m:
        raise ValueError("no run date in PDF filename")
    run = date(int(m.group(3)), int(m.group(1)), int(m.group(2)))

    # data blocks: each row label is followed by its 11 values
    blocks, i = [], 0
    while i < len(lines):
        if lines[i] in DC_ROW_LABELS:
            vals = [dc_value(v) for v in lines[i + 1:i + 12]]
            blocks.append((lines[i], vals))
            i += 12
        else:
            i += 1
    # section labels: the line right before each "Net Leads" header
    heads = [j for j in range(1, len(lines)) if lines[j] == "Net Leads"]
    labels = [lines[j - 1] for j in heads]

    if len(blocks) != 3 * len(labels) or not labels:
        raise ValueError("unrecognised PDF layout (%d blocks, %d labels)" % (len(blocks), len(labels)))
    # this file's column order, read from the first section's header run
    cols = dc_columns(lines[heads[0]:(heads[1] - 1 if len(heads) > 1 else len(lines))])

    store_name = labels[0]
    per_section = {}          # label -> {rowLabel: vals}
    for bi, (row_label, vals) in enumerate(blocks):
        per_section.setdefault(labels[bi // 3], {})[row_label] = vals

    def build(row_label, period, begin, end):
        by_lt = []
        for sec, rows in per_section.items():
            if sec == store_name:
                continue
            lt = DC_LEAD_TYPES.get(sec, sec)
            by_lt.append({"leadType": lt, "metrics": dc_metrics(rows[row_label], cols), "byInventory": []})
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
            "dateRange": "Current Month" if period == "current" else "Previous Month MTD",
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
    return [
        build("This Month", "current", date(run.year, run.month, 1), run),
        build("Previous MTD", "prior", date(prev_last.year, prev_last.month, 1), prior_end),
    ]


# Covideo's own "Vern Eide Honda Sioux City" is one of the two dealers the KPI
# reports combine into a single store, so its activity lands on the combined id.
COVIDEO_STORE_OVERRIDES = {"vern-eide-honda-sioux-city": "vern-eide-sioux-city-combined"}


def gmail_order(path):
    # gmail-pull files are named <gmailMsgIdHex>-<name>; the id's high bits are
    # the message's internal timestamp, so the hex value orders by arrival.
    m = re.match(r"^([0-9a-f]{15,16})-", os.path.basename(path))
    if m:
        return int(m.group(1), 16)
    return int(os.path.getmtime(path) * 1000)


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
            if co:
                by_co.setdefault(co, []).append(r)
        for co in by_co:            # later (newer) files overwrite earlier ones
            per_company[co] = by_co[co]

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
    {"name": "Matador", "type": "AI messaging", "api": "unknown", "scheduledEmail": False,
     "note": "Texts and videos sent. Activity is exported by hand from the Users tab; no scheduled email today."},
    {"name": "Covideo", "type": "Video outreach", "api": "unknown", "scheduledEmail": True,
     "note": "Daily MTD usage report arrives by scheduled email since Sep 2026 (Sommer's + Vern Eide)."},
]


def main(argv):
    src_dirs = [os.path.abspath(p) for p in argv[1:]] or [DEFAULT_SRC]
    log = []
    os.makedirs(CACHE, exist_ok=True)

    xlsx_paths, csv_paths, other_csv_paths, pdf_paths, goal_paths = discover(src_dirs, log)
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
    for path in sorted(csv_paths):
        matador.extend(parse_matador(path, log))
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

    data = {
        "generatedAt": datetime.now().strftime("%Y-%m-%d"),
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
        candidate = os.path.join(d, "gmail-pull", ".last-pull.json")
        if os.path.exists(candidate):
            try:
                pull = json.load(open(candidate))
            except Exception:
                pull = None
            break

    before = (prev or {}).get("snapshots", {}).get("total", 0)
    stores = []
    for sid, cov in sorted(data["coverage"].items()):
        stores.append({"id": sid, "name": data_store_name(data, sid), "through": cov.get("lastRun")})

    entry = {
        "at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "gmail": pull,
        "files": {"workbooks": len(xlsx), "pdfs": len(pdfs),
                  "matadorCsv": len(mat_csv), "otherCsv": len(other_csv)},
        "snapshots": {"total": len(kept), "new": max(0, len(kept) - before),
                      "parsed": len(parsed), "duplicatesDropped": dupes},
        "matadorRows": len(matador),
        "covideoRows": len(covideo),
        "stores": stores,
        "skipped": [{"file": f, "reason": r} for f, r in skipped],
    }
    lines.append(json.dumps(entry, separators=(",", ":")))
    with open(RUNS, "w") as fh:
        fh.write("\n".join(lines[-RUNS_KEPT:]) + "\n")


def data_store_name(data, sid):
    for s in data.get("stores", []):
        if s["id"] == sid:
            return s["name"]
    return sid


if __name__ == "__main__":
    sys.exit(main(sys.argv))
