#!/usr/bin/env python3
"""Preview the Strategy Builder on fixture bars. No Alpaca keys and no orders.

    BUILDER_STATIC=/path/to/TradeTracker/static python3 builder_demo.py

Then open http://127.0.0.1:8766/builder
The real app serves /static itself; this preview only needs the chart bundle.
"""
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
os.environ.setdefault("BUILDER_FIXTURE_BARS", "1")
os.environ.setdefault("BUILDER_DEMO", "1")
os.environ.setdefault("BUILDER_ROOT", tempfile.mkdtemp(prefix="builder-demo-"))

from flask import Flask

from builder_web import bp

static = os.environ.get("BUILDER_STATIC") or str(HERE / "static")
app = Flask(__name__, static_folder=static)
app.register_blueprint(bp)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "8766")), debug=False)
