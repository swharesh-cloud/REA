#!/bin/bash
# Open the dashboard of a Liquid Trader engine running on your server.
#   ./deploy/dashboard.sh root@203.0.113.10
# The dashboard is never exposed to the internet: it travels through an encrypted
# SSH tunnel (local port 18765 → server's 127.0.0.1:8765). Close the window or
# press Ctrl-C to disconnect; the server keeps trading.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:?usage: dashboard.sh user@server [local-port]}"
LPORT="${2:-18765}"
URL="http://127.0.0.1:$LPORT"

ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L "$LPORT:127.0.0.1:8765" "$TARGET" &
TUNNEL=$!
trap 'kill $TUNNEL 2>/dev/null || true' EXIT INT TERM

for i in $(seq 1 20); do
  if curl -fsS -o /dev/null "$URL/" 2>/dev/null; then break; fi
  kill -0 $TUNNEL 2>/dev/null || { echo "SSH tunnel failed." >&2; exit 1; }
  sleep 0.5
done
echo "Connected to $TARGET → $URL  (Ctrl-C to disconnect; the server keeps trading)"

# Native window if pywebview is available, otherwise the default browser
if (cd "$HERE" && python3 -c 'import webview' 2>/dev/null); then
  (cd "$HERE" && python3 -m liquid_trader --connect "$URL")
else
  if command -v open >/dev/null; then open "$URL"; else xdg-open "$URL" >/dev/null 2>&1 || echo "Open $URL in your browser"; fi
  wait $TUNNEL
fi
