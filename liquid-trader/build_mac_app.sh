#!/bin/bash
# Build "Liquid Trader.app" — run this on your Mac:   ./build_mac_app.sh
# Optional: ./build_mac_app.sh --install   (also copies the app into /Applications)
#
# The app bundle contains the Python source. On first launch it creates a private
# virtualenv in ~/Library/Application Support/LiquidTrader/venv and installs
# pywebview there (for the native window). Nothing else on your system is changed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/dist/Liquid Trader.app"
VERSION="$(sed -n 's/^__version__ = "\(.*\)"/\1/p' "$HERE/liquid_trader/__init__.py")"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script builds a macOS .app and must run on a Mac." >&2
  exit 1
fi

echo "Building Liquid Trader $VERSION ..."
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# --- app code ---------------------------------------------------------------
rsync -a --exclude '__pycache__' "$HERE/liquid_trader" "$APP/Contents/Resources/"

# --- icon -------------------------------------------------------------------
if command -v iconutil >/dev/null && command -v sips >/dev/null; then
  ICONSET="$(mktemp -d)/LiquidTrader.iconset"
  mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$HERE/assets/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s*2)) $((s*2)) "$HERE/assets/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
fi

# --- Info.plist -------------------------------------------------------------
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Liquid Trader</string>
  <key>CFBundleDisplayName</key><string>Liquid Trader</string>
  <key>CFBundleIdentifier</key><string>com.liquidtrader.app</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>LiquidTrader</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.finance</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

# --- launcher ---------------------------------------------------------------
cat > "$APP/Contents/MacOS/LiquidTrader" <<'LAUNCHER'
#!/bin/bash
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
SUPPORT="$HOME/Library/Application Support/LiquidTrader"
VENV="$SUPPORT/venv"
LOG="$HOME/Library/Logs/LiquidTrader-app.log"
mkdir -p "$SUPPORT" "$(dirname "$LOG")"

PY=""
for p in /opt/homebrew/bin/python3 /usr/local/bin/python3 \
         /Library/Frameworks/Python.framework/Versions/Current/bin/python3 /usr/bin/python3; do
  if [ -x "$p" ] && "$p" -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null; then PY="$p"; break; fi
done
if [ -z "$PY" ]; then
  osascript -e 'display alert "Liquid Trader needs Python 3.9+" message "Install it from python.org or run: xcode-select --install"'
  exit 1
fi

if [ ! -x "$VENV/bin/python" ]; then
  osascript -e 'display notification "Setting up for first launch (about 30 seconds)…" with title "Liquid Trader"' || true
  "$PY" -m venv "$VENV" >>"$LOG" 2>&1
  "$VENV/bin/python" -m pip install --quiet --upgrade pip >>"$LOG" 2>&1 || true
  "$VENV/bin/python" -m pip install --quiet pywebview >>"$LOG" 2>&1 || true   # falls back to the browser if this fails
fi

cd "$RES" && exec "$VENV/bin/python" -m liquid_trader "$@" >>"$LOG" 2>&1
LAUNCHER
chmod +x "$APP/Contents/MacOS/LiquidTrader"

# ad-hoc signature so Gatekeeper treats it as one bundle (unsigned apps: right-click → Open the first time)
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

echo "Built: $APP"
if [[ "${1:-}" == "--install" ]]; then
  rm -rf "/Applications/Liquid Trader.app"
  cp -R "$APP" /Applications/
  echo "Installed to /Applications/Liquid Trader.app"
fi
echo "Open it with:  open \"${APP}\""
