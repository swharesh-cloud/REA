"""Local HTTP server: JSON API + dashboard. Binds to 127.0.0.1 only."""
from __future__ import annotations

import json
import os
import secrets
import threading
import time
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import credentials, service
from .api import LiquidAPIError, LiquidClient
from .engine import Book, Engine, PaperExecutor, backtest, closed_bars
from .market import INTERVALS, LiquidMarket, SimMarket, interval_ms
from .strategies import STRATEGIES

STATIC = os.path.join(os.path.dirname(__file__), "static")


class App:
    def __init__(self, sim_speed=1.0, headless=False):
        self.headless = headless
        self.httpd = None
        self.token = secrets.token_urlsafe(24)
        self.data_dir = credentials.data_dir()
        self.sim = SimMarket(seconds_per_bar=sim_speed)
        self.liquid = None
        self.client = None
        self.cred_source = None
        self.conn_error = ""
        self.engine = Engine(self.data_dir)
        self.engine.set_market(self.sim)
        self.manual = {}  # simulated-mode manual desk: symbol -> Book
        self.manual_cash = 10_000.0
        self.manual_trades = []
        self.lock = threading.Lock()
        key, secret, where = credentials.load()
        if key and self.engine.settings.get("source", "liquid") == "liquid":
            self.connect(key, secret, where, switch=True, force=True)
        elif key:
            self.connect(key, secret, where, switch=False)
        self.engine.resume_bots(live_ok=bool(self.liquid) and self.market.live)
        self.engine.start()
        threading.Thread(target=self._health_loop, daemon=True, name="health").start()

    def _health_loop(self):
        """Keep re-testing the Liquid connection so the app recovers on its own after outages."""
        while True:
            time.sleep(60 if not self.conn_error else 20)
            if not self.client:
                continue
            try:
                self.client.account()
                if self.conn_error:
                    self.engine.event("Liquid connection restored", "info")
                self.conn_error = ""
                if self.market.live:
                    self.engine.resume_bots(live_ok=True)
            except LiquidAPIError as e:
                if not self.conn_error:
                    self.engine.event(f"Liquid connection problem: {e}", "warn")
                self.conn_error = str(e)
            except Exception as e:  # never let the health thread die
                self.conn_error = str(e)

    def handoff(self):
        """Hand trading over to the background service: free the port, save state, release the lock."""
        def go():
            time.sleep(0.5)  # let the HTTP response go out first
            if self.httpd:
                self.httpd.shutdown()
                self.httpd.server_close()
            self.engine.shutdown()
            service.release_lock()
            print("Handed off to the background service", flush=True)
        threading.Thread(target=go, daemon=True).start()

    @property
    def market(self):
        return self.engine.market

    def connect(self, key, secret, where, switch=True, force=False):
        """force=True switches to Liquid even if the first test fails (e.g. offline at boot);
        the health loop keeps retrying in the background."""
        client = LiquidClient(key, secret)
        self.client, self.liquid, self.cred_source = client, LiquidMarket(client), where
        try:
            client.account()
            self.conn_error = ""
        except LiquidAPIError as e:
            self.conn_error = str(e)
            if not force:
                return False
        if switch:
            self.engine.set_market(self.liquid, self.client)
            self.engine.settings["source"] = "liquid"
        return not self.conn_error

    def status(self):
        m = self.market
        return {"source": m.name, "live": m.live, "connected": bool(self.liquid and not self.conn_error),
                "has_credentials": bool(self.client), "credential_store": self.cred_source,
                "keychain": credentials.IS_MAC, "error": self.conn_error,
                "kill_switch": self.engine.kill_switch, "risk": self.engine.risk,
                "events": list(self.engine.events)[-60:], "server_time": int(time.time() * 1000),
                "uptime_s": time.time() - self.engine.started_at,
                "heartbeat_age_s": time.time() - self.engine.heartbeat,
                "service": service.service_status(), "headless": self.headless,
                "market_time": m.now_ms(), "data_dir": self.data_dir}

    # ---- account view ----
    def account(self):
        m = self.market
        if m.live:
            acct = self.client.account() or {}
            pos = self.client.positions() or []
            return {"source": "liquid", "account": acct, "positions": pos}
        positions = []
        eq = self.manual_cash
        for sym, b in self.manual.items():
            if b.size:
                p = m.price(sym)
                positions.append({"symbol": sym, "side": "long" if b.size > 0 else "short", "size": abs(b.size),
                                  "entry_price": b.entry, "mark_price": p, "leverage": "-",
                                  "unrealized_pnl": b.unrealized(p), "liquidation_price": None,
                                  "margin_used": abs(b.size) * b.entry})
            eq += b.realized - b.fees + (b.unrealized(m.price(sym)) if b.size else 0)
        used = sum(p["margin_used"] for p in positions)
        return {"source": "simulated", "account": {"equity": eq, "account_value": eq, "margin_used": used,
                                                   "available_balance": eq - used},
                "positions": positions, "trades": self.manual_trades[-50:]}

    def manual_order(self, body):
        sym, side = body["symbol"], body["side"]
        usd = float(body["usd"])
        if side not in ("buy", "sell") or usd <= 0:
            raise ValueError("Bad side or size")
        m = self.market
        if m.live:
            if not body.get("confirm"):
                raise ValueError("Live orders must be confirmed")
            if usd > self.engine.risk["max_order_usd"]:
                raise ValueError(f"Order exceeds max order size ${self.engine.risk['max_order_usd']:,.0f}")
            res = self.client.place_order(sym, side, usd, type=body.get("type", "market"),
                                          price=_opt(body.get("price")), leverage=_opt(body.get("leverage")),
                                          tp=_opt(body.get("tp")), sl=_opt(body.get("sl")))
            self.engine.event(f"Manual LIVE {side.upper()} {sym} ${usd:,.2f}")
            return res
        with self.lock:
            p = m.price(sym)
            fill = PaperExecutor().execute(sym, side, usd / p, p, 1)
            b = self.manual.setdefault(sym, Book(0))
            pnl = b.apply(side, fill["coin"], fill["price"], fill["fee"])
            tr = {"t": m.now_ms(), "symbol": sym, "side": side, "price": fill["price"], "usd": usd, "pnl": pnl}
            self.manual_trades.append(tr)
            return tr

    def close_position(self, sym):
        if self.market.live:
            return self.client.close_position(sym)
        with self.lock:
            b = self.manual.get(sym)
            if b and b.size:
                p = self.market.price(sym)
                side = "sell" if b.size > 0 else "buy"
                fill = PaperExecutor().execute(sym, side, abs(b.size), p, 1)
                pnl = b.apply(side, abs(b.size), fill["price"], fill["fee"])
                self.manual_trades.append({"t": self.market.now_ms(), "symbol": sym, "side": side,
                                           "price": fill["price"], "usd": abs(fill["coin"]) * p, "pnl": pnl})
        return {"ok": True}


def _opt(v):
    return float(v) if v not in (None, "", 0, "0") else None


def _num(qs, k, default):
    try:
        return int(qs.get(k, [default])[0])
    except ValueError:
        return default


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        server_version = "LiquidTrader"

        def log_message(self, fmt, *args):
            pass

        def _send(self, code, body, ctype="application/json"):
            data = body if isinstance(body, bytes) else json.dumps(body, default=str).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            self.wfile.write(data)

        def _host_ok(self):
            host = (self.headers.get("Host") or "").split(":")[0]
            return host in ("127.0.0.1", "localhost")

        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n > 1_000_000:
                raise ValueError("Body too large")
            return json.loads(self.rfile.read(n) or b"{}")

        def do_GET(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

        def do_DELETE(self):
            self._dispatch("DELETE")

        def _dispatch(self, method):
            if not self._host_ok():  # blocks DNS-rebinding attacks
                return self._send(403, {"error": "forbidden host"})
            url = urllib.parse.urlparse(self.path)
            path, qs = url.path, urllib.parse.parse_qs(url.query)
            if method == "GET" and path in ("/", "/index.html"):
                with open(os.path.join(STATIC, "index.html"), "rb") as f:
                    html = f.read().replace(b"__TOKEN__", app.token.encode())
                return self._send(200, html, "text/html; charset=utf-8")
            if method == "GET" and path.startswith("/static/"):
                name = os.path.basename(path)
                fp = os.path.join(STATIC, name)
                if not os.path.isfile(fp):
                    return self._send(404, {"error": "not found"})
                ctype = {"js": "text/javascript", "css": "text/css", "svg": "image/svg+xml",
                         "png": "image/png"}.get(name.rsplit(".", 1)[-1], "application/octet-stream")
                with open(fp, "rb") as f:
                    return self._send(200, f.read(), ctype)
            if not path.startswith("/api/"):
                return self._send(404, {"error": "not found"})
            # custom header => browsers must preflight cross-origin requests, which we never allow
            if not secrets.compare_digest(self.headers.get("X-Token", ""), app.token):
                return self._send(401, {"error": "bad token"})
            try:
                body = self._body() if method == "POST" else {}
                return self._send(200, route(app, method, path, qs, body))
            except KeyError as e:
                return self._send(404, {"error": f"not found: {e}"})
            except (ValueError, LiquidAPIError, RuntimeError) as e:
                return self._send(400, {"error": str(e)})
            except Exception as e:
                traceback.print_exc()
                return self._send(500, {"error": f"{type(e).__name__}: {e}"})

    return Handler


def route(app: App, method, path, qs, body):
    eng = app.engine
    parts = path.strip("/").split("/")[1:]  # drop "api"
    m = app.market
    q = lambda k, d=None: qs.get(k, [d])[0]

    if method == "GET":
        if parts == ["status"]:
            return app.status()
        if parts == ["markets"]:
            return m.markets()
        if parts == ["ticker"]:
            return m.ticker(q("symbol"))
        if parts == ["tickers"]:
            out = []
            for s in (q("symbols") or "").split(","):
                if s:
                    try:
                        out.append(m.ticker(s))
                    except Exception as e:
                        out.append({"symbol": s, "error": str(e)})
            return out
        if parts == ["candles"]:
            iv = q("interval", "5m")
            if iv not in INTERVALS:
                raise ValueError("bad interval")
            return {"candles": m.candles(q("symbol"), iv, min(_num(qs, "limit", 200), 500)),
                    "now": m.now_ms(), "interval_ms": interval_ms(iv)}
        if parts == ["orderbook"]:
            return m.orderbook(q("symbol"), min(_num(qs, "depth", 15), 50))
        if parts == ["account"]:
            return app.account()
        if parts == ["strategies"]:
            return [c.schema() for c in STRATEGIES.values()]
        if parts == ["bots"]:
            return [b.summary() for b in eng.bots.values()]
        if len(parts) == 2 and parts[0] == "bots":
            b = eng.bots[parts[1]]
            d = b.summary()
            d.update(logs=list(b.logs)[-150:], trades=list(b.trades)[-200:], equity_curve=list(b.equity_curve),
                     grid=b.state.get("grid"))
            return d

    if method == "POST":
        if parts == ["bots"]:
            b = eng.create_bot(body)
            if body.get("start"):
                eng.start_bot(b.id, confirm_live=body.get("confirm_live", False))
            return b.summary()
        if len(parts) == 3 and parts[0] == "bots":
            bid, action = parts[1], parts[2]
            if action == "start":
                eng.start_bot(bid, confirm_live=body.get("confirm_live", False))
            elif action == "stop":
                eng.stop_bot(bid)
            elif action == "close":
                eng.flatten_bot(bid)
            elif action == "reset":
                b = eng.bots[bid]
                if b.running or b.book.size:
                    raise ValueError("Stop the bot and close its position first")
                if b.mode == "live":
                    raise ValueError("Live bot history can't be reset")
                b.book, b.state = Book(b.budget), {}
                b.trades.clear(); b.equity_curve.clear(); b.peak_equity = b.budget
                b.log("reset")
            else:
                raise KeyError(action)
            return eng.bots[bid].summary()
        if parts == ["backtest"]:
            iv = body.get("interval", "15m")
            limit = int(body.get("bars", 500))
            if m.live:
                bars = m.candles(body["symbol"], iv, 200)  # Liquid serves up to 200 candles per request
            else:
                bars = m.history(body["symbol"], iv, min(limit, 5000))
            bars = closed_bars(bars, iv, m.now_ms())
            if len(bars) < 10:
                raise ValueError("Not enough candle history for this interval")
            res = backtest(body["strategy"], body.get("params", {}), bars, iv,
                           budget=float(body.get("budget", 1000)), leverage=float(body.get("leverage", 1)),
                           stop_loss_pct=float(body.get("stop_loss_pct") or 0),
                           take_profit_pct=float(body.get("take_profit_pct") or 0),
                           max_drawdown_pct=float(body.get("max_drawdown_pct") or 0), symbol=body["symbol"])
            res["candles"] = bars
            return res
        if parts == ["credentials"]:
            key, secret = (body.get("key") or "").strip(), (body.get("secret") or "").strip()
            if not key or not secret:
                raise ValueError("Enter both API key and secret")
            where = credentials.save(key, secret)
            ok = app.connect(key, secret, where, switch=True)
            if not ok:
                raise ValueError(f"Saved, but the connection test failed: {app.conn_error}")
            eng.event(f"Connected to Liquid (key stored in {where})")
            return app.status()
        if parts == ["source"]:
            src = body.get("source")
            if src == "simulated":
                eng.set_market(app.sim)
                eng.settings["source"] = "simulated"
            elif src == "liquid":
                if not app.liquid or app.conn_error:
                    raise ValueError("Connect a working Liquid API key first")
                eng.set_market(app.liquid, app.client)
                eng.settings["source"] = "liquid"
            else:
                raise ValueError("source must be simulated or liquid")
            eng.event(f"Data source → {src}")
            return app.status()
        if parts == ["order"]:
            return app.manual_order(body)
        if parts == ["close_position"]:
            return app.close_position(body["symbol"])
        if parts == ["killswitch"]:
            eng.engage_kill_switch(flatten=body.get("flatten", True))
            return app.status()
        if parts == ["killswitch", "reset"]:
            eng.kill_switch = False
            eng.event("Kill switch reset")
            return app.status()
        if parts == ["service", "install"]:
            st = service.install_service()
            if not app.headless:
                app.handoff()
            return {"service": st, "handoff": not app.headless, "port": service.DEFAULT_PORT}
        if parts == ["service", "uninstall"]:
            return {"service": service.uninstall_service()}
        if parts == ["risk"]:
            for k in ("max_order_usd", "max_total_live_usd"):
                if k in body:
                    v = float(body[k])
                    if v <= 0:
                        raise ValueError(f"{k} must be positive")
                    eng.risk[k] = v
            eng.save()
            return app.status()

    if method == "DELETE":
        if parts == ["credentials"]:
            credentials.clear()
            app.client = app.liquid = None
            app.cred_source, app.conn_error = None, ""
            eng.set_market(app.sim)
            eng.settings["source"] = "simulated"
            eng.event("API key removed; using simulated market")
            return app.status()
        if len(parts) == 2 and parts[0] == "bots":
            eng.delete_bot(parts[1])
            return {"ok": True}

    raise KeyError(path)


def serve(app: App, port: int = 0):
    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(app))
    httpd.daemon_threads = True
    t = threading.Thread(target=httpd.serve_forever, daemon=True, name="http")
    t.start()
    return httpd
