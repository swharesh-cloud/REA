"""Run with:  python3 -m unittest discover -s tests -v   (from the liquid-trader folder)"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from liquid_trader import api, indicators as ind  # noqa: E402
from liquid_trader.engine import Book, Bot, Context, PaperExecutor, backtest, run_tick  # noqa: E402
from liquid_trader.market import SimMarket  # noqa: E402
from liquid_trader.strategies import STRATEGIES  # noqa: E402

# Reference implementation, ported verbatim from the community Liquid client (TypeScript)
JS_SIGN = r"""
const { createHmac, createHash } = require("crypto");
function sortObjectKeys(o){ if(o===null||typeof o!=="object")return o; if(Array.isArray(o))return o.map(sortObjectKeys);
  const s={}; for(const k of Object.keys(o).sort()) s[k]=sortObjectKeys(o[k]); return s; }
const [secret, method, path, query, bodyJson, ts, nonce] = JSON.parse(process.argv[1]);
const body = bodyJson ? JSON.parse(bodyJson) : undefined;
const canonicalPath = decodeURIComponent(path).toLowerCase().replace(/\/+$/, "");
let canonicalQuery = "";
if (query) { const p = new URLSearchParams(query); canonicalQuery = new URLSearchParams([...p.entries()].sort((a,b)=>a[0].localeCompare(b[0]))).toString(); }
let bodyHash;
if (body != null && Object.keys(body).length > 0) bodyHash = createHash("sha256").update(JSON.stringify(sortObjectKeys(body))).digest("hex");
else bodyHash = createHash("sha256").update("").digest("hex");
const payload = [ts, nonce, method.toUpperCase(), canonicalPath, canonicalQuery, bodyHash].join("\n");
process.stdout.write(createHmac("sha256", secret).update(payload).digest("hex"));
"""


class SigningTest(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "node not installed")
    def test_matches_reference_client(self):
        cases = [
            ("GET", "/v1/markets", "", None),
            ("GET", "/v1/markets/BTC-PERP/candles", "interval=5m&limit=100&end=17&start=3", None),
            ("POST", "/v1/orders", "", {"symbol": "BTC-PERP", "side": "buy", "size": 100.0, "type": "market", "leverage": 3}),
            ("POST", "/v1/orders", "", {"type": "limit", "symbol": "ETH-PERP", "side": "sell", "size": 25.5, "price": 3550.25, "tp": 3000.0}),
            ("POST", "/v1/positions/SOL-PERP/close", "", {}),
            ("DELETE", "/v1/orders/abc123/", "", None),
        ]
        for method, path, query, body in cases:
            body_str = api.canonical_body(body)
            py = api.sign("s3cret", method, path, query, body_str, "1700000000000", "deadbeef")
            arg = json.dumps(["s3cret", method, path, query, json.dumps(body) if body is not None else "", "1700000000000", "deadbeef"])
            js = subprocess.run(["node", "-e", JS_SIGN, arg], capture_output=True, text=True, check=True).stdout
            self.assertEqual(py, js, f"{method} {path} {body}")

    def test_body_serialization_like_js(self):
        self.assertEqual(api.canonical_body({"b": 100.0, "a": 1.5}), '{"a":1.5,"b":100}')
        self.assertIsNone(api.canonical_body({}))


class IndicatorTest(unittest.TestCase):
    def test_sma_ema_rsi(self):
        v = [float(i) for i in range(1, 31)]
        self.assertEqual(ind.sma(v, 3)[2], 2.0)
        self.assertIsNone(ind.sma(v, 3)[1])
        self.assertAlmostEqual(ind.ema(v, 5)[4], 3.0)
        self.assertEqual(ind.rsi(v, 14)[-1], 100.0)  # monotonic rise
        down = list(reversed(v))
        self.assertAlmostEqual(ind.rsi(down, 14)[-1], 0.0)

    def test_bollinger_macd(self):
        v = [10.0] * 30
        m, u, l = ind.bollinger(v, 20)
        self.assertEqual((m[-1], u[-1], l[-1]), (10.0, 10.0, 10.0))
        line, sig, hist = ind.macd([float(i) for i in range(60)])
        self.assertIsNotNone(hist[-1])


class BookTest(unittest.TestCase):
    def test_long_round_trip(self):
        b = Book(1000)
        b.apply("buy", 1, 100, 0)
        b.apply("buy", 1, 110, 0)
        self.assertAlmostEqual(b.entry, 105)
        pnl = b.apply("sell", 2, 120, 0)
        self.assertAlmostEqual(pnl, 30)
        self.assertEqual(b.size, 0)
        self.assertAlmostEqual(b.equity(120), 1030)

    def test_flip_and_short(self):
        b = Book(1000)
        b.apply("buy", 1, 100, 0)
        b.apply("sell", 3, 90, 0)  # close long at -10, open 2 short at 90
        self.assertAlmostEqual(b.realized, -10)
        self.assertAlmostEqual(b.size, -2)
        self.assertAlmostEqual(b.entry, 90)
        self.assertAlmostEqual(b.unrealized(80), 20)


def bars_from(prices, step=60_000):
    return [{"t": i * step, "o": p, "h": p * 1.001, "l": p * 0.999, "c": p, "v": 1} for i, p in enumerate(prices)]


class StrategyTest(unittest.TestCase):
    def test_every_strategy_backtests_on_sim_data(self):
        sim = SimMarket(seed=1, history=4000)
        bars = sim.candles("BTC-PERP", "5m", 700)
        for key in STRATEGIES:
            r = backtest(key, {}, bars, "5m", budget=1000, leverage=2)
            self.assertEqual(len(r["equity_curve"]), len(bars), key)
            self.assertGreater(r["final_equity"], 0, key)
            for f in r["fills"]:
                if f["pnl"] == 0:  # opening orders must respect budget x leverage (closes may be larger after gains)
                    self.assertLessEqual(f["usd"], 2000 * 1.01, f"{key} exceeded max notional")

    def test_ma_cross_trades_trend(self):
        prices = [100 - i * 0.5 for i in range(40)] + [80 + i for i in range(40)]
        r = backtest("ma_cross", {"fast": 3, "slow": 8}, bars_from(prices), "1m", budget=1000)
        self.assertGreaterEqual(r["trades"], 1)
        self.assertEqual(r["fills"][0]["side"], "buy")
        self.assertGreater(r["return_pct"], 0)

    def test_grid_buys_dips_and_sells_rallies(self):
        prices = [100, 99, 98, 97, 98, 99, 100, 101, 100, 99, 100]
        r = backtest("grid", {"lower": 95, "upper": 105, "levels": 11}, bars_from(prices), "1m", budget=1000)
        sides = [f["side"] for f in r["fills"]]
        self.assertIn("buy", sides)
        self.assertIn("sell", sides)
        self.assertGreater(r["return_pct"], 0)

    def test_grid_recenters_when_price_trends_away(self):
        prices = [100 + i * 0.5 for i in range(30)]  # +15% trend, far outside a ±3% grid
        bot = Bot({"strategy": "grid", "symbol": "X", "interval": "1m", "budget": 1000})
        bars = bars_from(prices)
        for i in range(len(bars)):
            run_tick(bot, bars[i]["c"], bars[: i + 1], bars[i]["t"] + 60_000, PaperExecutor(), {})
        g = bot.state["grid"]
        self.assertTrue(g[0] <= prices[-1] <= g[-1], "grid should follow price")

    def test_stop_loss_closes(self):
        prices = [100] * 5 + [94]
        bot = Bot({"strategy": "dca", "symbol": "X", "interval": "1m", "budget": 1000, "stop_loss_pct": 5,
                   "params": {"amount": 100}})
        bars = bars_from(prices)
        for i in range(len(bars)):
            run_tick(bot, bars[i]["c"], bars[: i + 1], bars[i]["t"] + 60_000, PaperExecutor(), {})
        reasons = [t["reason"] for t in bot.trades]
        self.assertTrue(any("stop-loss" in r for r in reasons), reasons)

    def test_order_clamped_to_budget(self):
        bot = Bot({"strategy": "dca", "symbol": "X", "interval": "1m", "budget": 100, "leverage": 2})
        ctx = Context(bot, 50.0, [], 0, PaperExecutor(), {"max_order_usd": 1e9})
        fill = ctx.buy_usd(10_000, "big")
        self.assertLessEqual(fill["usd"], 200 * 1.001)
        self.assertIsNone(ctx.buy_usd(500, "no room"))

    def test_bad_params_rejected(self):
        with self.assertRaises(ValueError):
            STRATEGIES["ma_cross"]({"fast": 30, "slow": 10})


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = tempfile.mkdtemp()
        os.environ["HOME"] = cls.home
        for k in ("LIQUID_API_KEY", "LIQUID_API_SECRET"):
            os.environ.pop(k, None)
        from liquid_trader.server import App, serve
        cls.app = App(sim_speed=0.05)
        cls.httpd = serve(cls.app, 0)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.app.engine.shutdown()
        shutil.rmtree(cls.home, ignore_errors=True)

    def call(self, method, path, body=None, token=True, host=None):
        req = urllib.request.Request(self.base + "/api/" + path, method=method,
                                     data=json.dumps(body).encode() if body is not None else None)
        if token:
            req.add_header("X-Token", self.app.token)
        if host:
            req.add_header("Host", host)
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_auth_and_host_checks(self):
        self.assertEqual(self.call("GET", "status", token=False)[0], 401)
        self.assertEqual(self.call("GET", "status", host="evil.example")[0], 403)
        self.assertEqual(self.call("GET", "status")[0], 200)

    def test_market_endpoints(self):
        code, ms = self.call("GET", "markets")
        self.assertEqual(code, 200)
        self.assertTrue(any(m["symbol"] == "BTC-PERP" for m in ms))
        code, c = self.call("GET", "candles?symbol=ETH-PERP&interval=15m&limit=50")
        self.assertEqual(len(c["candles"]), 50)
        self.assertEqual(self.call("GET", "orderbook?symbol=BTC-PERP")[0], 200)

    def test_bot_lifecycle_and_resume(self):
        code, b = self.call("POST", "bots", {"strategy": "dca", "symbol": "BTC-PERP", "interval": "1m",
                                             "budget": 500, "params": {"amount": 20}, "start": True})
        self.assertEqual(code, 200, b)
        deadline = time.time() + 15
        while time.time() < deadline:
            _, d = self.call("GET", "bots/" + b["id"])
            if d["trades"]:
                break
            time.sleep(0.5)
        self.assertTrue(d["trades"], "DCA bot never traded")
        # simulate an app restart: saved config must remember it was running and resume it
        self.app.engine.save()
        from liquid_trader.engine import Engine
        e2 = Engine(self.app.data_dir)
        self.assertTrue(e2.bots[b["id"]].resume)
        e2.set_market(self.app.sim)
        e2.resume_bots(live_ok=False)
        self.assertTrue(e2.bots[b["id"]].running)
        # live bots refuse to start without a Liquid connection
        code, lb = self.call("POST", "bots", {"strategy": "grid", "symbol": "BTC-PERP", "mode": "live"})
        code, err = self.call("POST", f"bots/{lb['id']}/start", {"confirm_live": True})
        self.assertEqual(code, 400)
        # kill switch flattens and stops
        self.call("POST", "killswitch", {"flatten": True})
        _, d = self.call("GET", "bots/" + b["id"])
        self.assertEqual(d["status"], "stopped")
        self.assertEqual(d["position"], 0)
        self.assertEqual(self.call("POST", f"bots/{b['id']}/start", {})[0], 400)
        self.call("POST", "killswitch/reset")

    def test_backtest_endpoint(self):
        code, r = self.call("POST", "backtest", {"strategy": "rsi", "symbol": "SOL-PERP", "interval": "5m", "bars": 400})
        self.assertEqual(code, 200, r)
        self.assertIn("equity_curve", r)

    def test_manual_paper_order(self):
        code, tr = self.call("POST", "order", {"symbol": "ETH-PERP", "side": "buy", "usd": 100})
        self.assertEqual(code, 200, tr)
        _, acct = self.call("GET", "account")
        self.assertTrue(any(p["symbol"] == "ETH-PERP" for p in acct["positions"]))
        self.call("POST", "close_position", {"symbol": "ETH-PERP"})


class DurabilityTest(unittest.TestCase):
    def test_fill_is_persisted_immediately(self):
        """A crash right after a fill must not lose the bot's position (live bots depend on it)."""
        from liquid_trader.engine import Engine
        d = tempfile.mkdtemp()
        eng = Engine(d)
        eng.set_market(SimMarket(seed=3, history=500, seconds_per_bar=0.01))
        bot = eng.create_bot({"strategy": "dca", "symbol": "BTC-PERP", "interval": "1m", "budget": 500,
                              "params": {"amount": 20}})
        eng.start_bot(bot.id)
        eng._tick(bot)  # first closed bar -> DCA buys
        self.assertTrue(bot.trades)
        # read the file as a freshly restarted engine would - no shutdown/save in between
        e2 = Engine(d)
        self.assertAlmostEqual(e2.bots[bot.id].book.size, bot.book.size)
        self.assertEqual(len(e2.bots[bot.id].trades), len(bot.trades))
        self.assertTrue(e2.bots[bot.id].resume)
        shutil.rmtree(d, ignore_errors=True)


class NotifyTest(unittest.TestCase):
    def test_request_formats(self):
        from liquid_trader.notify import build_request, Notifier
        r = build_request("https://ntfy.sh/topic", "hello", "error")
        self.assertEqual(r.data, b"hello")
        self.assertEqual(r.get_header("Priority"), "5")
        r = build_request("https://discord.com/api/webhooks/1/x", "hi", "info")
        self.assertIn("content", json.loads(r.data))
        r = build_request("https://hooks.slack.com/services/x", "hi", "warn")
        self.assertIn("text", json.loads(r.data))
        n = Notifier("", "trade")
        n.send("ignored")  # no URL: must be a no-op
        self.assertTrue(n.q.empty())
        n.url = "https://example.invalid/x"
        n.min_level = "warn"
        n.send("paper fill", "paper")
        n.send("info msg", "info")
        self.assertTrue(n.q.empty())  # below threshold


class WatchdogTest(unittest.TestCase):
    def test_stalled_engine_exits_for_restart(self):
        code = ("import sys, time, types; sys.path.insert(0, %r)\n"
                "from liquid_trader import __main__ as m\n"
                "eng = types.SimpleNamespace(heartbeat=time.time() - 999, _stop=types.SimpleNamespace(is_set=lambda: False), save=lambda: None)\n"
                "m.time.sleep = lambda s: None\n"
                "m.watchdog(types.SimpleNamespace(engine=eng), limit=1)\n") % os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertIn("WATCHDOG", r.stdout)


class LockTest(unittest.TestCase):
    def test_single_instance_lock(self):
        from liquid_trader import service
        d = tempfile.mkdtemp()
        script = ("import sys; sys.path.insert(0, %r); from liquid_trader import service; "
                  "print(service.acquire_lock(%r))") % (os.path.dirname(os.path.dirname(os.path.abspath(__file__))), d)
        self.assertTrue(service.acquire_lock(d))
        out = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True).stdout.strip()
        self.assertEqual(out, "False")  # a second engine can't start trading the same bots
        service.release_lock()
        out = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True).stdout.strip()
        self.assertEqual(out, "True")
        shutil.rmtree(d, ignore_errors=True)

    def test_launchd_plist(self):
        from liquid_trader import service
        p = service.service_plist(python="/usr/bin/python3", workdir="/x")
        self.assertTrue(p["KeepAlive"])
        self.assertTrue(p["RunAtLoad"])
        self.assertEqual(p["ProgramArguments"][:3], ["/usr/bin/caffeinate", "-i", "-s"])
        self.assertIn("--headless", p["ProgramArguments"])


if __name__ == "__main__":
    unittest.main()
