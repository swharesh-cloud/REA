import math
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import builder

CT = builder.CT


def bar(day, hm, o, h, l, c, v=1000):
    hh, mm = (int(x) for x in hm.split(":"))
    y, m, d = (int(x) for x in day.split("-"))
    when = datetime(y, m, d, hh, mm, tzinfo=CT)
    return {"t": when.isoformat(), "o": o, "h": h, "l": l, "c": c, "v": v}


def test_sma_and_ema_match_the_seeded_formula():
    closes_bars = [bar("2026-10-05", f"{8 + i // 12:02d}:{(i % 12) * 5:02d}", n, n, n, n) for i, n in enumerate(range(1, 8))]
    # 08:00 is before the default concern; values are what matter.
    values = builder.evaluate_series(closes_bars, "5m", "sma(3)")
    assert values[1] is None
    assert values[2] == 2
    assert values[3] == 3
    ema = builder.evaluate_series(closes_bars, "5m", "ema(3)")
    # seed at index 2 is the SMA 2; multiplier 0.5
    assert ema[2] == 2
    assert ema[3] == 3  # (4 - 2) * 0.5 + 2
    assert ema[4] == 4  # (5 - 3) * 0.5 + 3


def test_rsi_wilder_seed():
    bars = [bar("2026-10-05", "09:30", c, c, c, c) for c in (10, 11, 10, 12)]
    # rebuild clocks so they stay ordered
    for i, item in enumerate(bars):
        item["t"] = datetime(2026, 10, 5, 9, 30 + i, tzinfo=CT).isoformat()
    out = builder.evaluate_series(bars, "5m", "rsi(3)")
    assert out[3] == 75


def test_atr_wilder():
    bars = [
        bar("2026-10-05", "09:30", 9, 10, 8, 9),
        bar("2026-10-05", "09:35", 10, 11, 9, 10),
        bar("2026-10-05", "09:40", 9, 12, 8, 9),
    ]
    frame = builder.prepare(bars, "5m")
    values = builder.atr(frame.bars, 2)
    assert values[0] is None
    assert values[1] == 2
    assert values[2] == 3


def test_bollinger_uses_population_deviation():
    bars = [bar("2026-10-05", "09:30", 1, 1, 1, 1),
            bar("2026-10-05", "09:35", 2, 2, 2, 2),
            bar("2026-10-05", "09:40", 3, 3, 3, 3)]
    mid, upper, lower = builder.bollinger([1, 2, 3], 3, 2)
    dev = math.sqrt(2 / 3)
    assert mid[2] == 2
    assert upper[2] == 2 + 2 * dev
    assert lower[2] == 2 - 2 * dev
    got = builder.evaluate_series(bars, "5m", "bb_upper(3, 2)")
    assert got[2] == upper[2]


def test_macd_is_fast_ema_minus_slow_ema():
    closes = [float(i) for i in range(1, 40)]
    bars = []
    for i, c in enumerate(closes):
        bars.append(bar("2026-10-05", "09:30", c, c, c, c))
        bars[-1]["t"] = datetime(2026, 10, 5, 9, 30, tzinfo=CT).isoformat().replace("09:30:00", f"{9 + (30 + i) // 60:02d}:{(30 + i) % 60:02d}:00")
    line, signal, hist = builder.macd_lines(closes, 3, 6, 3)
    fast, slow = builder.ema(closes, 3), builder.ema(closes, 6)
    for a, b, c in zip(line, fast, slow):
        if a is None:
            assert b is None or c is None
        else:
            assert a == b - c
    assert any(v is not None for v in signal)
    assert hist[-1] == line[-1] - signal[-1]


def test_vwap_resets_each_chicago_session():
    bars = [
        bar("2026-10-05", "09:30", 2, 3, 1, 2, 10),  # typical 2
        bar("2026-10-05", "09:35", 4, 5, 3, 4, 10),  # typical 4, vwap 3
        bar("2026-10-06", "09:30", 8, 9, 7, 8, 5),   # new session, typical 8
    ]
    out = builder.evaluate_series(bars, "5m", "vwap")
    assert out[0] == 2
    assert out[1] == 3
    assert out[2] == 8


def test_crosses_above_and_below():
    bars = []
    for i, c in enumerate((1, 2, 3, 2, 1)):
        bars.append(bar("2026-10-05", "09:30", c, c, c, c))
        bars[-1]["t"] = datetime(2026, 10, 5, 9, 30 + i, tzinfo=CT).isoformat()
    above = builder.evaluate_series(bars, "5m", "close crosses_above 2")
    below = builder.evaluate_series(bars, "5m", "close crosses_below 2")
    assert above == [False, False, True, False, False]
    # 3 -> 2 stays at the level; 2 -> 1 is the cross under 2.
    assert below[3] is False
    assert below[4] is True


def test_opening_range_prior_day_and_rvol5():
    bars = []
    # Two quiet days then a loud open. 08:30 bar is the first five minutes.
    for day, vol, last in (
        ("2026-10-05", 1000, 100.2),
        ("2026-10-06", 1000, 100.2),
        ("2026-10-07", 8000, 101.0),
    ):
        bars.append(bar(day, "08:30", 100, 100.4, 99.8, 100.1, vol))
        bars.append(bar(day, "08:35", 100.1, 100.3, 100.0, last, 500))
        bars.append(bar(day, "08:40", last, last + 0.2, last - 0.1, last, 500))
    frame = builder.prepare(bars, "5m")
    # Opening range is not visible on the 08:30 bar itself.
    assert frame.or_high[0] is None
    assert frame.or_high[1] == 100.4
    assert frame.or_low[1] == 99.8
    # Prior day high/low shows up on the next session.
    assert frame.prior_high[0] is None
    assert frame.prior_high[3] == 100.4
    assert frame.prior_low[3] == 99.8
    rvol5 = builder.evaluate_series(bars, "5m", "rvol5(14)")
    assert rvol5[1] is None  # no prior open
    assert rvol5[4] == 1  # day 2 vs day 1
    assert rvol5[7] == 8  # 8000 / 1000


def test_prior_day_aliases_and_cross():
    bars = [
        bar("2026-10-05", "09:30", 10, 12, 9, 11, 100),
        bar("2026-10-06", "09:30", 11, 11.5, 10.5, 11.2, 100),
        bar("2026-10-06", "09:35", 11.2, 13, 11, 12.5, 100),
    ]
    out = builder.evaluate_series(bars, "5m", "close crosses_above prior_high")
    assert out[0] is False
    assert out[1] is False  # 11.2 is not above 12
    assert out[2] is True   # 11.2 <= 12 and 12.5 > 12


def test_slower_bars_use_five_minute_opening_context():
    five = [
        bar("2026-10-05", "08:30", 50, 51, 49, 50.5, 200),
        bar("2026-10-05", "08:35", 50.5, 52, 50, 51, 100),
        bar("2026-10-06", "08:30", 50, 50.5, 49.5, 50, 100),
        bar("2026-10-06", "08:35", 50, 53, 50, 52, 100),
    ]
    slow = [
        bar("2026-10-05", "08:30", 50, 52, 49, 51, 1000),
        bar("2026-10-06", "08:30", 50, 53, 49.5, 52, 900),
    ]
    stamped = builder.attach_opening_context(slow, five)
    values = builder.evaluate_series(stamped, "15m", "rvol5")
    assert values[0] is None
    assert values[1] == 0.5  # 100 / 200
    or_high = builder.evaluate_series(stamped, "15m", "or_high")
    assert or_high[1] == 50.5


def test_daily_relative_volume():
    bars = []
    for i, vol in enumerate((100, 100, 300)):
        day = f"2026-10-{5 + i:02d}"
        bars.append({"t": datetime(2026, 10, 5 + i, tzinfo=CT).isoformat(), "o": 10, "h": 11, "l": 9, "c": 10, "v": vol})
    out = builder.evaluate_series(bars, "1d", "rvol(20)")
    assert out[0] is None
    assert out[1] == 1
    assert out[2] == 3
