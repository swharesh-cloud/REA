"""Offline indicator and backtest checks. No network and no broker."""
import datetime as dt
import math
import pathlib
import unittest

import studies


def near(testcase, actual, expected, epsilon=1e-8):
    testcase.assertIsNotNone(actual)
    testcase.assertTrue(math.isfinite(actual))
    testcase.assertLessEqual(abs(actual - expected), epsilon, "%s != %s" % (actual, expected))


def flat(time, price, **extras):
    opened = extras.get("open", price)
    close = extras.get("close", price)
    return {
        "time": time,
        "open": opened,
        "high": extras.get("high", max(opened, close)),
        "low": extras.get("low", min(opened, close)),
        "close": close,
        "volume": extras.get("volume", 1),
    }


def utc(year, month, day, hour=0, minute=0):
    return int(dt.datetime(year, month, day, hour, minute, tzinfo=dt.timezone.utc).timestamp())


class SmaTests(unittest.TestCase):
    def test_trailing_window_stays_empty_until_full(self):
        result = studies.sma([1, 2, 3, 4, 5], 3)
        self.assertEqual(result[:2], [None, None])
        near(self, result[2], 2)
        near(self, result[3], 3)
        near(self, result[4], 4)

    def test_short_series_is_all_none(self):
        self.assertEqual(studies.sma([1, 2], 5), [None, None])

    def test_whole_float_period_is_accepted_and_other_periods_are_not(self):
        result = studies.sma([1, 2, 3, 4, 5], 3.0)
        near(self, result[2], 2)
        with self.assertRaises(ValueError):
            studies.sma([1, 2, 3], 1.5)
        with self.assertRaises(ValueError):
            studies.sma([1, 2, 3], True)
        with self.assertRaises(ValueError):
            studies.sma([1, 2, 3], 0)


class EmaTests(unittest.TestCase):
    def test_sma_seed_then_multiplier(self):
        result = studies.ema([10, 11, 12, 13], 3)
        self.assertIsNone(result[0])
        self.assertIsNone(result[1])
        near(self, result[2], 11)
        near(self, result[3], 12)

    def test_period_one_tracks_the_series(self):
        self.assertEqual(studies.ema([4, 7, 2], 1), [4, 7, 2])


class RsiTests(unittest.TestCase):
    def test_wilder_smoothing(self):
        result = studies.rsi([10, 11, 12, 11, 13], 3)
        self.assertEqual(result[:3], [None, None, None])
        near(self, result[3], 100 - 100 / 3)
        near(self, result[4], 100 - 100 / 6)

    def test_all_gains_are_100(self):
        near(self, studies.rsi([1, 2, 3, 4], 3)[3], 100)

    def test_too_few_changes_stay_none(self):
        self.assertTrue(all(value is None for value in studies.rsi([1, 2, 3], 14)))


class MacdTests(unittest.TestCase):
    def test_line_signal_and_histogram(self):
        result = studies.macd(list(range(1, 11)), 3, 5, 3)
        self.assertIsNone(result["macd"][3])
        near(self, result["macd"][4], 1)
        near(self, result["macd"][9], 1)
        self.assertIsNone(result["signal"][5])
        near(self, result["signal"][6], 1)
        near(self, result["histogram"][6], 0)
        near(self, result["histogram"][9], 0)

    def test_fast_must_be_shorter_than_slow(self):
        with self.assertRaises(ValueError):
            studies.macd([1, 2, 3, 4, 5], 5, 5, 3)


class BollingerTests(unittest.TestCase):
    def test_population_standard_deviation(self):
        result = studies.bollinger([10, 12, 14], 3, 2)
        deviation = math.sqrt(8 / 3)
        near(self, result["middle"][2], 12)
        near(self, result["upper"][2], 12 + 2 * deviation)
        near(self, result["lower"][2], 12 - 2 * deviation)
        near(self, result["upper"][2] - result["middle"][2], result["middle"][2] - result["lower"][2])

    def test_zero_multiplier_collapses_to_the_mean(self):
        result = studies.bollinger([2, 4, 6], 3, 0)
        near(self, result["upper"][2], 4)
        near(self, result["lower"][2], 4)


class VwapTests(unittest.TestCase):
    def test_intraday_resets_on_the_new_york_date(self):
        bars = [
            {"time": utc(2024, 1, 1, 15), "high": 3, "low": 1, "close": 2, "volume": 10},
            {"time": utc(2024, 1, 2, 4), "high": 5, "low": 3, "close": 4, "volume": 10},
            {"time": utc(2024, 1, 2, 5), "high": 9, "low": 3, "close": 6, "volume": 5},
        ]
        result = studies.vwap(bars, "5m")
        near(self, result[0], 2)
        near(self, result[1], 3)
        near(self, result[2], 6)

    def test_zero_volume_does_not_move_the_running_vwap(self):
        bars = [
            {"time": utc(2024, 1, 1, 15), "high": 3, "low": 1, "close": 2, "volume": 10},
            {"time": utc(2024, 1, 1, 15, 1), "high": 100, "low": 0, "close": 50, "volume": 0},
        ]
        result = studies.vwap(bars, "1H")
        near(self, result[0], 2)
        near(self, result[1], 2)

    def test_daily_vwap_accumulates_across_new_york_dates(self):
        bars = [
            {"time": utc(2024, 1, 1), "high": 3, "low": 1, "close": 2, "volume": 10},
            {"time": utc(2024, 1, 2), "high": 5, "low": 3, "close": 4, "volume": 10},
        ]
        result = studies.vwap(bars, "1D")
        near(self, result[0], 2)
        near(self, result[1], 3)
        self.assertEqual(studies.pack(bars, "1D")["vwap_label"], "Cumulative VWAP")
        self.assertEqual(studies.pack(bars, "15m")["vwap_label"], "Session VWAP")

    def test_volume_keeps_zero_and_drops_non_finite(self):
        self.assertEqual(studies.volumes([
            {"volume": 12},
            {"volume": float("nan")},
            {"volume": 0},
            {"volume": True},
        ]), [12.0, None, 0.0, None])


class PackTests(unittest.TestCase):
    def test_every_series_matches_the_bar_count(self):
        bars = [flat(index, 10 + index, volume=index + 1) for index in range(30)]
        packed = studies.pack(bars, "1H")
        for key, value in packed.items():
            if key == "vwap_label":
                continue
            self.assertEqual(len(value), len(bars), key)


class DrawdownTests(unittest.TestCase):
    def test_peak_to_trough(self):
        near(self, studies.max_drawdown([100, 80, 130, 90]), 40 / 130)

    def test_flat_or_empty(self):
        near(self, studies.max_drawdown([10, 11, 12]), 0)
        near(self, studies.max_drawdown([5]), 0)
        self.assertIsNone(studies.max_drawdown([]))


class FillTests(unittest.TestCase):
    def test_fills_the_next_open_and_not_the_signal_bar(self):
        bars = [
            flat(0, 10),
            flat(1, 50, open=10, close=50),
            flat(2, 20),
            flat(3, 20),
            flat(4, 30),
        ]
        result = studies.simulate_fills(bars, [0, 1, 1, 0, 0], initial_capital=1000)
        self.assertEqual(result["trade_count"], 1)
        near(self, result["trades"][0]["entry_price"], 20)
        near(self, result["trades"][0]["exit_price"], 30)
        near(self, result["final_equity"], 1500)
        near(self, result["return"], 0.5)
        self.assertEqual(result["win_rate"], 1)
        self.assertFalse(result["open_position"])

    def test_last_bar_signal_does_not_open(self):
        result = studies.simulate_fills(
            [flat(0, 10), flat(1, 12), flat(2, 14)],
            [0, 0, 1],
            initial_capital=1000,
        )
        self.assertEqual(result["trade_count"], 0)
        self.assertIsNone(result["win_rate"])
        self.assertFalse(result["open_position"])
        near(self, result["final_equity"], 1000)
        near(self, result["return"], 0)
        near(self, result["max_drawdown"], 0)

    def test_open_position_is_marked_and_excluded_from_win_rate(self):
        result = studies.simulate_fills(
            [flat(0, 10), flat(1, 15, open=10, close=15)],
            [1, 1],
            initial_capital=100,
        )
        self.assertEqual(result["trade_count"], 0)
        self.assertIsNone(result["win_rate"])
        self.assertTrue(result["open_position"])
        near(self, result["final_equity"], 150)
        near(self, result["return"], 0.5)

    def test_fees_on_entry_and_exit_can_turn_a_higher_exit_into_a_loss(self):
        bars = [flat(0, 10), flat(1, 10), flat(2, 12)]
        paid = studies.simulate_fills(bars, [1, 0, 0], fee_bps=1000, initial_capital=1000)
        free = studies.simulate_fills(bars, [1, 0, 0], fee_bps=0, initial_capital=1000)
        near(self, free["final_equity"], 1200)
        near(self, paid["final_equity"], 972)
        self.assertLess(paid["final_equity"], free["final_equity"])
        self.assertEqual(paid["win_rate"], 0)
        self.assertEqual(paid["trade_count"], 1)
        near(self, paid["trades"][0]["pnl"], -28)

    def test_slippage_buys_higher_and_sells_lower(self):
        result = studies.simulate_fills(
            [flat(0, 10), flat(1, 10), flat(2, 12)],
            [1, 0, 0],
            slippage_bps=1000,
            initial_capital=1000,
        )
        near(self, result["trades"][0]["entry_price"], 11)
        near(self, result["trades"][0]["exit_price"], 10.8)
        near(self, result["final_equity"], (1000 / 11) * 10.8)

    def test_fees_and_slippage_together(self):
        result = studies.simulate_fills(
            [flat(0, 10), flat(1, 10), flat(2, 12)],
            [1, 0, 0],
            fee_bps=100,
            slippage_bps=50,
            initial_capital=10000,
        )
        entry = 10 * 1.005
        exit_price = 12 * 0.995
        spend = 10000 * 0.99
        shares = spend / entry
        cash = shares * exit_price * 0.99
        near(self, result["trades"][0]["entry_price"], entry)
        near(self, result["trades"][0]["exit_price"], exit_price)
        near(self, result["final_equity"], cash)

    def test_unrealized_drawdown_while_open(self):
        bars = [
            flat(0, 10),
            flat(1, 10),
            flat(2, 10),
            flat(3, 5, open=10, close=5),
            flat(4, 10, open=5, close=10),
            flat(5, 10),
        ]
        result = studies.simulate_fills(bars, [0, 1, 1, 1, 0, 0], initial_capital=100)
        near(self, result["trades"][0]["entry_price"], 10)
        near(self, result["trades"][0]["exit_price"], 10)
        near(self, result["final_equity"], 100)
        near(self, result["max_drawdown"], 0.5)
        self.assertEqual(result["win_rate"], 0)
        marked = [point["equity"] for point in result["equity"]]
        near(self, marked[3], 50)
        self.assertEqual(result["max_drawdown"], studies.max_drawdown(marked))

    def test_win_rate_counts_only_round_trips_that_increase_cash(self):
        result = studies.simulate_fills(
            [flat(0, 10), flat(1, 10), flat(2, 12), flat(3, 12), flat(4, 10)],
            [1, 0, 1, 0, 0],
            initial_capital=100,
        )
        self.assertEqual(result["trade_count"], 2)
        self.assertGreater(result["trades"][0]["pnl"], 0)
        self.assertLess(result["trades"][1]["pnl"], 0)
        near(self, result["win_rate"], 0.5)
        near(self, result["final_equity"], 100)
        near(self, result["max_drawdown"], 20 / 120)

    def test_fee_and_capital_bounds(self):
        bars = [flat(0, 10)]
        with self.assertRaises(ValueError):
            studies.simulate_fills(bars, [0], fee_bps=-1)
        with self.assertRaises(ValueError):
            studies.simulate_fills(bars, [0], initial_capital=0)
        with self.assertRaises(ValueError):
            studies.simulate_fills(bars, [0], fee_bps=10001)
        with self.assertRaises(ValueError):
            studies.simulate_fills(bars, [0], slippage_bps=10001)
        with self.assertRaises(ValueError):
            studies.simulate_fills(bars, [0], fee_bps=True)


class StrategyTests(unittest.TestCase):
    def test_sma_cross_is_long_only_when_fast_is_above_slow(self):
        prices = [10, 10, 10, 11, 13, 16, 14, 12, 11]
        bars = [flat(index, price) for index, price in enumerate(prices)]
        self.assertEqual(studies.signals_sma_cross(bars, 2, 3), [0, 0, 0, 1, 1, 1, 1, 0, 0])
        result = studies.run_backtest(bars, {
            "strategy": "sma",
            "fast": 2,
            "slow": 3,
            "fee_bps": 0,
            "slippage_bps": 0,
            "initial_capital": 1300,
        })
        self.assertEqual(result["trade_count"], 1)
        near(self, result["trades"][0]["entry_price"], 13)
        near(self, result["trades"][0]["exit_price"], 11)
        near(self, result["final_equity"], 1100)
        near(self, result["return"], -200 / 1300)
        near(self, result["max_drawdown"], 500 / 1600)
        self.assertEqual(result["win_rate"], 0)
        self.assertIn("does not place orders", result["assumptions"])

    def test_sma_cross_fee_reduces_the_same_trade(self):
        prices = [10, 10, 10, 11, 13, 16, 14, 12, 11]
        bars = [flat(index, price) for index, price in enumerate(prices)]
        result = studies.run_backtest(bars, {
            "strategy": "sma",
            "fast": 2,
            "slow": 3,
            "fee_bps": 100,
            "slippage_bps": 0,
            "initial_capital": 1300,
        })
        near(self, result["final_equity"], 1078.11)
        self.assertLess(result["final_equity"], 1100)

    def test_rsi_hysteresis(self):
        bars = [
            flat(0, 10),
            flat(1, 9, open=10, close=9),
            flat(2, 8, open=20, close=8),
            flat(3, 11, open=21, close=11),
            flat(4, 12, open=30, close=12),
        ]
        result = studies.run_backtest(bars, {
            "strategy": "rsi",
            "period": 1,
            "oversold": 30,
            "overbought": 70,
            "fee_bps": 0,
            "slippage_bps": 0,
            "initial_capital": 100,
        })
        self.assertEqual(result["trade_count"], 1)
        near(self, result["trades"][0]["entry_price"], 20)
        near(self, result["trades"][0]["exit_price"], 30)
        near(self, result["final_equity"], 150)
        near(self, result["return"], 0.5)
        near(self, result["max_drawdown"], 0.6)
        self.assertEqual(result["win_rate"], 1)

    def test_rejects_bad_strategy_inputs(self):
        bars = [flat(0, 1), flat(1, 1)]
        with self.assertRaises(ValueError):
            studies.run_backtest(bars, {"strategy": "rsi", "oversold": 80, "overbought": 20})
        with self.assertRaises(ValueError):
            studies.run_backtest(bars, {"strategy": "breakout"})
        with self.assertRaises(ValueError):
            studies.run_backtest(bars, {"strategy": "sma", "fast": 5, "slow": 5})


class IsolationTests(unittest.TestCase):
    def test_module_does_not_import_the_broker_or_flask(self):
        lines = pathlib.Path(studies.__file__).read_text(encoding="utf-8").lower().splitlines()
        imports = [line.strip() for line in lines if line.strip().startswith(("import ", "from "))]
        joined = "\n".join(imports)
        self.assertNotIn("broker", joined)
        self.assertNotIn("flask", joined)
        self.assertNotIn("submit_order", "\n".join(lines))
        self.assertNotIn("submit_notional_buy", "\n".join(lines))


if __name__ == "__main__":
    unittest.main()
