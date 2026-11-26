"""Market-data sources: the live Liquid API, or a built-in simulated market."""
from __future__ import annotations

import math
import random
import threading
import time

INTERVALS = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1d": 1440}


def interval_ms(interval: str) -> int:
    return INTERVALS[interval] * 60_000


def _f(x, default=0.0):
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


def normalize_candle(c) -> dict:
    if isinstance(c, (list, tuple)):  # [t, o, h, l, c, v]
        t, o, h, l, cl, v = (list(c) + [0] * 6)[:6]
    else:
        t = c.get("timestamp", c.get("t", c.get("time", 0)))
        o, h, l, cl = c.get("open", c.get("o")), c.get("high", c.get("h")), c.get("low", c.get("l")), c.get("close", c.get("c"))
        v = c.get("volume", c.get("v", 0))
    t = _f(t)
    if t < 1e12:  # seconds -> ms
        t *= 1000
    return {"t": int(t), "o": _f(o), "h": _f(h), "l": _f(l), "c": _f(cl), "v": _f(v)}


class LiquidMarket:
    """Market data from the Liquid API with short-lived caching."""
    name = "liquid"
    live = True

    def __init__(self, client):
        self.client = client
        self._cache = {}
        self._lock = threading.Lock()

    def _cached(self, key, ttl, fn):
        now = time.monotonic()
        with self._lock:
            hit = self._cache.get(key)
            if hit and now - hit[0] < ttl:
                return hit[1]
        val = fn()
        with self._lock:
            self._cache[key] = (now, val)
        return val

    def now_ms(self) -> int:
        return int(time.time() * 1000)

    def markets(self):
        def load():
            out = []
            for m in self.client.markets() or []:
                out.append({"symbol": m.get("symbol"), "ticker": m.get("ticker", m.get("symbol")),
                            "exchange": m.get("exchange", ""), "max_leverage": m.get("max_leverage", 1),
                            "sz_decimals": m.get("sz_decimals", 4)})
            return out
        return self._cached("markets", 600, load)

    def ticker(self, symbol):
        def load():
            t = self.client.ticker(symbol) or {}
            return {"symbol": symbol, "price": _f(t.get("mark_price")), "volume_24h": _f(t.get("volume_24h")),
                    "change_24h": _f(t.get("change_24h")), "funding_rate": _f(t.get("funding_rate"))}
        return self._cached(("ticker", symbol), 2, load)

    def price(self, symbol) -> float:
        return self.ticker(symbol)["price"]

    def candles(self, symbol, interval, limit=200):
        def load():
            rows = [normalize_candle(c) for c in (self.client.candles(symbol, interval, limit) or [])]
            rows.sort(key=lambda r: r["t"])
            return rows
        ttl = 5 if interval in ("1m", "5m") else 20
        return self._cached(("candles", symbol, interval, limit), ttl, load)

    def orderbook(self, symbol, depth=20):
        def load():
            ob = self.client.orderbook(symbol, depth) or {}
            conv = lambda side: [{"price": _f(l.get("price")), "size": _f(l.get("size"))} for l in ob.get(side, [])]
            return {"bids": conv("bids"), "asks": conv("asks")}
        return self._cached(("ob", symbol, depth), 2, load)


SIM_SYMBOLS = {
    "BTC-PERP": (97000, 50, 0.0011), "ETH-PERP": (3600, 50, 0.0015), "SOL-PERP": (210, 20, 0.002),
    "HYPE-PERP": (38, 10, 0.0028), "DOGE-PERP": (0.38, 10, 0.0025), "XRP-PERP": (2.3, 20, 0.0019),
    "NVDA-PERP": (180, 10, 0.0009), "TSLA-PERP": (420, 10, 0.0014), "GOLD-PERP": (2650, 20, 0.0004),
}


class SimMarket:
    """A realistic-looking random market (regime-switching GBM) for demo and paper trading.

    Simulated time runs faster than real time: by default one 1-minute candle
    is produced every ``seconds_per_bar`` real seconds, so strategies visibly trade.
    """
    name = "simulated"
    live = False

    def __init__(self, seconds_per_bar: float = 1.0, history: int = 20000, seed: int | None = None):
        self.seconds_per_bar = seconds_per_bar
        self.rng = random.Random(seed)
        self.lock = threading.Lock()
        self.t0_real = time.time()
        self.t0_sim = (int(time.time() * 1000) // 60_000) * 60_000
        self.series = {}
        self.state = {}
        for sym, (p0, _lev, vol) in SIM_SYMBOLS.items():
            self.series[sym] = []
            self.state[sym] = {"p": p0, "vol": vol, "drift": 0.0, "regime": 0, "anchor": p0}
            start = self.t0_sim - history * 60_000
            for i in range(history):
                self._step(sym, start + i * 60_000)

    def now_ms(self) -> int:
        return int(self.t0_sim + (time.time() - self.t0_real) / self.seconds_per_bar * 60_000)

    def _step(self, sym, t):
        st, rng = self.state[sym], self.rng
        if st["regime"] <= 0:
            st["regime"] = rng.randint(80, 400)
            st["drift"] = rng.choice([-1, 0, 0, 1]) * st["vol"] * rng.uniform(0.03, 0.12)
            st["volmult"] = rng.uniform(0.6, 1.6)
        st["regime"] -= 1
        vol = st["vol"] * st["volmult"]
        o = st["p"]
        # gentle pull toward a slowly moving anchor keeps prices in a sane range
        st["anchor"] *= math.exp(rng.gauss(0, vol * 0.05))
        pull = -0.002 * math.log(o / st["anchor"])
        r = rng.gauss(st["drift"] + pull, vol)
        if rng.random() < 0.004:
            r += rng.gauss(0, vol * 6)  # occasional shock
        c = o * math.exp(r)
        h = max(o, c) * math.exp(abs(rng.gauss(0, vol * 0.5)))
        l = min(o, c) * math.exp(-abs(rng.gauss(0, vol * 0.5)))
        v = abs(rng.gauss(1, 0.4)) * (1 + abs(r) / vol) * 1000 / max(o, 1e-9) ** 0.5
        st["p"] = c
        self.series[sym].append({"t": t, "o": o, "h": h, "l": l, "c": c, "v": v})

    def _advance(self, sym):
        s = self.series[sym]
        now = self.now_ms()
        while s[-1]["t"] + 60_000 <= now:
            self._step(sym, s[-1]["t"] + 60_000)
        if len(s) > 60000:
            del s[:10000]

    def markets(self):
        return [{"symbol": s, "ticker": s.split("-")[0], "exchange": "simulated", "max_leverage": lev,
                 "sz_decimals": 4} for s, (_p, lev, _v) in SIM_SYMBOLS.items()]

    def _check(self, symbol):
        if symbol not in self.series:
            raise ValueError(f"Unknown symbol {symbol} (simulated market has: {', '.join(SIM_SYMBOLS)})")

    def price(self, symbol) -> float:
        self._check(symbol)
        with self.lock:
            self._advance(symbol)
            last = self.series[symbol][-1]
            # interpolate inside the forming bar so the price ticks between candles
            frac = (self.now_ms() - last["t"]) / 60_000
            rng = random.Random(f"{symbol}{self.now_ms() // 250}")
            return last["c"] * math.exp(rng.gauss(0, self.state[symbol]["vol"] * 0.25 * min(frac, 1) ** 0.5))

    def ticker(self, symbol):
        p = self.price(symbol)
        s = self.series[symbol]
        day = s[-1440] if len(s) >= 1440 else s[0]
        vol = sum(b["v"] * b["c"] for b in s[-1440:])
        return {"symbol": symbol, "price": p, "volume_24h": vol, "change_24h": (p / day["o"] - 1) * 100,
                "funding_rate": 0.0000125 * (1 + (s[-1]["c"] / s[-60]["c"] - 1) * 50)}

    def candles(self, symbol, interval, limit=200):
        self._check(symbol)
        m = INTERVALS[interval]
        with self.lock:
            self._advance(symbol)
            src = self.series[symbol][-(limit * m + m):]
        out = []
        for b in src:
            bt = (b["t"] // (m * 60_000)) * m * 60_000
            if out and out[-1]["t"] == bt:
                o = out[-1]
                o["h"], o["l"], o["c"], o["v"] = max(o["h"], b["h"]), min(o["l"], b["l"]), b["c"], o["v"] + b["v"]
            else:
                out.append({"t": bt, "o": b["o"], "h": b["h"], "l": b["l"], "c": b["c"], "v": b["v"]})
        return out[-limit:]

    def history(self, symbol, interval, limit):
        """Longer history for backtests."""
        return self.candles(symbol, interval, limit)

    def orderbook(self, symbol, depth=20):
        p = self.price(symbol)
        rng = random.Random(f"ob{symbol}{self.now_ms() // 1000}")
        tick = p * 0.00008
        bids, asks, bp, ap = [], [], p - tick, p + tick
        for i in range(depth):
            bids.append({"price": bp, "size": rng.uniform(0.2, 3) * (1 + i * 0.15) * 1000 / p})
            asks.append({"price": ap, "size": rng.uniform(0.2, 3) * (1 + i * 0.15) * 1000 / p})
            bp -= tick * rng.uniform(1, 3)
            ap += tick * rng.uniform(1, 3)
        return {"bids": bids, "asks": asks}
