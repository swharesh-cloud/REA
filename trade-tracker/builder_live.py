"""Paper-trading cycle for saved Strategy Builder strategies.

Called from the Stock Desk scheduler only when at least one saved strategy
has paper trading switched on. It submits Alpaca PAPER bracket orders whose
``client_order_id`` starts with ``bld-<id>-``, then asks brackets.py to move
the take-profit and stop onto the actual fill. It never reads or writes
another strategy's orders, positions, or settings except to *read* the Stock
Desk kill switch and skip new entries while that switch is on.

Off unless a strategy's JSON has ``"paper": true``.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta

from builder import (
    CT, app_root, default_sector_block, entry_side, exit_levels, list_strategies,
    load_strategy, parse_script, prepare, provisional_levels, px_str,
)

OPEN_STATUS = {"new", "accepted", "pending_new", "partially_filled", "held", "accepted_for_bidding"}


def wants_cycle(moment, root=None) -> bool:
    """True only on a weekday, 08:30–15:00 CT, with at least one paper strategy.

    The scheduler hook appends a cycle when this is true. When it is false the
    existing ORB / Gap Fade / 4H / EMA / Momentum / Gapper / GFS / CBC timing
    is unchanged.
    """
    if moment.weekday() >= 5:
        return False
    clock = moment.strftime("%H:%M")
    if not ("08:30" <= clock <= "15:00"):
        return False
    return any(bool(row.get("paper")) and not row.get("error") for row in list_strategies(root))


def paper_guard(broker):
    mode = getattr(broker, "mode", "")
    base = str(getattr(broker, "base", ""))
    if mode != "paper" or "paper" not in base:
        raise RuntimeError("Strategy Builder places Alpaca PAPER orders only. Live trading is not enabled.")
    if hasattr(broker, "configured") and not broker.configured:
        raise RuntimeError("Alpaca paper keys are not set")
    return broker


def order_payload(prefix, symbol, side, qty, ref_price, tp_pct, sl_pct, stamp):
    """Market bracket. Take-profit and stop are the wider pre-fill prices.

    brackets.wait_and_adjust replaces them from the actual fill. The client
    order id always starts with this strategy's prefix.
    """
    take, stop = _provisional(ref_price, side, tp_pct, sl_pct)
    client_id = f"{prefix}{symbol}-in-{stamp}"[:128]
    if not client_id.startswith(prefix):
        raise RuntimeError("refusing an order that does not carry the builder prefix")
    return {
        "symbol": symbol,
        "qty": str(int(qty)),
        "side": "buy" if side == "long" else "sell",
        "type": "market",
        "time_in_force": "day",
        "order_class": "bracket",
        "take_profit": {"limit_price": take},
        "stop_loss": {"stop_price": stop},
        "client_order_id": client_id,
    }


def exit_payload(prefix, symbol, side, qty, stamp):
    client_id = f"{prefix}{symbol}-exit-{stamp}"[:128]
    return {
        "symbol": symbol,
        "qty": str(int(qty)),
        "side": "sell" if side == "long" else "buy",
        "type": "market",
        "time_in_force": "day",
        "client_order_id": client_id,
    }


def _provisional(price, side, tp_pct, sl_pct):
    try:
        from brackets import provisional_exit_prices, px_str as bracket_px
        take, stop = provisional_exit_prices(price, side, tp_pct, sl_pct)
        return bracket_px(take), bracket_px(stop)
    except Exception:
        take, stop = provisional_levels(price, side, tp_pct, sl_pct)
        return px_str(take), px_str(stop)


def latest_closed_index(frame, now: datetime):
    found = None
    for index, bar in enumerate(frame.bars):
        end = bar.time + timedelta(minutes=frame.minutes)
        if end <= now:
            found = index
    return found


def entry_decision(spec, bars, now: datetime):
    """Signal on the latest closed bar, or None when it is stale or does not qualify."""
    frame = prepare(bars, spec.timeframe)
    if not frame.bars:
        return None
    index = latest_closed_index(frame, now)
    if index is None:
        return None
    end = frame.bars[index].time + timedelta(minutes=frame.minutes)
    if now - end > timedelta(minutes=frame.minutes):
        return None
    side = entry_side(spec, frame, index)
    if side is None:
        return None
    bar = frame.bars[index]
    return {"side": side, "signal_time": bar.time.isoformat(), "ref": bar.close, "day": frame.day[index]}


def desk_block_reason(root, day: str):
    """Read-only look at the Stock Desk kill switch. Does not change it."""
    path = app_root(root) / "sdesk" / "state" / "settings.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    if data.get("kill_switch"):
        return "Stock Desk kill switch is on — no new builder entries"
    if data.get("halt_date") == day:
        return "Stock Desk daily-loss halt is on — no new builder entries"
    return None


def _live_path(root):
    return app_root(root) / "data" / "builder" / "_live.json"


def load_live(root=None) -> dict:
    path = _live_path(root)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        data = {}
    data.setdefault("strategies", {})
    data.setdefault("log", [])
    return data


def save_live(data, root=None):
    path = _live_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def _log(state, message):
    stamp = datetime.now(CT).strftime("%Y-%m-%d %H:%M:%S CT")
    state["log"] = ([{"t": stamp, "m": message}] + state.get("log", []))[:200]


def cycle(now=None, root=None, broker=None, fetch=None) -> dict:
    """One pass. No-op when nothing is enabled for paper."""
    if os_demo():
        return {"ran": False, "reason": "demo preview does not place orders"}
    now = now or datetime.now(CT)
    if now.tzinfo is None:
        now = now.replace(tzinfo=CT)
    else:
        now = now.astimezone(CT)
    enabled = [row for row in list_strategies(root) if row.get("paper") and not row.get("error")]
    if not enabled:
        return {"ran": False, "reason": "no paper strategies"}
    broker = paper_guard(broker or _connect())
    state = load_live(root)
    placed = []
    for row in enabled:
        try:
            placed.extend(_run_one(row, now, root, broker, fetch, state))
        except Exception as exc:
            _log(state, f"{row.get('id')}: {str(exc)[:180]}")
    save_live(state, root)
    return {"ran": True, "placed": placed}


def os_demo() -> bool:
    import os
    return os.environ.get("BUILDER_DEMO") == "1"


def _connect():
    from broker import Alpaca
    return Alpaca()


def _run_one(row, now, root, broker, fetch, state):
    spec = parse_script(row.get("script") or "")
    prefix = row.get("prefix") or f"bld-{row['id']}-"
    book = state["strategies"].setdefault(row["id"], {"days": {}})
    day = now.strftime("%Y-%m-%d")
    trades = book["days"].setdefault(day, [])
    _sync_fills(broker, prefix, trades, spec, state)
    if spec.flat_by and spec.timeframe != "1d" and now.strftime("%H:%M") >= spec.flat_by:
        _flatten(broker, prefix, trades, state)
        return []
    reason = desk_block_reason(root, day)
    if reason:
        _log(state, f"{row['id']}: {reason}")
        return []
    if spec.timeframe != "1d":
        start, end = _session_bounds_clock(spec)
        clock = now.strftime("%H:%M")
        if clock < start or clock >= end:
            return []
    symbols = [s for s in (row.get("symbols") or []) if s]
    if not symbols:
        return []
    bars = _bars_for(symbols, spec, now, fetch)
    held = set()
    try:
        held = {p.get("symbol") for p in (broker.positions() or [])}
    except Exception:
        held = set()
    open_syms = {t["symbol"] for t in trades if t.get("status") == "open"}
    slots = spec.max_trades - len(trades)
    placed = []
    for symbol in sorted(symbols):
        if slots <= 0:
            break
        if symbol in held or symbol in open_syms:
            continue
        why = default_sector_block(symbol)
        if why:
            _log(state, f"{symbol} skipped: {why}")
            continue
        decision = entry_decision(spec, bars.get(symbol) or [], now)
        if not decision:
            continue
        if any(t.get("signal_time") == decision["signal_time"] and t["symbol"] == symbol for t in trades):
            continue
        mood = _mood_block(spec, decision["side"])
        if mood:
            _log(state, f"{symbol} skipped: {mood}")
            continue
        if decision["side"] == "short" and not _shortable(broker, symbol):
            _log(state, f"{symbol} skipped: not shortable on Alpaca")
            continue
        try:
            power = float(broker.account().get("buying_power") or 0)
        except Exception:
            power = 0.0
        qty = int((power * spec.size_pct / 100.0) // decision["ref"]) if decision["ref"] else 0
        if qty < 1:
            _log(state, f"{symbol} skipped: size under 1 share")
            continue
        payload = order_payload(prefix, symbol, decision["side"], qty, decision["ref"],
                                spec.take_profit_pct, spec.stop_pct, int(now.timestamp()))
        order = _submit(broker, payload)
        _schedule_adjust(broker, order, decision["side"], spec)
        real_tp, real_sl = exit_levels(decision["ref"], decision["side"], spec.take_profit_pct, spec.stop_pct)
        trades.append({
            "symbol": symbol, "side": decision["side"], "qty": qty, "status": "open",
            "signal_time": decision["signal_time"], "order_id": (order or {}).get("id"),
            "ref": decision["ref"], "tp": real_tp, "sl": real_sl,
        })
        _log(state, f"{decision['side']} {qty} {symbol} paper bracket {prefix} ref {decision['ref']:.2f}")
        placed.append(symbol)
        slots -= 1
        held.add(symbol)
    return placed


def _session_bounds_clock(spec):
    from builder import session_bounds
    return session_bounds(spec)


def _bars_for(symbols, spec, now, fetch):
    if fetch is not None:
        return fetch(symbols, spec.timeframe, now)
    from builder_data import fetch_bars
    start = now.strftime("%Y-%m-%d")
    raw, _feed = fetch_bars(symbols, spec.timeframe, start, start)
    return raw


def _submit(broker, payload):
    if hasattr(broker, "submit_order"):
        return broker.submit_order(**payload)
    return broker._req("POST", "/v2/orders", json=payload)


def _schedule_adjust(broker, order, side, spec):
    if not order or not order.get("id"):
        return
    try:
        from brackets import wait_and_adjust
    except Exception:
        return
    wait_and_adjust(broker, order, side, spec.take_profit_pct, spec.stop_pct)


def _mood_block(spec, side):
    if not spec.respect_mood:
        return None
    try:
        from mood import blocked
    except Exception:
        return "Market Mood is on for this strategy, but mood.py is not available — entry skipped"
    try:
        return blocked(side, "builder", force=True)
    except Exception:
        return "Market Mood check failed — entry skipped"


def _shortable(broker, symbol):
    try:
        asset = broker.asset(symbol) or {}
    except Exception:
        return False
    return bool(asset.get("shortable") and asset.get("easy_to_borrow"))


def _sync_fills(broker, prefix, trades, spec, state):
    for trade in trades:
        if trade.get("status") != "open" or trade.get("adjusted") or not trade.get("order_id"):
            continue
        try:
            order = broker._req("GET", f"/v2/orders/{trade['order_id']}", params={"nested": "true"})
        except Exception:
            continue
        if order.get("status") == "filled" and order.get("filled_avg_price"):
            try:
                from brackets import adjust_from_fill
                result = adjust_from_fill(broker, order, trade["side"], spec.take_profit_pct, spec.stop_pct,
                                           fill=float(order["filled_avg_price"]))
                if result:
                    trade.update(adjusted=True, fill=result["fill"], tp=result["tp"], sl=result["sl"])
                    _log(state, f"{trade['symbol']} filled @ {result['fill']} · TP {result['tp']} · stop {result['sl']}")
            except Exception as exc:
                _log(state, f"{trade['symbol']} fill adjust failed: {str(exc)[:120]}")


def _flatten(broker, prefix, trades, state):
    for trade in trades:
        if trade.get("status") != "open":
            continue
        try:
            orders = broker._req("GET", "/v2/orders", params={"status": "open", "nested": "true", "limit": 500})
        except Exception:
            orders = []
        for order in orders or []:
            client = order.get("client_order_id") or ""
            if client.startswith(prefix) and order.get("symbol") == trade["symbol"] and order.get("status") in OPEN_STATUS:
                try:
                    broker.cancel_order(order["id"])
                except Exception:
                    pass
        qty = int(trade.get("qty") or 0)
        try:
            position = next((p for p in broker.positions() if p.get("symbol") == trade["symbol"]), None)
        except Exception:
            position = None
        if position and qty:
            have = abs(int(float(position.get("qty") or 0)))
            sell = min(have, qty)
            if sell >= 1:
                payload = exit_payload(prefix, trade["symbol"], trade["side"], sell, int(datetime.now(CT).timestamp()))
                _submit(broker, payload)
        trade["status"] = "flat"
        _log(state, f"flat {trade['symbol']} at the strategy flat-by time")


def describe(strategy_id, root=None) -> dict:
    """Small status blob for the page. Read-only."""
    try:
        row = load_strategy(strategy_id, root)
    except Exception:
        return {"paper": False, "trades": []}
    state = load_live(root)
    book = state.get("strategies", {}).get(row["id"], {})
    today = datetime.now(CT).strftime("%Y-%m-%d")
    return {
        "paper": bool(row.get("paper")),
        "prefix": row.get("prefix"),
        "today": book.get("days", {}).get(today, []),
        "log": [line for line in state.get("log", []) if str(row["id"]) in line.get("m", "")][:12],
    }
