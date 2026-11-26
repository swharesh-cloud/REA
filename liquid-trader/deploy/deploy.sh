#!/bin/bash
# Deploy Liquid Trader to your own Linux server so it trades 24/7.
#
#   ./deploy/deploy.sh root@203.0.113.10            # first install or update
#   ./deploy/deploy.sh ubuntu@203.0.113.10 --migrate-bots
#
# Needs: SSH access to an Ubuntu 22.04+/Debian 12+ server as root, or as a user
# with passwordless sudo (the default "ubuntu"/"admin" user on most cloud images).
#
# What it does:
#   1. copies the app to /opt/liquid-trader/app on the server
#   2. asks for your Liquid API key/secret (optional) and stores them root-only on the server
#   3. optionally copies your bots from this Mac (--migrate-bots)
#   4. installs and starts the 'liquid-trader' systemd service (auto-restart, starts on boot)
# Re-run it any time to update the server to the code in this folder. Your bots and keys are kept.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-}"
MIGRATE=0
[[ "${2:-}" == "--migrate-bots" ]] && MIGRATE=1
if [[ -z "$TARGET" || "$TARGET" == -* ]]; then
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

SSH_OPTS=(-o ServerAliveInterval=30 -o ConnectTimeout=15)
ssh_run() { ssh -n "${SSH_OPTS[@]}" "$TARGET" "$@"; }       # no stdin (keeps your typed answers safe)
ssh_pipe() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }         # forwards stdin to the server

echo "→ Checking SSH access to $TARGET ..."
REMOTE_USER="$(ssh_run 'id -un')" || { echo "Could not SSH to $TARGET" >&2; exit 1; }
if [[ "$REMOTE_USER" == "root" ]]; then
  SUDO=""
elif ssh_run 'sudo -n true' 2>/dev/null; then
  SUDO="sudo -n"
else
  echo "$REMOTE_USER needs passwordless sudo on the server (or connect as root)." >&2
  exit 1
fi

echo "→ Uploading app code ..."
tar -C "$HERE" --exclude '__pycache__' -czf - liquid_trader deploy/server_setup.sh \
  | ssh_pipe "$SUDO mkdir -p /opt/liquid-trader/app && $SUDO rm -rf /opt/liquid-trader/app/liquid_trader && $SUDO tar -C /opt/liquid-trader/app -xzf -"

# ---- credentials ----------------------------------------------------------
HAS_ENV="$(ssh_run "$SUDO sh -c 'grep -q ^LIQUID_API_KEY= /etc/liquid-trader/env 2>/dev/null && echo yes || echo no'")"
ASK=1
if [[ "$HAS_ENV" == "yes" ]]; then
  read -r -p "The server already has a Liquid API key. Replace it? [y/N] " a || true
  [[ "$a" =~ ^[Yy] ]] || ASK=0
fi
if [[ $ASK == 1 ]]; then
  echo "Enter your Liquid API key (from sdk.tryliquid.xyz). Leave blank to skip and use the simulated market."
  read -r -p "  API key: " KEY || true
  if [[ -n "$KEY" ]]; then
    read -r -s -p "  API secret (hidden): " SECRET || true; echo
    read -r -p "  Phone alerts URL, e.g. https://ntfy.sh/<secret-topic> (optional): " NOTIFY || true
    # sent over SSH stdin, never on a command line; stored root-only (0600)
    { printf 'LIQUID_API_KEY=%s\nLIQUID_API_SECRET=%s\n' "$KEY" "$SECRET"
      [[ -n "$NOTIFY" ]] && printf 'LT_NOTIFY_URL=%s\n' "$NOTIFY"; true; } \
      | ssh_pipe "$SUDO sh -c 'umask 077; mkdir -p /etc/liquid-trader; cat > /etc/liquid-trader/env'"
    unset KEY SECRET
  fi
fi

# ---- bots migration -------------------------------------------------------
if [[ $MIGRATE == 1 ]]; then
  LOCAL_BOTS="$HOME/Library/Application Support/LiquidTrader/bots.json"
  [[ -f "$LOCAL_BOTS" ]] || LOCAL_BOTS="$HOME/.liquid-trader/bots.json"
  if [[ -f "$LOCAL_BOTS" ]]; then
    echo "→ Copying your bots to the server ..."
    ssh_run "$SUDO systemctl stop liquid-trader 2>/dev/null || true"
    ssh_pipe "$SUDO sh -c 'mkdir -p /var/lib/liquid-trader/.liquid-trader; cat > /var/lib/liquid-trader/.liquid-trader/bots.json'" < "$LOCAL_BOTS"
    ssh_run "$SUDO sh -c 'id liquidtrader >/dev/null 2>&1 && chown -R liquidtrader:liquidtrader /var/lib/liquid-trader || true'"
    if [[ "$(uname)" == "Darwin" && -f "$HOME/Library/LaunchAgents/com.liquidtrader.engine.plist" ]]; then
      read -r -p "Turn off the 24/7 service on this Mac so bots don't run in two places? [Y/n] " a || true
      if [[ ! "$a" =~ ^[Nn] ]]; then
        (cd "$HERE" && python3 -m liquid_trader --uninstall-service >/dev/null) && echo "  Local service turned off."
      fi
    fi
    echo "  NOTE: don't run the same bots on this Mac too, or they'll trade twice."
  else
    echo "No local bots found to migrate."
  fi
fi

# ---- install & start --------------------------------------------------------
echo "→ Installing the systemd service ..."
ssh_run "$SUDO bash /opt/liquid-trader/app/deploy/server_setup.sh"

cat <<DONE

✅ Liquid Trader is running 24/7 on $TARGET.

Open the dashboard (through an encrypted SSH tunnel):
    ./deploy/dashboard.sh $TARGET

Useful commands:
    ssh $TARGET 'sudo journalctl -u liquid-trader -f'     # live logs
    ssh $TARGET 'sudo systemctl restart liquid-trader'    # restart
    ./deploy/deploy.sh $TARGET                            # update to the latest code
DONE
