#!/bin/zsh
# Daily automatic refresh: Gmail pull -> ingest -> build -> deploy to GitHub Pages.
# Scheduled by launchd (~/Library/LaunchAgents/com.mindfultech.scott-reports.plist);
# run it by hand any time for an on-demand refresh:
#   ~/Projects/car-dealership/pipeline/refresh.sh
set -euo pipefail

REPO="$HOME/Projects/car-dealership"
DATA="$HOME/Projects/Scott"
PY="$HOME/micromamba/bin/python3"
LOG="$HOME/Library/Logs/scott-reports.log"

exec >>"$LOG" 2>&1
echo "=== refresh $(date '+%Y-%m-%d %H:%M:%S') ==="

cd "$REPO"
"$PY" pipeline/pull.py
"$PY" pipeline/ingest.py "$DATA"
"$PY" pipeline/build.py

if [[ -z "$(/usr/bin/git status --porcelain assets/data.js index.html)" ]]; then
  echo "no new data — nothing to deploy"
  exit 0
fi

/usr/bin/git add assets/data.js index.html
/usr/bin/git commit -m "Auto-refresh data $(date '+%Y-%m-%d %H:%M')"
/usr/bin/git push origin main
echo "deployed"
