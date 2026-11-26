#!/bin/bash
# Double-click in Finder (or run in Terminal) to start Liquid Trader without building the .app.
cd "$(dirname "$0")"
python3 -c 'import webview' 2>/dev/null || python3 -m pip install --user --quiet pywebview || true
exec python3 -m liquid_trader "$@"
