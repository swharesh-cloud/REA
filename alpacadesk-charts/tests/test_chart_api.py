"""Route checks for the chart page. Skips unless Flask is installed.

The backtest and drawing routes are given mocked bars. They must not call
the Alpaca data host or any order method.
"""
import pathlib
import tempfile
import unittest
from unittest.mock import patch

class ChartSourceTests(unittest.TestCase):
    def test_chart_page_does_not_place_orders_or_select_live_trading(self):
        text = pathlib.Path(__file__).resolve().parents[1].joinpath("chart.py").read_text(encoding="utf-8")
        for name in ("submit_order", "submit_notional_buy", "cancel_order", "close_position", "api.alpaca.markets"):
            self.assertNotIn(name, text)
        self.assertNotIn("gappers", text)
        self.assertNotIn("executor", text)
        self.assertIn("https://data.alpaca.markets", text)
        self.assertIn("studies.pack", text)
        self.assertIn("studies.run_backtest", text)


try:
    from flask import Flask
    import chart
except Exception:
    chart = None
    Flask = None


@unittest.skipUnless(chart is not None, "flask is not installed")
class ChartApiTests(unittest.TestCase):
    def setUp(self):
        app = Flask(__name__)
        app.register_blueprint(chart.bp)
        self.client = app.test_client()
        self.tmp = tempfile.TemporaryDirectory()
        self.drawings = pathlib.Path(self.tmp.name) / "chart_drawings.json"
        self.draw_patch = patch.object(chart, "DRAWINGS", self.drawings)
        self.draw_patch.start()

    def tearDown(self):
        self.draw_patch.stop()
        self.tmp.cleanup()

    def _forbid_broker_io(self):
        def boom(*_args, **_kwargs):
            raise AssertionError("chart route tried to use the network or place an order")

        return (
            patch.object(chart.requests, "get", boom),
            patch.object(chart.requests, "post", boom),
            patch.object(chart.requests, "delete", boom),
            patch.object(chart.Alpaca, "submit_order", boom),
            patch.object(chart.Alpaca, "submit_notional_buy", boom),
            patch.object(chart.Alpaca, "cancel_order", boom),
            patch.object(chart.Alpaca, "close_position", boom),
        )

    def test_chart_page_renders_the_new_controls(self):
        response = self.client.get("/chart")
        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        for text in ("15 min", "1 week", "EMA 20", "Bollinger", "Run backtest", 'data-tool="trend"', "No order is sent", ">Charts<"):
            self.assertIn(text, html)
        self.assertNotIn("submit_order", html)
        self.assertNotIn("api.alpaca.markets", html)
        self.assertIn("/static/lightweight-charts.standalone.production.js", html)

    def test_backtest_uses_mocked_bars_and_does_not_place_orders(self):
        bars = [{"time": index, "open": 10.0, "high": 11.0, "low": 9.0, "close": 10.0 + index, "volume": 1}
                for index in range(6)]
        guards = self._forbid_broker_io()
        for guard in guards:
            guard.start()
        try:
            with patch.object(chart, "_load_bars", return_value=(bars, "iex")) as load:
                response = self.client.post("/api/chart/backtest", json={
                    "symbol": "SPY",
                    "tf": "1D",
                    "strategy": "sma",
                    "fast": 2,
                    "slow": 3,
                    "fee_bps": 0,
                    "slippage_bps": 0,
                    "initial_capital": 1000,
                })
        finally:
            for guard in guards:
                guard.stop()
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["symbol"], "SPY")
        self.assertEqual(body["feed"], "iex")
        self.assertEqual(load.call_count, 1)
        self.assertIn("max_drawdown", body)
        self.assertIn("win_rate", body)
        self.assertIn("equity", body)
        self.assertEqual(body["bar_count"], 6)

    def test_bad_backtest_inputs_do_not_place_orders(self):
        guards = self._forbid_broker_io()
        for guard in guards:
            guard.start()
        try:
            with patch.object(chart, "_load_bars", return_value=([], "iex")):
                response = self.client.post("/api/chart/backtest", json={
                    "symbol": "SPY", "tf": "1D", "strategy": "breakout"})
        finally:
            for guard in guards:
                guard.stop()
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.get_json()["ok"])

    def test_drawings_round_trip_without_touching_config(self):
        guards = self._forbid_broker_io()
        for guard in guards:
            guard.start()
        try:
            rejected = self.client.post("/api/chart/drawings", json={
                "symbol": "SPY", "drawings": [{"kind": "hline", "price": "high"}]})
            saved = self.client.post("/api/chart/drawings", json={
                "symbol": "SPY",
                "drawings": [
                    {"kind": "hline", "price": 100},
                    {"kind": "trend", "a": {"time": 20, "price": 5}, "b": {"time": 10, "price": 6}},
                ],
            })
            loaded = self.client.get("/api/chart/drawings?symbol=SPY")
            cleared = self.client.post("/api/chart/drawings", json={"symbol": "AAPL", "drawings": []})
        finally:
            for guard in guards:
                guard.stop()
        self.assertEqual(rejected.status_code, 400)
        self.assertEqual(saved.status_code, 200)
        drawings = saved.get_json()["drawings"]
        self.assertEqual(drawings[0]["kind"], "hline")
        self.assertEqual(drawings[1]["a"]["time"], 10)
        self.assertEqual(drawings[1]["b"]["time"], 20)
        self.assertEqual(loaded.get_json()["drawings"], drawings)
        self.assertEqual(cleared.status_code, 200)
        self.assertTrue(self.drawings.is_file())
        self.assertNotIn("config.json", str(self.drawings))


if __name__ == "__main__":
    unittest.main()
