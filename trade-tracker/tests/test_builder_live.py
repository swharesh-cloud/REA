import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

import builder
import builder_data
import builder_live

CT = builder.CT


def bar(day, hm, o, h, l, c, v=1000):
    hh, mm = (int(x) for x in hm.split(":"))
    y, m, d = (int(x) for x in day.split("-"))
    return {"t": datetime(y, m, d, hh, mm, tzinfo=CT).isoformat(), "o": o, "h": h, "l": l, "c": c, "v": v}


class FakeBroker:
    mode = "paper"
    base = "https://paper-api.alpaca.markets"
    configured = True

    def __init__(self):
        self.orders = []
        self.cancelled = []
        self._positions = []
        self._open_orders = []

    def account(self):
        return {"buying_power": "100000"}

    def positions(self):
        return list(self._positions)

    def asset(self, symbol):
        return {"shortable": True, "easy_to_borrow": True, "tradable": True}

    def submit_order(self, **payload):
        self.orders.append(payload)
        return {"id": f"ord-{len(self.orders)}", "status": "new", "client_order_id": payload.get("client_order_id")}

    def cancel_order(self, oid):
        self.cancelled.append(oid)

    def _req(self, method, path, params=None, json=None):
        if method == "GET" and path == "/v2/orders":
            return list(self._open_orders)
        if method == "GET" and path.startswith("/v2/orders/"):
            return {"status": "new"}
        return {}


def _enable(tmp_path, script, symbols):
    return builder.save_strategy({"script": script, "symbols": symbols, "paper": True}, root=tmp_path)


def test_wants_cycle_is_false_until_a_strategy_is_enabled(tmp_path):
    monday = datetime(2026, 10, 5, 9, 0, tzinfo=CT)
    assert monday.weekday() == 0
    assert builder_live.wants_cycle(monday, tmp_path) is False
    assert builder_live.wants_cycle(monday.replace(hour=16), tmp_path) is False
    assert builder_live.wants_cycle(monday.replace(day=10), tmp_path) is False  # Saturday
    _enable(tmp_path, "long when close > 10\n", ["SPY"])
    assert builder_live.wants_cycle(monday, tmp_path) is True
    assert builder_live.wants_cycle(monday.replace(hour=16), tmp_path) is False


def test_payload_is_a_paper_bracket_with_its_own_prefix():
    payload = builder_live.order_payload("bld-orb-breakout-", "SPY", "long", 10, 100, 0.5, 2, 100)
    assert payload["order_class"] == "bracket"
    assert payload["side"] == "buy"
    assert payload["type"] == "market"
    assert payload["client_order_id"].startswith("bld-orb-breakout-")
    real_tp, real_sl = builder.exit_levels(100, "long", 0.5, 2)
    assert float(payload["take_profit"]["limit_price"]) > real_tp
    assert float(payload["stop_loss"]["stop_price"]) < real_sl
    with pytest.raises(RuntimeError):
        builder_live.paper_guard(type("Live", (), {"mode": "live", "base": "https://api.alpaca.markets", "configured": True})())


def test_cycle_places_one_prefixed_order_and_does_not_repeat(tmp_path, monkeypatch):
    monkeypatch.delenv("BUILDER_DEMO", raising=False)
    row = _enable(tmp_path, "name Test\nlong when close > 10\ntake profit 1%\nstop 2%\nsize 10%\n", ["SPY", "XOM"])
    bars = [
        bar("2026-10-05", "09:30", 11, 11, 11, 11),
        bar("2026-10-05", "09:35", 12, 12, 12, 12),
    ]
    broker = FakeBroker()
    now = datetime(2026, 10, 5, 9, 40, tzinfo=CT)

    def fetch(symbols, timeframe, moment):
        return {sym: bars for sym in symbols}

    first = builder_live.cycle(now=now, root=tmp_path, broker=broker, fetch=fetch)
    assert first["placed"] == ["SPY"]
    assert len(broker.orders) == 1
    order = broker.orders[0]
    assert order["symbol"] == "SPY"
    assert order["client_order_id"].startswith(row["prefix"])
    assert order["order_class"] == "bracket"
    assert not any(item["symbol"] == "XOM" for item in broker.orders)
    second = builder_live.cycle(now=now, root=tmp_path, broker=broker, fetch=fetch)
    assert second["placed"] == []
    assert len(broker.orders) == 1


def test_disabled_strategy_does_not_touch_the_broker(tmp_path, monkeypatch):
    monkeypatch.delenv("BUILDER_DEMO", raising=False)
    builder.save_strategy({"script": "long when close > 10\n", "symbols": ["SPY"], "paper": False}, root=tmp_path)
    broker = FakeBroker()
    result = builder_live.cycle(now=datetime(2026, 10, 5, 9, 40, tzinfo=CT), root=tmp_path, broker=broker, fetch=lambda *a: {})
    assert result["ran"] is False
    assert broker.orders == []


def test_kill_switch_blocks_new_entries_without_writing_it(tmp_path, monkeypatch):
    monkeypatch.delenv("BUILDER_DEMO", raising=False)
    _enable(tmp_path, "long when close > 10\n", ["SPY"])
    folder = tmp_path / "sdesk" / "state"
    folder.mkdir(parents=True)
    folder.joinpath("settings.json").write_text('{"kill_switch": true, "auto_execute": true}\n', encoding="utf-8")
    broker = FakeBroker()
    bars = [bar("2026-10-05", "09:30", 12, 12, 12, 12), bar("2026-10-05", "09:35", 12, 12, 12, 12)]
    builder_live.cycle(
        now=datetime(2026, 10, 5, 9, 40, tzinfo=CT), root=tmp_path, broker=broker,
        fetch=lambda symbols, tf, moment: {s: bars for s in symbols},
    )
    assert broker.orders == []
    assert folder.joinpath("settings.json").read_text(encoding="utf-8").startswith('{"kill_switch": true')


def test_flat_cancels_only_this_prefix(tmp_path, monkeypatch):
    monkeypatch.delenv("BUILDER_DEMO", raising=False)
    row = _enable(tmp_path, "long when close > 10\nflat by 14:50\n", ["SPY"])
    state = builder_live.load_live(tmp_path)
    state["strategies"][row["id"]] = {"days": {"2026-10-05": [{
        "symbol": "SPY", "side": "long", "qty": 10, "status": "open", "signal_time": "x", "order_id": "1",
    }]}}
    builder_live.save_live(state, tmp_path)
    broker = FakeBroker()
    broker._positions = [{"symbol": "SPY", "qty": "25"}]
    broker._open_orders = [
        {"id": "ours", "symbol": "SPY", "status": "new", "client_order_id": row["prefix"] + "SPY-in-1"},
        {"id": "theirs", "symbol": "SPY", "status": "new", "client_order_id": "orb-SPY-1"},
    ]
    builder_live.cycle(now=datetime(2026, 10, 5, 14, 50, tzinfo=CT), root=tmp_path, broker=broker, fetch=lambda *a: {})
    assert broker.cancelled == ["ours"]
    exits = [o for o in broker.orders if "exit" in o["client_order_id"]]
    assert len(exits) == 1
    assert exits[0]["qty"] == "10"  # our shares, not the other 15
    assert exits[0]["side"] == "sell"
    assert exits[0]["client_order_id"].startswith(row["prefix"])


def test_fixture_orb_backtest_has_wins_and_losses(monkeypatch):
    monkeypatch.setenv("BUILDER_FIXTURE_BARS", "1")
    spec = builder.parse_script(builder.EXAMPLES[0]["script"])
    # Mood is on in the example. With no history the engine reports that and still simulates.
    raw, feed = builder_data.fetch_bars(["SPY", "QQQ"], "5m", builder_data.FIXTURE_START, builder_data.FIXTURE_END)
    assert feed == "fixture"
    result = builder.run_backtest(spec, raw, initial_equity=100_000)
    reasons = [row["reason"] for row in result["trades"]]
    assert result["stats"]["trades"] >= 4
    assert "tp" in reasons and "stop" in reasons
    assert {row["symbol"] for row in result["trades"]} == {"SPY"}
    assert result["stats"]["max_drawdown"] > 0
    assert result["equity"][0]["equity"] == 100_000
    assert result["equity"][-1]["equity"] == result["stats"]["final_equity"]


def test_bar_cache_round_trip(tmp_path, monkeypatch):
    monkeypatch.setenv("BUILDER_ROOT", str(tmp_path))
    rows = [{"t": "2026-10-05T14:30:00Z", "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10}]
    builder_data.write_cache("iex", "5m", "start", "end", "SPY", rows)
    assert builder_data.read_cache("iex", "5m", "start", "end", "SPY") == rows
    monkeypatch.setenv("BUILDER_FIXTURE_BARS", "1")
    raw, feed = builder_data.fetch_bars([f"S{i:03d}" for i in range(31)], "1d", "2026-10-05", "2026-10-09")
    assert feed == "fixture" and len(raw) == 31


def test_four_hour_aggregation_keeps_a_full_block():
    rows = []
    for hour, close in ((8, 10), (9, 11), (10, 12), (11, 13)):
        rows.append(bar("2026-10-05", f"{hour:02d}:00", close, close + 1, close - 1, close, 100))
    out = builder_data.aggregate_4h(rows)
    assert len(out) == 1
    assert out[0]["o"] == 10 and out[0]["c"] == 13 and out[0]["h"] == 14 and out[0]["v"] == 400
