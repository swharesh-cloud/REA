"""Launch Liquid Trader.

* Normal launch: opens a native macOS window (pywebview) or your browser. If the 24/7
  background service is already running, the window simply connects to it.
* --headless: runs only the engine + local server (this is what the launchd service runs).
"""
from __future__ import annotations

import argparse
import signal
import sys
import threading
import time
import webbrowser

from . import credentials, service
from .server import App, serve


def open_ui(url, browser_only=False):
    if not browser_only:
        try:
            import webview  # pywebview: native WKWebView window on macOS
        except ImportError:
            webview = None
        if webview:
            webview.create_window("Liquid Trader", url, width=1480, height=940, min_size=(1100, 700),
                                  background_color="#0b0e14")
            webview.start()
            return True  # window closed
        print("pywebview not installed - opening in your browser (pip install pywebview for a native window)")
    threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    return False


def watchdog(app, limit=120):
    """If the engine loop ever hangs, exit so launchd/systemd/Docker restart us cleanly."""
    import os
    while True:
        time.sleep(15)
        age = time.time() - app.engine.heartbeat
        if age > limit and not app.engine._stop.is_set():
            print(f"WATCHDOG: engine loop stalled for {age:.0f}s - exiting for restart", flush=True)
            try:
                app.engine.save()
            finally:
                os._exit(3)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="liquid-trader")
    ap.add_argument("--port", type=int, default=service.DEFAULT_PORT, help="local port (default 8765)")
    ap.add_argument("--browser", action="store_true", help="open in the browser instead of a native window")
    ap.add_argument("--headless", action="store_true", help="run only the engine and server (24/7 service mode)")
    ap.add_argument("--sim-speed", type=float, default=1.0,
                    help="real seconds per simulated 1-minute candle (default 1.0)")
    ap.add_argument("--bind", default="127.0.0.1",
                    help="address to listen on (default 127.0.0.1; use 0.0.0.0 only inside Docker)")
    ap.add_argument("--connect", metavar="URL",
                    help="open a window on an engine that's already running elsewhere, e.g. through an SSH "
                         "tunnel: --connect http://127.0.0.1:18765")
    ap.add_argument("--print-daemon-plist", nargs=2, metavar=("USER", "HOME"),
                    help=argparse.SUPPRESS)  # used by mac_server_setup.sh --at-boot
    ap.add_argument("--export-credentials", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--install-service", action="store_true", help="install the macOS 24/7 background service")
    ap.add_argument("--uninstall-service", action="store_true", help="remove the macOS background service")
    args = ap.parse_args(argv)

    if args.print_daemon_plist:
        import plistlib
        sys.stdout.buffer.write(plistlib.dumps(service.daemon_plist(*args.print_daemon_plist, port=args.port)))
        return
    if args.export_credentials:
        print("exported" if credentials.export_to_file() else "none")
        return
    if args.install_service:
        print(service.install_service(args.port)); return
    if args.uninstall_service:
        print(service.uninstall_service()); return
    if args.connect:
        open_ui(args.connect.rstrip("/") + "/", args.browser)
        if args.browser:
            time.sleep(1)
        return

    data_dir = credentials.data_dir()
    if not service.acquire_lock(data_dir):
        if args.headless:
            # Another engine (usually the app window) is trading. Take over as soon as it exits.
            print("Another Liquid Trader engine is running - waiting to take over...", flush=True)
            while not service.acquire_lock(data_dir):
                time.sleep(3)
        else:
            port = service.read_port(data_dir) or args.port
            url = f"http://127.0.0.1:{port}/"
            print(f"Engine already running (24/7 service) - connecting to {url}")
            if not open_ui(url, args.browser):
                time.sleep(1)
            return

    app = App(sim_speed=args.sim_speed, headless=args.headless)
    httpd = None
    for attempt in range(20):  # the previous owner may still be releasing the port
        try:
            httpd = serve(app, args.port, args.bind)
            break
        except OSError:
            if not args.headless and attempt >= 2:
                httpd = serve(app, 0)
                break
            time.sleep(1)
    if httpd is None:
        print(f"Port {args.port} is busy", file=sys.stderr)
        sys.exit(1)
    app.httpd = httpd
    port = httpd.server_address[1]
    service.write_port(data_dir, port)
    url = f"http://127.0.0.1:{port}/"
    print(f"Liquid Trader engine running at {url}", flush=True)

    def shutdown(*_):
        app.engine.shutdown()
        try:
            httpd.shutdown()
        except Exception:
            pass
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    if args.headless:
        threading.Thread(target=watchdog, args=(app,), daemon=True, name="watchdog").start()

    if not args.headless:
        if open_ui(url, args.browser):
            # window closed: stop this engine. If the 24/7 service is installed it takes over.
            if not app.engine._stop.is_set():
                app.engine.shutdown()
            return
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        shutdown()


if __name__ == "__main__":
    main()
