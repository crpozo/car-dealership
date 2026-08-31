#!/usr/bin/env python3
"""Pull every report attachment from the Gmail SCOTT REPORTS label via the Gmail API.

One-time setup:
  1. In Google Cloud Console (account carlos@mindfultech.ec): enable the Gmail API
     and create an OAuth client ID of type "Desktop app".
  2. Save the downloaded JSON as ~/.config/scott-reports/client_secret.json
  3. First run opens a browser window — approve with carlos@mindfultech.ec.
     The token is cached in ~/.config/scott-reports/token.json; later runs are silent.

Then, forever after:
  python3 pipeline/pull.py        # downloads only what is new
  python3 pipeline/ingest.py ~/Projects/Scott
  python3 pipeline/build.py

Attachments land in ~/Projects/Scott/gmail-pull/ (which ingest.py walks), named
<messageId>-<original>.xlsx so re-runs never re-download or collide. Incremental
state is just "which message ids already have files on disk" — no database.
"""
import base64
import json
import os
import sys

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
LABEL_NAME = "SCOTT REPORTS"
CFG = os.path.expanduser("~/.config/scott-reports")
CLIENT_SECRET = os.path.join(CFG, "client_secret.json")
TOKEN = os.path.join(CFG, "token.json")
OUT = os.path.expanduser("~/Projects/Scott/gmail-pull")

WANTED_EXT = (".xlsx", ".csv")


def credentials():
    creds = None
    if os.path.exists(TOKEN):
        creds = Credentials.from_authorized_user_file(TOKEN, SCOPES)
    if creds and creds.valid:
        return creds
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
    else:
        if not os.path.exists(CLIENT_SECRET):
            sys.exit("No OAuth client at %s — do the one-time setup in the docstring." % CLIENT_SECRET)
        flow = InstalledAppFlow.from_client_secrets_file(CLIENT_SECRET, SCOPES)
        creds = flow.run_local_server(port=0, prompt="consent")
    os.makedirs(CFG, exist_ok=True)
    with open(TOKEN, "w") as fh:
        fh.write(creds.to_json())
    return creds


def main():
    os.makedirs(OUT, exist_ok=True)
    svc = build("gmail", "v1", credentials=credentials())

    labels = svc.users().labels().list(userId="me").execute().get("labels", [])
    label_id = next((l["id"] for l in labels if l["name"] == LABEL_NAME), None)
    if not label_id:
        sys.exit('Label "%s" not found in this mailbox.' % LABEL_NAME)

    have = {f.split("-", 1)[0] for f in os.listdir(OUT) if "-" in f}

    msg_ids, page = [], None
    while True:
        resp = svc.users().messages().list(
            userId="me", labelIds=[label_id], maxResults=500, pageToken=page).execute()
        msg_ids += [m["id"] for m in resp.get("messages", [])]
        page = resp.get("nextPageToken")
        if not page:
            break

    new_ids = [m for m in msg_ids if m not in have]
    print("label %s: %d messages, %d already pulled, %d new"
          % (LABEL_NAME, len(msg_ids), len(msg_ids) - len(new_ids), len(new_ids)))

    saved = skipped = 0
    for i, mid in enumerate(new_ids, 1):
        msg = svc.users().messages().get(userId="me", id=mid).execute()

        def walk(part):
            yield part
            for sub in part.get("parts", []) or []:
                yield from walk(sub)

        got_any = False
        for part in walk(msg["payload"]):
            fname = part.get("filename") or ""
            att_id = (part.get("body") or {}).get("attachmentId")
            if not fname.lower().endswith(WANTED_EXT) or not att_id:
                continue
            att = svc.users().messages().attachments().get(
                userId="me", messageId=mid, id=att_id).execute()
            data = base64.urlsafe_b64decode(att["data"])
            safe = fname.replace("/", "_")
            with open(os.path.join(OUT, "%s-%s" % (mid, safe)), "wb") as fh:
                fh.write(data)
            saved += 1
            got_any = True
        if not got_any:
            # remember attachment-less messages so we never refetch them
            open(os.path.join(OUT, "%s-none.empty" % mid), "w").close()
            skipped += 1
        if i % 50 == 0:
            print("  ...%d/%d messages" % (i, len(new_ids)))

    print("saved %d attachments (%d messages had none) -> %s" % (saved, skipped, OUT))


if __name__ == "__main__":
    main()
