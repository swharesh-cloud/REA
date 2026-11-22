import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import builder

CT = builder.CT


def bar(day, hm, o, h, l, c, v=1000):
    hh, mm = (int(x) for x in hm.split(":"))
    y, m, d = (int(x) for x in day.split("-"))
    return {"t": datetime(y, m, d, hh, mm, tzinfo=CT).isoformat(), "o": o, "h": h, "l": l, "c": c, "v": v}


def test_long_take_profit_uses_the_next_open_not_the_signal_close():
    bars = [
        bar("2026-10-05", "09:30", 12, 12, 12, 12),   # signal: close > 10
        bar("2026-10-05", "09:35", 10, 10.2, 9.95, 10.05),  # fill 10, tp 10.10
    ]
    result = builder.run_backtest(
        "long when close > 10\ntake profit 1%\nstop 5%\nsize 10%",
        {"SPY": bars},
        initial_equity=100_000,
    )
    trade = result["trades"][0]
    assert trade["entry"] == 10  # not the signal close of 12
    assert trade["reason"] == "tp"
    assert trade["exit"] == 10.10
    assert trade["qty"] == 1000
    assert trade["pnl"] == 100
    assert result["stats"]["win_rate"] == 100
    assert result["stats"]["total_pnl"] == 100
    assert result["stats"]["profit_factor"] is None
    assert result["equity"][-1]["equity"] == 100100


def test_stop_wins_when_both_levels_are_in_the_same_bar():
    bars = [
        bar("2026-10-05", "09:30", 12, 12, 12, 12),
        bar("2026-10-05", "09:35", 10, 10.5, 9.4, 10),
    ]
    result = builder.run_backtest(
        "long when close > 10\ntake profit 1%\nstop 5%\nsize 10%",
        {"SPY": bars},
    )
    trade = result["trades"][0]
    assert trade["reason"] == "stop"
    assert trade["exit"] == 9.50
    assert trade["pnl"] == -500
    assert result["stats"]["max_drawdown"] == 500
    assert result["stats"]["avg_loss"] == -500


def test_gap_through_the_stop_fills_at_the_open():
    bars = [
        bar("2026-10-05", "09:30", 9, 9, 9, 9),
        bar("2026-10-05", "09:35", 12, 12, 12, 12),          # cross above 10
        bar("2026-10-05", "09:40", 10, 10.05, 9.95, 10),     # fill at 10, stop is 9.50
        bar("2026-10-05", "09:45", 9, 9.2, 8.8, 9),          # opens through the stop
    ]
    result = builder.run_backtest(
        "long when close crosses_above 10\ntake profit 1%\nstop 5%\nsize 10%",
        {"SPY": bars},
    )
    trade = result["trades"][0]
    assert trade["reason"] == "stop"
    assert trade["exit"] == 9
    assert trade["pnl"] == -1000


def test_flat_by_exits_at_the_open():
    bars = [
        bar("2026-10-05", "09:30", 12, 12, 12, 12),
        bar("2026-10-05", "09:35", 10, 10.05, 9.95, 10),
        bar("2026-10-05", "09:40", 10.1, 10.15, 10, 10.1),
        bar("2026-10-05", "09:45", 10.5, 10.6, 10.4, 10.55),
    ]
    result = builder.run_backtest(
        "long when close > 10\nflat by 09:45\ntake profit 10%\nstop 10%\nsize 10%",
        {"SPY": bars},
    )
    trade = result["trades"][0]
    assert trade["reason"] == "flat"
    assert trade["exit"] == 10.5
    assert trade["pnl"] == 500


def test_max_trades_per_day_is_across_symbols_and_alphabetical():
    def path(close0):
        return [
            bar("2026-10-05", "09:30", close0, close0, close0, close0),
            bar("2026-10-05", "09:35", 10, 10.2, 9.95, 10.05),
        ]
    result = builder.run_backtest(
        "long when close > 10\nmax trades 1\ntake profit 1%\nstop 5%\nsize 10%",
        {"ZZZ": path(12), "AAA": path(12)},
    )
    assert [row["symbol"] for row in result["trades"]] == ["AAA"]
    assert result["stats"]["trades"] == 1


def test_mood_blocks_a_long_on_risk_off_only_when_asked():
    bars = [
        bar("2026-10-05", "09:30", 12, 12, 12, 12),
        bar("2026-10-05", "09:35", 10, 10.2, 9.95, 10),
    ]
    script = "long when close > 10\nrespect market mood\ntake profit 1%\nstop 5%"
    blocked = builder.run_backtest(script, {"SPY": bars}, mood={"2026-10-05": "RISK-OFF"})
    assert blocked["trades"] == []
    allowed = builder.run_backtest(script, {"SPY": bars}, mood={"2026-10-05": "RISK-ON"})
    assert len(allowed["trades"]) == 1
    neutral = builder.run_backtest(
        "long when close > 10\nignore mood\ntake profit 1%\nstop 5%",
        {"SPY": bars},
        mood={"2026-10-05": "RISK-OFF"},
    )
    assert len(neutral["trades"]) == 1
    missing = builder.run_backtest(script, {"SPY": bars}, mood={"2026-10-06": "RISK-ON"})
    assert missing["trades"] == []


def test_energy_symbol_is_excluded_without_excluded_py():
    bars = [
        bar("2026-10-05", "09:30", 12, 12, 12, 12),
        bar("2026-10-05", "09:35", 10, 10.2, 9.95, 10),
    ]
    result = builder.run_backtest("long when close > 10", {"XOM": bars, "SPY": bars})
    assert builder.default_sector_block("XOM")
    assert builder.default_sector_block("AAPL") is None
    assert [row["symbol"] for row in result["skipped"]] == ["XOM"]
    assert [row["symbol"] for row in result["trades"]] == ["SPY"]


def test_caller_block_list_and_short_target():
    bars = [
        bar("2026-10-05", "09:30", 8, 8, 8, 8),
        bar("2026-10-05", "09:35", 9, 9.05, 8.9, 8.95),
    ]
    result = builder.run_backtest(
        "short when close < 10\ntake profit 0.5%\nstop 2%\nsize 10%",
        {"SPY": bars, "ABC": bars},
        sector_block=lambda sym: "utilities sector" if sym == "ABC" else None,
    )
    assert result["skipped"] == [{"symbol": "ABC", "reason": "utilities sector"}]
    trade = result["trades"][0]
    tp, sl = builder.exit_levels(9, "short", 0.5, 2)
    assert trade["side"] == "short"
    assert trade["reason"] == "tp"
    assert trade["exit"] == tp
    assert sl > 9
    assert trade["pnl"] > 0


def test_win_and_loss_profit_factor():
    # Entry at 100 keeps the share count at 100 after the $100 winner, so the
    # loser is exactly -$500 and the profit factor is 0.20.
    def day(date, fill_high, fill_low):
        return [
            bar(date, "09:30", 9, 9, 9, 9),
            bar(date, "09:35", 120, 120, 120, 120),
            bar(date, "09:40", 100, fill_high, fill_low, 100),
        ]
    bars = day("2026-10-05", 101.2, 99.5) + day("2026-10-06", 100.2, 94)
    result = builder.run_backtest(
        "long when close crosses_above 10\nmax trades 1\ntake profit 1%\nstop 5%\nsize 10%",
        {"SPY": bars},
    )
    assert [row["reason"] for row in result["trades"]] == ["tp", "stop"]
    stats = result["stats"]
    assert stats["trades"] == 2
    assert stats["win_rate"] == 50
    assert stats["total_pnl"] == 100 - 500
    assert stats["avg_win"] == 100
    assert stats["avg_loss"] == -500
    assert stats["profit_factor"] == 0.2
    assert stats["final_equity"] == 100000 + 100 - 500
    assert stats["max_drawdown"] == 500


def test_end_of_data_marks_the_open_trade():
    bars = [
        bar("2026-10-05", "09:30", 12, 12, 12, 12),
        bar("2026-10-05", "09:35", 10, 10.02, 9.98, 10.01),
        bar("2026-10-05", "09:40", 10.2, 10.25, 10.1, 10.2),
    ]
    result = builder.run_backtest(
        "long when close > 10\ntake profit 10%\nstop 10%\nsize 10%",
        {"SPY": bars},
    )
    trade = result["trades"][0]
    assert trade["reason"] == "end"
    assert trade["exit"] == 10.2
    assert trade["entry"] == 10
