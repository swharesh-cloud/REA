import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

import builder


def test_user_one_liner_uses_defaults():
    spec = builder.parse_script(
        "long when close crosses_above ema(20) and rvol5 > 5 and close > 20"
    )
    assert spec.side == "long"
    assert spec.timeframe == "5m"
    assert spec.take_profit_pct == 0.5
    assert spec.stop_pct == 2.0
    assert spec.max_trades == 1
    assert spec.respect_mood is False
    assert spec.session_start is None
    assert builder.session_bounds(spec) == ("08:30", "15:00")
    names = [s.name for s in builder.walk_series(spec.long_expr)]
    assert names == ["close", "ema", "rvol5", "close"]


def test_three_examples_parse():
    kinds = []
    for example in builder.EXAMPLES:
        spec = builder.parse_script(example["script"])
        assert spec.name == example["name"]
        kinds.append((spec.timeframe, spec.side, spec.respect_mood, spec.long_src is not None))
    assert kinds == [
        ("5m", "both", True, True),
        ("1d", "long", True, True),
        ("15m", "both", False, True),
    ]
    orb = builder.parse_script(builder.EXAMPLES[0]["script"])
    assert orb.flat_by == "14:50"
    assert orb.session_start == "08:36" and orb.session_end == "10:00"
    assert orb.price_min == 20
    assert orb.rvol5_min == 5
    assert orb.short_src.startswith("close crosses_below or_low")
    assert builder.needs_opening_context(orb) is True
    daily = builder.parse_script(builder.EXAMPLES[1]["script"])
    assert builder.session_bounds(daily) == (None, None)
    assert any(s.name == "rsi" and s.args == (14,) for s in builder.walk_series(daily.long_expr))


def test_form_round_trip_keeps_the_rule():
    src = "ema(20) > ema(50) and rsi(14) > 50 and low <= ema(20) * 1.01"
    script = builder.compile_script({
        "name": "EMA pullback",
        "timeframe": "daily",
        "side": "long",
        "max_trades": 1,
        "price_min": 5,
        "respect_mood": True,
        "take_profit_pct": 1,
        "stop_pct": 2,
        "size_pct": 10,
        "long_when": src,
    })
    spec = builder.parse_script(script)
    assert spec.long_src == src
    assert spec.timeframe == "1d"
    assert spec.take_profit_pct == 1
    assert spec.respect_mood is True
    assert spec.price_min == 5


def test_and_binds_tighter_than_or():
    spec = builder.parse_script("long when close > 10 or close > 0 and close < 0")
    expr = spec.long_expr
    assert isinstance(expr, builder.Bin) and expr.op == "or"
    assert isinstance(expr.right, builder.Bin) and expr.right.op == "and"


def test_function_and_infix_cross():
    spec = builder.parse_script(
        "long when crosses_above(close, ema(20)) or close crosses_below sma(50)"
    )
    expr = spec.long_expr
    assert isinstance(expr, builder.Bin) and expr.op == "or"
    assert isinstance(expr.left, builder.Cross) and expr.left.op == "crosses_above"
    assert isinstance(expr.right, builder.Cross) and expr.right.op == "crosses_below"


def test_aliases_and_filters():
    spec = builder.parse_script("""
        name Test
        timeframe 1h
        session 9:45-14:00 CT
        flat by 14:50
        max 3 trades
        price >= 15
        daily rvol min 1.5
        rvol5 >= 2
        size 12%
        stop-loss 1.5%
        take-profit 0.4%
        symbols spy, qqq
        short when close crosses_below pdl
    """)
    assert spec.timeframe == "1h"
    assert spec.session_start == "09:45"
    assert spec.max_trades == 3
    assert spec.rvol_min == 1.5
    assert spec.rvol5_min == 2
    assert spec.size_pct == 12
    assert spec.stop_pct == 1.5
    assert spec.side == "short"
    assert spec.symbols == ["SPY", "QQQ"]
    assert {s.name for s in builder.walk_series(spec.short_expr)} == {"close", "prior_low"}


def test_errors_name_the_line():
    with pytest.raises(builder.ParseError) as caught:
        builder.parse_script("name OK\nbuy the dip\n")
    assert caught.value.line == 2
    with pytest.raises(builder.ParseError):
        builder.parse_script("long when sma")
    with pytest.raises(builder.ParseError):
        builder.parse_script("long when __import__('os')")
    with pytest.raises(builder.ParseError):
        builder.parse_script("long when close > ")
    with pytest.raises(builder.ParseError):
        builder.parse_script("side sideways\nlong when close > 1")
    with pytest.raises(builder.ParseError):
        builder.parse_script("")


def test_comments_and_blank_lines_are_ignored():
    spec = builder.parse_script("# note\n\nlong when close > 1  # inline\n")
    assert spec.long_src == "close > 1"


def test_save_list_delete_round_trip(tmp_path):
    row = builder.save_strategy({
        "script": "name Saved\nlong when close > 20\n",
        "symbols": ["spy", "AAPL"],
    }, root=tmp_path)
    assert row["paper"] is False
    assert row["prefix"] == f"bld-{row['id']}-"
    assert row["symbols"] == ["SPY", "AAPL"]
    assert (tmp_path / "data" / "builder" / f"{row['id']}.json").is_file()
    again = builder.list_strategies(tmp_path)
    assert [item["id"] for item in again] == [row["id"]]
    on = builder.set_paper(row["id"], True, root=tmp_path)
    assert on["paper"] is True
    with pytest.raises(ValueError):
        builder.delete_strategy(row["id"], root=tmp_path)
    builder.set_paper(row["id"], False, root=tmp_path)
    builder.delete_strategy(row["id"], root=tmp_path)
    assert builder.list_strategies(tmp_path) == []


def test_symbol_list_allows_two_hundred_names():
    names = ",".join(f"S{i:03d}" for i in range(200))
    assert len(builder.parse_symbols(names)) == 200
    with pytest.raises(builder.ParseError):
        builder.parse_symbols(",".join(f"S{i:03d}" for i in range(201)))


def test_paper_requires_a_symbol(tmp_path):
    row = builder.save_strategy({"script": "long when close > 1\n"}, root=tmp_path)
    with pytest.raises(ValueError):
        builder.set_paper(row["id"], True, root=tmp_path)
