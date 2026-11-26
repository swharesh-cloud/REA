#!/bin/bash
# Installs Liquid Trader as an always-on systemd service on a Linux server
# (Ubuntu 22.04+/Debian 12+). deploy.sh runs this for you; it's safe to re-run.
#
# Expects the app code in /opt/liquid-trader/app (deploy.sh copies it there).
# API keys go in /etc/liquid-trader/env (root-only, 0600):
#   LIQUID_API_KEY=lq_...
#   LIQUID_API_SECRET=sk_...
#   LT_NOTIFY_URL=https://ntfy.sh/your-secret-topic      (optional)
set -euo pipefail

APP=/opt/liquid-trader/app
DATA=/var/lib/liquid-trader
ETC=/etc/liquid-trader
UNIT=/etc/systemd/system/liquid-trader.service
PORT="${LT_PORT:-8765}"

[ "$(id -u)" -eq 0 ] || { echo "Run as root (or with sudo)." >&2; exit 1; }
[ -d "$APP/liquid_trader" ] || { echo "App code not found in $APP" >&2; exit 1; }

if ! command -v python3 >/dev/null 2>&1; then
  echo "Installing python3..."
  if command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y -qq python3
  elif command -v dnf >/dev/null; then dnf install -y -q python3
  else echo "Please install Python 3.9+ and re-run." >&2; exit 1; fi
fi
PY="$(command -v python3)"
"$PY" -c 'import sys; sys.exit(sys.version_info < (3, 9))' || { echo "Python 3.9+ required" >&2; exit 1; }

# Dedicated unprivileged user that owns only the data directory
if ! id liquidtrader >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin liquidtrader
fi
install -d -o liquidtrader -g liquidtrader -m 700 "$DATA" "$DATA/.liquid-trader"
install -d -o root -g root -m 700 "$ETC"
[ -f "$ETC/env" ] || install -o root -g root -m 600 /dev/null "$ETC/env"
chmod 600 "$ETC/env"
chown -R root:root /opt/liquid-trader
chmod -R u=rwX,go=rX /opt/liquid-trader
find "$APP" -name __pycache__ -type d -prune -exec rm -rf {} +

cat > "$UNIT" <<UNITFILE
[Unit]
Description=Liquid Trader 24/7 trading engine
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=liquidtrader
Group=liquidtrader
WorkingDirectory=$APP
Environment=HOME=$DATA
Environment=PYTHONUNBUFFERED=1
Environment=PYTHONDONTWRITEBYTECODE=1
EnvironmentFile=-$ETC/env
ExecStart=$PY -m liquid_trader --headless --port $PORT
Restart=always
RestartSec=5
TimeoutStopSec=20
# hardening: the engine can only write its own data directory
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
UNITFILE

systemctl daemon-reload
systemctl enable liquid-trader >/dev/null 2>&1
systemctl restart liquid-trader

# wait until the dashboard answers
for i in $(seq 1 30); do
  if "$PY" -c "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:$PORT/', timeout=2)" 2>/dev/null; then
    echo "OK: Liquid Trader is running (systemd service 'liquid-trader', port $PORT on localhost only)."
    exit 0
  fi
  sleep 1
done
echo "The service did not come up. Recent logs:" >&2
journalctl -u liquid-trader -n 40 --no-pager >&2 || true
exit 1
