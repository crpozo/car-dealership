#!/usr/bin/env python3
"""Pull every report attachment from the Gmail SCOTT REPORTS label via the Gmail API.

One-time setup (already done 2026-09-07): the gcloud CLI was authorized with the
gmail.readonly scope —
  gcloud auth application-default login --no-launch-browser \
    --scopes=https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/cloud-platform
— which required marking "Google Auth Library" as a trusted app in the
mindfultech.ec Workspace admin console (Security > API controls). The refresh
token lives in ~/.config/gcloud/application_default_credentials.json and is
used silently forever after. A client_secret.json under ~/.config/scott-reports
still works as a fallback if the ADC file is ever revoked.

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
import time

from googleapiclient.errors import HttpError

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
LABEL_NAME = "SCOTT REPORTS"
CFG = os.path.expanduser("~/.config/scott-reports")
CLIENT_SECRET = os.path.join(CFG, "client_secret.json")
TOKEN = os.path.join(CFG, "token.json")
ADC = os.path.expanduser("~/.config/gcloud/application_default_credentials.json")
OUT = os.path.expanduser("~/Projects/Scott/gmail-pull")

WANTED_EXT = (".xlsx", ".csv", ".pdf")


def credentials():
    # Preferred path: the gcloud ADC file, whose refresh token already carries
    # the gmail.readonly scope (see docstring). No browser, no interaction.
    if os.path.exists(ADC):
        creds = Credentials.from_authorized_user_file(ADC, SCOPES)
        if not creds.valid:
            creds.refresh(Request())
        return creds

    creds = None
    if os.path.exists(TOKEN):
        creds = Credentials.from_authorized_user_file(TOKEN, SCOPES)
    if creds and creds.valid:
        return creds
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
    else:
        if not os.path.exists(CLIENT_SECRET):
            sys.exit("No gcloud ADC at %s and no OAuth client at %s — redo the one-time setup in the docstring."
                     % (ADC, CLIENT_SECRET))
        flow = InstalledAppFlow.from_client_secrets_file(CLIENT_SECRET, SCOPES)
        creds = flow.run_local_server(port=0, prompt="consent")
    os.makedirs(CFG, exist_ok=True)
    with open(TOKEN, "w") as fh:
        fh.write(creds.to_json())
    return creds


def run(req):
    # Gmail caps "query cost units" per minute per user; a full-mailbox pull
    # trips it. On 403/429 rate errors, back off and retry instead of dying.
    delay = 4
    while True:
        try:
            return req.execute()
        except HttpError as err:
            if err.resp.status not in (403, 429) or b"ateLimit" not in err.content:
                raise
            if delay > 120:
                raise
            print("  rate limited — waiting %ds" % delay)
            time.sleep(delay)
            delay *= 2


def main():
    os.makedirs(OUT, exist_ok=True)
    svc = build("gmail", "v1", credentials=credentials())

    labels = run(svc.users().labels().list(userId="me")).get("labels", [])
    label_id = next((l["id"] for l in labels if l["name"] == LABEL_NAME), None)
    if not label_id:
        sys.exit('Label "%s" not found in this mailbox.' % LABEL_NAME)

    have = {f.split("-", 1)[0] for f in os.listdir(OUT) if "-" in f}

    msg_ids, page = [], None
    while True:
        resp = run(svc.users().messages().list(
            userId="me", labelIds=[label_id], maxResults=500, pageToken=page))
        msg_ids += [m["id"] for m in resp.get("messages", [])]
        page = resp.get("nextPageToken")
        if not page:
            break

    new_ids = [m for m in msg_ids if m not in have]
    print("label %s: %d messages, %d already pulled, %d new"
          % (LABEL_NAME, len(msg_ids), len(msg_ids) - len(new_ids), len(new_ids)))

    saved = skipped = 0
    for i, mid in enumerate(new_ids, 1):
        msg = run(svc.users().messages().get(userId="me", id=mid))

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
            att = run(svc.users().messages().attachments().get(
                userId="me", messageId=mid, id=att_id))
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
