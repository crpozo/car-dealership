#!/usr/bin/env python3
"""Build index.html: run extract.py first (writes data.json), then inject into template.

Usage, from the repo root:
    python3 pipeline/extract.py     # reads the report exports, writes pipeline/data.json
    python3 pipeline/build.py       # writes index.html
Adjust SRC/OUT paths at the top of extract.py to wherever the report exports live.
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

data = json.load(open(os.path.join(HERE, "data.json")))
js = json.dumps(data, separators=(",", ":")).replace("</", "<\\/")
tpl = open(os.path.join(HERE, "template.html")).read()
assert "__DATA_JSON__" in tpl
open(os.path.join(ROOT, "index.html"), "w").write(tpl.replace("__DATA_JSON__", js))
print("wrote index.html")
