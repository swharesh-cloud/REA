#!/bin/bash
# Turn this Mac into an always-on Liquid Trader server.
#
#   ./mac_server_setup.sh               # trade 24/7 while you're logged in (no admin prompts for the service)
#   ./mac_server_setup.sh --at-boot     # RECOMMENDED for a server: also runs after power cuts, macOS
#                                       # updates and reboots, before anyone logs in
#   ./mac_server_setup.sh --lid-closed  # (laptops) keep running with the lid shut - see warning below
#   ./mac_server_setup.sh --status      # is it running?
#   ./mac_server_setup.sh --undo        # remove the service and restore your power settings
#
# What it changes (asks first; admin password needed for power settings and --at-boot):
#   * installs "Liquid Trader.app" in /Applications
#   * installs the trading engine as a launchd service: starts automatically, restarts if it crashes,
#     resumes your bots, reconnects to Liquid after outages, stops the Mac idle-sleeping
#   * power settings: never sleep while on power, restart automatically after a power failure,
#     wake for network access. Your previous values are saved and restored by --undo.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${LT_APPS_DIR:-/Applications}/Liquid Trader.app"
RES="$APP/Contents/Resources"
SUPPORT="$HOME/Library/Application Support/LiquidTrader"
VENV="$SUPPORT/venv"
BACKUP="$SUPPORT/pmset-backup.txt"
LABEL="com.liquidtrader.engine"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
DAEMON="/Library/LaunchDaemons/$LABEL.plist"
PORT=8765

AT_BOOT=0; LID=0; MODE=install
for a in "$@"; do
  case "$a" in
    --at-boot) AT_BOOT=1 ;;
    --lid-closed) LID=1 ;;
    --undo) MODE=undo ;;
    --status) MODE=status ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $a" >&2; exit 1 ;;
  esac
done

[[ "$(uname)" == "Darwin" ]] || { echo "This script is for macOS." >&2; exit 1; }
HAS_BATTERY=0; pmset -g batt 2>/dev/null | grep -q InternalBattery && HAS_BATTERY=1
PM_SCOPE="-a"; [[ $HAS_BATTERY == 1 ]] && PM_SCOPE="-c"   # laptops: only change the on-charger profile

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask() { local r; read -r -p "$1 [Y/n] " r || true; [[ ! "$r" =~ ^[Nn] ]]; }
engine_up() { curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/" 2>/dev/null; }

pm_get() {  # current value of a pmset key ("SleepDisabled" for disablesleep)
  pmset -g | awk -v k="$1" '$1==k {print $2; exit}'
}

status() {
  say "Liquid Trader server status"
  if [[ -f "$DAEMON" ]]; then echo "  Service:   boot-level (runs before login)  $DAEMON"
  elif [[ -f "$AGENT" ]]; then echo "  Service:   login-level (runs while you're logged in)  $AGENT"
  else echo "  Service:   not installed"; fi
  if engine_up; then echo "  Engine:    RUNNING on http://127.0.0.1:$PORT"; else echo "  Engine:    not responding"; fi
  echo "  Sleep on power:        $(pm_get sleep) (0 = never)"
  echo "  Restart after outage:  $(pm_get autorestart) (1 = yes)"
  [[ "$(pm_get SleepDisabled)" == "1" ]] && echo "  Lid-closed mode:       ON"
  if fdesetup isactive >/dev/null 2>&1; then echo "  FileVault:             on (see README: a power cut needs your password at the unlock screen)"; fi
  echo "  Logs:      $HOME/Library/Logs/LiquidTrader.log"
}

# --------------------------------------------------------------------------- undo
if [[ $MODE == status ]]; then status; exit 0; fi
if [[ $MODE == undo ]]; then
  say "Removing the Liquid Trader service"
  if [[ -f "$DAEMON" ]]; then
    sudo launchctl bootout "system/$LABEL" 2>/dev/null || sudo launchctl unload "$DAEMON" 2>/dev/null || true
    sudo rm -f "$DAEMON"; echo "  removed boot-level service"
  fi
  if [[ -f "$AGENT" ]]; then
    launchctl unload -w "$AGENT" 2>/dev/null || true; rm -f "$AGENT"; echo "  removed login-level service"
  fi
  if [[ -f "$BACKUP" ]]; then
    say "Restoring your previous power settings"
    while read -r key val; do
      [[ -z "$key" || -z "$val" ]] && continue
      if [[ "$key" == "SleepDisabled" ]]; then sudo pmset -a disablesleep "$val"
      elif [[ "$key" == "autorestart" || "$key" == "womp" ]]; then sudo pmset -a "$key" "$val"
      else sudo pmset $PM_SCOPE "$key" "$val"; fi
      echo "  $key → $val"
    done < "$BACKUP"
    rm -f "$BACKUP"
  fi
  echo; echo "Done. Your bots and settings are kept; open Liquid Trader to run them in the app again."
  exit 0
fi

# --------------------------------------------------------------------------- install
say "1/4  Installing Liquid Trader.app"
"$HERE/build_mac_app.sh" --install >/dev/null
echo "  $APP"

PY=""
for p in /opt/homebrew/bin/python3 /usr/local/bin/python3 \
         /Library/Frameworks/Python.framework/Versions/Current/bin/python3 /usr/bin/python3; do
  if [[ -x "$p" ]] && "$p" -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null; then PY="$p"; break; fi
done
[[ -n "$PY" ]] || { echo "Python 3.9+ is required (python.org, Homebrew, or: xcode-select --install)" >&2; exit 1; }
if [[ ! -x "$VENV/bin/python" ]]; then
  mkdir -p "$SUPPORT"
  "$PY" -m venv "$VENV"
  "$VENV/bin/python" -m pip install --quiet --upgrade pip >/dev/null 2>&1 || true
  "$VENV/bin/python" -m pip install --quiet pywebview >/dev/null 2>&1 || echo "  (pywebview not installed - the dashboard will open in your browser)"
fi

say "2/4  Installing the 24/7 trading service"
mkdir -p "$HOME/Library/Logs" "$SUPPORT"   # launchd won't create log folders itself
if [[ $AT_BOOT == 1 ]]; then
  if fdesetup isactive >/dev/null 2>&1; then
    echo "  ⚠️  FileVault is on. After a POWER CUT the Mac waits at the FileVault unlock screen"
    echo "     until someone types the password - nothing (including trading) can run before that."
    echo "     macOS updates and planned restarts are fine (they unlock automatically)."
  fi
  # the Keychain is locked before login, so give the boot service a private copy of the API key
  (cd "$RES" && "$VENV/bin/python" -m liquid_trader --export-credentials) | grep -q exported \
    && echo "  API key copied to a private file (0600) for the boot-level service" \
    || echo "  No API key yet - add it later in Settings (runs on the simulated market until then)"
  if [[ -f "$AGENT" ]]; then launchctl unload -w "$AGENT" 2>/dev/null || true; rm -f "$AGENT"; fi
  TMP="$(mktemp)"
  (cd "$RES" && "$VENV/bin/python" -m liquid_trader --print-daemon-plist "$(id -un)" "$HOME" --port "$PORT") > "$TMP"
  plutil -lint "$TMP" >/dev/null
  echo "  Admin password needed to install the boot-level service:"
  sudo launchctl bootout "system/$LABEL" 2>/dev/null || true
  sudo install -o root -g wheel -m 644 "$TMP" "$DAEMON"
  rm -f "$TMP"
  sudo launchctl bootstrap system "$DAEMON" 2>/dev/null || sudo launchctl load -w "$DAEMON"
  echo "  Installed: starts at power-on, before login, and restarts if it ever stops."
else
  (cd "$RES" && "$VENV/bin/python" -m liquid_trader --install-service >/dev/null)
  echo "  Installed: starts when you log in and restarts if it ever stops."
  echo "  Tip: re-run with --at-boot so it also survives power cuts and macOS updates without a login."
fi

say "3/4  Power settings for a server"
if [[ ! -f "$BACKUP" ]]; then   # keep the ORIGINAL values even if this script runs again
  mkdir -p "$SUPPORT"
  for k in sleep disksleep womp autorestart SleepDisabled; do
    v="$(pm_get $k)"; [[ "$k" == "SleepDisabled" && -z "$v" ]] && v=0   # not listed when off
    echo "$k $v"
  done > "$BACKUP"
fi
echo "  • never sleep while on power (the screen can still turn off)"
echo "  • restart automatically after a power failure"
echo "  • wake for network access"
if ask "  Apply these (admin password needed)?"; then
  sudo pmset $PM_SCOPE sleep 0 disksleep 0
  sudo pmset -a womp 1 autorestart 1
  echo "  Applied."
else
  echo "  Skipped. (The service still prevents idle sleep while it runs.)"
fi
if [[ $LID == 1 && $HAS_BATTERY == 1 ]]; then
  echo
  echo "  ⚠️  Lid-closed mode stops ALL sleep, even with the lid shut and on battery."
  echo "     Keep the MacBook open-vented on a desk and plugged in - never in a bag."
  if ask "  Enable lid-closed mode?"; then sudo pmset -a disablesleep 1; echo "  Enabled (undo: ./mac_server_setup.sh --undo)."; fi
elif [[ $HAS_BATTERY == 1 ]]; then
  echo "  Laptop note: closing the lid still sleeps the Mac unless an external display is connected,"
  echo "  or you re-run with --lid-closed."
fi

say "4/4  Checking the engine"
for i in $(seq 1 40); do engine_up && break; sleep 1; done
if engine_up; then
  echo "  ✅ Liquid Trader is running 24/7 on this Mac."
else
  echo "  ⏳ Not answering yet. If the Liquid Trader window is open, quit it - the service takes over"
  echo "     within a few seconds. Logs: $HOME/Library/Logs/LiquidTrader.log"
fi
cat <<EOF

Next:
  • Open "Liquid Trader" from Applications. The window connects to the running engine, and
    closing it does NOT stop trading.
  • Settings → Phone alerts: add an ntfy link so your phone hears about trades and problems
    while you're away.
  • Check any time:  ./mac_server_setup.sh --status      Undo:  ./mac_server_setup.sh --undo
EOF
