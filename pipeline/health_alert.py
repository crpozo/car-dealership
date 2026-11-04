#!/usr/bin/env python3
"""Decide whether this refresh deserves an alert, and print its body if so.

    python3 health_alert.py pipeline/.health.json /opt/scott-data/.health-alerted.json

Reads the summary ingest.py writes (.health.json) and the record of what was
already alerted (state file). Prints nothing when there is nothing new, so the
runner can do: body=$(python3 health_alert.py ...) && [ -n "$body" ] && alert.

Two conditions are watched, because together they catch the failure that went
unnoticed for 18 days in Oct 2026 (a report changed format, its PDFs were
rejected every day, and three stores silently stopped updating):

  * a store went stale — no report dated within the last STALE_DAYS days
  * a file was rejected for a reason that is not an empty export

Each is alerted once per store / per file; a store that recovers and goes
stale again alerts again. An empty state file means "alert everything".
"""
import json
import sys
from collections import Counter


def main(argv):
    health_path, state_path = argv[1], argv[2]
    health = json.load(open(health_path))
    try:
        state = json.load(open(state_path))
    except Exception:  # noqa: BLE001 - first run, or unreadable
        state = {}
    seen_stale = set(state.get("stale", []))
    seen_files = set(state.get("files", []))

    stale_now = {s["id"]: s for s in health.get("stale", [])}
    new_stale = [s for sid, s in stale_now.items() if sid not in seen_stale]
    rejected = health.get("rejected", [])
    new_files = [r for r in rejected if r["file"] not in seen_files]

    # remember the current picture: stores that recovered drop out, so they
    # alert again if they stall later; rejected files are remembered for good
    state = {"stale": sorted(stale_now), "files": sorted(seen_files | {r["file"] for r in rejected})[-2000:]}
    with open(state_path, "w") as fh:
        json.dump(state, fh)

    if not new_stale and not new_files:
        return 0

    out = []
    if new_stale:
        out.append("STORES NOT UPDATING (no report in the last 3 days):")
        for s in sorted(new_stale, key=lambda x: x["name"]):
            out.append("  - %s: newest report %s (%d days old)" % (s["name"], s["through"], s["days"]))
        out.append("")
    if new_files:
        by_reason = Counter(r["reason"] for r in new_files)
        out.append("FILES REJECTED BY THE PARSER (%d new):" % len(new_files))
        for reason, n in by_reason.most_common():
            out.append("  - %d x %s" % (n, reason))
        out.append("  e.g. " + new_files[0]["file"])
        out.append("")
    out.append("Most likely a report changed format or a scheduled email stopped.")
    out.append("Details: dashboard > Logs (admins), or pipeline/runs.jsonl.")
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
