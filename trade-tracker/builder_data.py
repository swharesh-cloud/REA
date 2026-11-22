"""Historical bars for the Strategy Builder.

Uses the same Alpaca market-data host as the existing backtests
(``https://data.alpaca.markets/v2/stocks/bars``), SIP first and IEX if SIP
fails. ``BUILDER_FIXTURE_BARS=1`` returns a built-in path instead, so the
page and the tests can run with no keys. This module never places orders.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, timedelta, timezone

from builder import (
    CT, SYMBOL_CAP, TF_MINUTES, app_root, attach_opening_context,
    needs_opening_context, normalize_bars, parse_symbols,
)

DATA = "https://data.alpaca.markets"
ALPACA_TF = {"5m": "5Min", "15m": "15Min", "1h": "1Hour", "4h": "1Hour", "1d": "1Day"}
FIXTURE_START = "2026-10-05"
FIXTURE_END = "2026-11-13"
MAX_DAYS = 400
MAX_SYMBOLS = SYMBOL_CAP
BATCH = 40


def fetch_bars(symbols, timeframe: str, start: str, end: str, progress=None):
    """Return ``({symbol: [alpaca bars]}, feed_name)``.

    ``progress(done, total, message)`` is optional. Real downloads are cached
    under ``data/builder/cache`` and requested in batches of 40 symbols.
    """
    symbols = parse_symbols(symbols if isinstance(symbols, str) else " ".join(symbols))
    if not symbols:
        raise ValueError("choose at least one symbol")
    if len(symbols) > MAX_SYMBOLS:
        raise ValueError(f"use at most {MAX_SYMBOLS} symbols")
    if timeframe not in ALPACA_TF:
        raise ValueError("timeframe must be 5m, 15m, 1h, 4h, or daily")
    if os.environ.get("BUILDER_FIXTURE_BARS") == "1":
        if progress:
            progress(1, 1, "Fixture bars")
        return fixture_market(symbols, timeframe, start, end), "fixture"
    start_iso, end_iso = _window(start, end)
    headers = _headers()
    feed = "sip"
    try:
        raw = _download(headers, symbols, timeframe, start_iso, end_iso, "sip", progress)
        if not any(raw.values()):
            raise RuntimeError("SIP returned no bars")
    except Exception:
        feed = "iex"
        raw = _download(headers, symbols, timeframe, start_iso, end_iso, "iex", progress)
    if timeframe == "4h":
        raw = {sym: aggregate_4h(rows) for sym, rows in raw.items()}
    return raw, feed


def load_bars(spec, symbols, start: str, end: str, progress=None):
    """Bars for a strategy, plus 5-minute opening context when the rules need it."""
    raw, feed = fetch_bars(symbols, spec.timeframe, start, end, progress=progress)
    notes = [f"Bars: {feed} feed, {spec.timeframe}."]
    if needs_opening_context(spec) and spec.timeframe not in ("5m",):
        five, five_feed = fetch_bars(symbols, "5m", start, end, progress=progress)
        for sym, rows in list(raw.items()):
            raw[sym] = attach_opening_context(rows, five.get(sym) or [])
        notes.append(f"Opening range and first-5-minute RVOL came from {five_feed} 5-minute bars.")
    elif feed == "iex":
        notes.append("SIP was unavailable, so these bars are IEX. Volume is only part of the market.")
    if feed == "fixture":
        notes.append("Fixture bars were used. No Alpaca request was made and no order can be sent from this preview.")
    return raw, notes


def aggregate_4h(raw_bars) -> list[dict]:
    """Bundle 1-hour bars into 08:00–12:00 and 12:00–16:00 Chicago blocks."""
    bars = normalize_bars(raw_bars)
    buckets: dict = {}
    for bar in bars:
        clock = bar.time.strftime("%H:%M")
        if "08:00" <= clock < "12:00":
            key = bar.time.replace(hour=8, minute=0, second=0, microsecond=0)
        elif "12:00" <= clock < "16:00":
            key = bar.time.replace(hour=12, minute=0, second=0, microsecond=0)
        else:
            continue
        buckets.setdefault(key, []).append(bar)
    out = []
    for key in sorted(buckets):
        group = buckets[key]
        if len(group) < 4:
            continue
        out.append({
            "t": key.isoformat(),
            "o": group[0].open,
            "h": max(bar.high for bar in group),
            "l": min(bar.low for bar in group),
            "c": group[-1].close,
            "v": sum(bar.volume for bar in group),
        })
    return out


def _headers():
    from broker import Alpaca
    broker = Alpaca()
    if getattr(broker, "mode", "") != "paper" or "paper" not in str(getattr(broker, "base", "")):
        raise RuntimeError("Strategy Builder reads market data with the paper account only")
    if not getattr(broker, "configured", False):
        raise RuntimeError("Alpaca paper keys are not set (ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET_KEY)")
    return broker.headers


def cache_file(feed: str, timeframe: str, start: str, end: str, symbol: str):
    digest = hashlib.sha1(f"{feed}|{timeframe}|{start}|{end}".encode()).hexdigest()[:12]
    safe = re.sub(r"[^A-Z0-9._-]", "_", symbol.upper())
    return app_root() / "data" / "builder" / "cache" / f"{safe}-{timeframe}-{digest}.json"


def read_cache(feed, timeframe, start, end, symbol):
    path = cache_file(feed, timeframe, start, end, symbol)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, list) else None


def write_cache(feed, timeframe, start, end, symbol, rows):
    path = cache_file(feed, timeframe, start, end, symbol)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows), encoding="utf-8")


def _download(headers, symbols, timeframe, start, end, feed, progress=None):
    import requests
    alpaca_tf = ALPACA_TF[timeframe]
    out = {}
    missing = []
    for symbol in symbols:
        cached = read_cache(feed, timeframe, start, end, symbol)
        if cached is not None:
            out[symbol] = cached
        else:
            missing.append(symbol)
    batches = max(1, (len(missing) + BATCH - 1) // BATCH) if missing else 1
    done_batches = 0
    if progress:
        progress(len(out), len(symbols), f"Cache hit {len(out)}/{len(symbols)}" if out else "Downloading bars")
    for offset in range(0, len(missing), BATCH):
        chunk = missing[offset:offset + BATCH]
        got = {sym: [] for sym in chunk}
        token = None
        for _ in range(400):
            params = {
                "symbols": ",".join(chunk), "timeframe": alpaca_tf, "start": start, "end": end,
                "limit": 10000, "feed": feed, "adjustment": "split",
            }
            if token:
                params["page_token"] = token
            response = requests.get(DATA + "/v2/stocks/bars", headers=headers, params=params, timeout=45)
            if response.status_code >= 400:
                raise RuntimeError(f"Alpaca bars HTTP {response.status_code}: {response.text[:180]}")
            body = response.json()
            for sym, rows in (body.get("bars") or {}).items():
                got.setdefault(sym, []).extend(rows)
            token = body.get("next_page_token")
            if not token:
                break
        for sym, rows in got.items():
            write_cache(feed, timeframe, start, end, sym, rows)
            out[sym] = rows
        done_batches += 1
        if progress:
            progress(min(len(symbols), len(out)), len(symbols),
                     f"Bars {min(len(symbols), offset + len(chunk))}/{len(symbols)} · batch {done_batches}/{batches}")
    for symbol in symbols:
        out.setdefault(symbol, [])
    return out


def _window(start: str, end: str):
    try:
        start_day = datetime.fromisoformat(str(start)[:10]).replace(tzinfo=CT)
        end_day = datetime.fromisoformat(str(end)[:10]).replace(tzinfo=CT) + timedelta(days=1)
    except ValueError as exc:
        raise ValueError("dates must look like 2026-10-05") from exc
    if end_day <= start_day:
        raise ValueError("end date must be on or after the start date")
    if (end_day - start_day).days > MAX_DAYS:
        raise ValueError(f"date range is limited to {MAX_DAYS} days")
    latest = datetime.now(timezone.utc) - timedelta(minutes=20)
    stop = min(end_day.astimezone(timezone.utc), latest)
    begin = start_day.astimezone(timezone.utc)
    if stop <= begin:
        raise ValueError("that range ends before the latest bar Alpaca will return")
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    return begin.strftime(fmt), stop.strftime(fmt)


def _weekdays(start: str, end: str):
    day = datetime.fromisoformat(start).date()
    stop = datetime.fromisoformat(end).date()
    while day <= stop:
        if day.weekday() < 5:
            yield day
        day += timedelta(days=1)


def fixture_market(symbols, timeframe: str, start: str, end: str):
    """Deterministic bars. SPY breaks the opening range on some days; other symbols stay inside it."""
    start = start or FIXTURE_START
    end = end or FIXTURE_END
    days = list(_weekdays(start[:10], end[:10]))
    out = {}
    for sym in symbols:
        rows = []
        for index, day in enumerate(days):
            rows.extend(_fixture_day(sym, day.isoformat(), index))
        if timeframe == "5m":
            out[sym] = rows
        elif timeframe == "1d":
            out[sym] = _collapse_day(rows)
        elif timeframe == "15m":
            out[sym] = _collapse(rows, 15)
        elif timeframe == "1h":
            out[sym] = _collapse(rows, 60)
        elif timeframe == "4h":
            out[sym] = aggregate_4h(_collapse(rows, 60))
        else:
            out[sym] = rows
    return out


def _fixture_day(symbol: str, day: str, index: int):
    """One cash session of 5-minute bars.

    Breakout days (SPY only, every third session) close above the opening
    range at 08:40 CT. Wins and losses alternate. Other sessions never close
    above the opening high, so a breakout rule stays quiet.
    """
    # Every 6th session, and 50x a normal open, so rvol5 stays above 5 even after
    # earlier spikes are inside the 14-day average (at most two of them).
    breakout = symbol == "SPY" and index % 6 == 5
    win = (index // 6) % 2 == 0
    rows = []
    minutes = list(range(8 * 60 + 30, 15 * 60, 5))
    for nth, minute in enumerate(minutes):
        hh, mm = divmod(minute, 60)
        stamp = datetime.fromisoformat(day).replace(hour=hh, minute=mm, tzinfo=CT)
        if hh == 8 and mm == 30:
            vol = 50000 if breakout else 1000
            o, h, l, c = 100.0, 100.30, 99.80, 100.10
        elif breakout and hh == 8 and mm == 35:
            o, h, l, c, vol = 100.15, 100.25, 100.05, 100.20, 400
        elif breakout and hh == 8 and mm == 40:
            o, h, l, c, vol = 100.25, 100.60, 100.20, 100.55, 700
        elif breakout and hh == 8 and mm == 45 and win:
            o, h, l, c, vol = 100.60, 101.40, 100.45, 101.10, 800
        elif breakout and hh == 8 and mm == 45 and not win:
            o, h, l, c, vol = 100.60, 100.70, 98.00, 98.40, 900
        else:
            # Stay inside 99.90–100.25 so the opening high (100.30) is not crossed.
            wiggle = 0.05 if nth % 2 == 0 else -0.05
            c = 100.05 + wiggle
            o, h, l, vol = c, min(100.25, c + 0.08), max(99.90, c - 0.08), 200
        rows.append({
            "t": stamp.isoformat(), "o": round(o, 2), "h": round(h, 2), "l": round(l, 2),
            "c": round(c, 2), "v": vol,
        })
    return rows


def _collapse(rows, minutes: int):
    bars = normalize_bars(rows)
    step = timedelta(minutes=minutes)
    buckets = {}
    for bar in bars:
        key = bar.time.replace(minute=(bar.time.minute // minutes) * minutes if minutes < 60 else 0,
                               second=0, microsecond=0)
        if minutes >= 60:
            key = bar.time.replace(minute=0, second=0, microsecond=0)
        buckets.setdefault(key, []).append(bar)
    out = []
    for key in sorted(buckets):
        group = buckets[key]
        if key + step <= group[-1].time:
            continue
        out.append({
            "t": key.isoformat(), "o": group[0].open, "h": max(b.high for b in group),
            "l": min(b.low for b in group), "c": group[-1].close, "v": sum(b.volume for b in group),
        })
    return out


def _collapse_day(rows):
    bars = normalize_bars(rows)
    buckets = {}
    for bar in bars:
        buckets.setdefault(bar.time.strftime("%Y-%m-%d"), []).append(bar)
    out = []
    for day in sorted(buckets):
        group = buckets[day]
        stamp = group[0].time.replace(hour=0, minute=0, second=0, microsecond=0)
        out.append({
            "t": stamp.isoformat(), "o": group[0].open, "h": max(b.high for b in group),
            "l": min(b.low for b in group), "c": group[-1].close, "v": sum(b.volume for b in group),
        })
    return out


def session_minutes(timeframe: str) -> int:
    return TF_MINUTES[timeframe]
