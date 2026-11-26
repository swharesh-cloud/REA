"""Built-in trading strategies.

A strategy receives a Context on every tick (see engine.Context). Bar-based
strategies only act when a new candle has closed (``ctx.new_bar()``), so they
behave the same in live trading and in backtests.

All order sizes are USD notional. ``ctx.max_notional`` is the bot's budget x
leverage, and the engine clamps every order so the bot never exceeds it.
"""
from __future__ import annotations

from . import indicators as ind


def fp(x: float) -> str:
    """Readable price: 96,970 / 3,601.53 / 0.37097."""
    a = abs(x)
    d = 0 if a >= 10000 else 2 if a >= 100 else 3 if a >= 1 else 5 if a >= 0.01 else 7
    return f"{x:,.{d}f}"


def P(name, label, type, default, help="", min=None, max=None, choices=None):
    return {"name": name, "label": label, "type": type, "default": default, "help": help,
            "min": min, "max": max, "choices": choices}


class Strategy:
    key = ""
    label = ""
    description = ""
    params: list = []

    def __init__(self, params: dict | None = None):
        self.p = {d["name"]: d["default"] for d in self.params}
        for k, v in (params or {}).items():
            spec = next((d for d in self.params if d["name"] == k), None)
            if spec is None:
                continue
            if spec["type"] == "int":
                v = int(float(v))
            elif spec["type"] == "float":
                v = float(v)
            elif spec["type"] == "bool":
                v = v if isinstance(v, bool) else str(v).lower() in ("1", "true", "yes", "on")
            elif spec["type"] == "choice" and v not in spec["choices"]:
                raise ValueError(f"{k} must be one of {spec['choices']}")
            if spec["min"] is not None and v < spec["min"]:
                raise ValueError(f"{spec['label']} must be ≥ {spec['min']}")
            if spec["max"] is not None and v > spec["max"]:
                raise ValueError(f"{spec['label']} must be ≤ {spec['max']}")
            self.p[k] = v
        self.validate()

    def validate(self):
        pass

    def warmup(self) -> int:
        return 2

    def on_tick(self, ctx):
        raise NotImplementedError

    def on_flat(self, ctx):
        """Called after the engine force-closes the position (stop-loss, take-profit, manual)."""

    @classmethod
    def schema(cls):
        return {"key": cls.key, "label": cls.label, "description": cls.description, "params": cls.params}


# --------------------------------------------------------------------------
class MACrossover(Strategy):
    key = "ma_cross"
    label = "Moving-Average Crossover"
    description = ("Trend following. Goes long when the fast average crosses above the slow one, "
                   "exits (or flips short) when it crosses back below.")
    params = [
        P("fast", "Fast period", "int", 9, min=2, max=200),
        P("slow", "Slow period", "int", 21, min=3, max=400),
        P("ma_type", "Average type", "choice", "ema", choices=["ema", "sma"]),
        P("allow_short", "Allow shorts", "bool", False, "Flip short on bearish cross instead of going flat"),
        P("size_pct", "Position size %", "float", 100.0, "Percent of max notional per position", 1, 100),
    ]

    def validate(self):
        if self.p["fast"] >= self.p["slow"]:
            raise ValueError("Fast period must be smaller than slow period")

    def warmup(self):
        return self.p["slow"] + 2

    def on_tick(self, ctx):
        if not ctx.new_bar() or len(ctx.closes) < self.warmup():
            return
        fn = ind.ema if self.p["ma_type"] == "ema" else ind.sma
        f, s = fn(ctx.closes, self.p["fast"]), fn(ctx.closes, self.p["slow"])
        if None in (f[-2], s[-2]):
            return
        size = ctx.max_notional * self.p["size_pct"] / 100
        if f[-2] <= s[-2] and f[-1] > s[-1]:
            ctx.target_usd(size, f"bullish cross {fp(f[-1])} > {fp(s[-1])}")
        elif f[-2] >= s[-2] and f[-1] < s[-1]:
            ctx.target_usd(-size if self.p["allow_short"] else 0, f"bearish cross {fp(f[-1])} < {fp(s[-1])}")


# --------------------------------------------------------------------------
class RSIReversion(Strategy):
    key = "rsi"
    label = "RSI Mean Reversion"
    description = ("Buys in steps while RSI is oversold, sells everything once RSI turns overbought. "
                   "Long only.")
    params = [
        P("period", "RSI period", "int", 14, min=2, max=100),
        P("oversold", "Oversold level", "float", 30.0, min=1, max=50),
        P("overbought", "Overbought level", "float", 70.0, min=50, max=99),
        P("entries", "Max entries", "int", 3, "Scale in up to this many times", 1, 10),
    ]

    def warmup(self):
        return self.p["period"] + 2

    def on_flat(self, ctx):
        ctx.state["entries"] = 0

    def on_tick(self, ctx):
        if not ctx.new_bar() or len(ctx.closes) < self.warmup():
            return
        r = ind.rsi(ctx.closes, self.p["period"])[-1]
        if r is None:
            return
        if ctx.position <= 0:
            ctx.state["entries"] = 0
        n = ctx.state.get("entries", 0)
        if r < self.p["oversold"] and n < self.p["entries"]:
            if ctx.buy_usd(ctx.max_notional / self.p["entries"], f"RSI {r:.1f} oversold (entry {n + 1})"):
                ctx.state["entries"] = n + 1
        elif r > self.p["overbought"] and ctx.position > 0:
            ctx.close(f"RSI {r:.1f} overbought")
            ctx.state["entries"] = 0


# --------------------------------------------------------------------------
class BollingerReversion(Strategy):
    key = "bollinger"
    label = "Bollinger Band Bounce"
    description = ("Buys when price closes below the lower band and exits at the middle band. "
                   "Optionally shorts the upper band too.")
    params = [
        P("period", "Period", "int", 20, min=5, max=200),
        P("stdev", "Std deviations", "float", 2.0, min=0.5, max=4),
        P("allow_short", "Short upper band", "bool", False),
        P("size_pct", "Position size %", "float", 100.0, min=1, max=100),
    ]

    def warmup(self):
        return self.p["period"] + 1

    def on_tick(self, ctx):
        if not ctx.new_bar() or len(ctx.closes) < self.warmup():
            return
        mid, up, lo = ind.bollinger(ctx.closes, self.p["period"], self.p["stdev"])
        c = ctx.closes[-1]
        size = ctx.max_notional * self.p["size_pct"] / 100
        if ctx.position == 0:
            if c < lo[-1]:
                ctx.target_usd(size, f"close {fp(c)} below lower band {fp(lo[-1])}")
            elif self.p["allow_short"] and c > up[-1]:
                ctx.target_usd(-size, f"close {fp(c)} above upper band {fp(up[-1])}")
        elif ctx.position > 0 and c >= mid[-1]:
            ctx.close(f"reverted to mid band {fp(mid[-1])}")
        elif ctx.position < 0 and c <= mid[-1]:
            ctx.close(f"reverted to mid band {fp(mid[-1])}")


# --------------------------------------------------------------------------
class DonchianBreakout(Strategy):
    key = "breakout"
    label = "Donchian Breakout"
    description = ("Turtle-style breakout. Enters when price closes beyond the N-bar high/low and "
                   "exits on the opposite M-bar channel.")
    params = [
        P("entry_bars", "Entry channel (bars)", "int", 20, min=5, max=300),
        P("exit_bars", "Exit channel (bars)", "int", 10, min=2, max=300),
        P("allow_short", "Allow shorts", "bool", True),
        P("size_pct", "Position size %", "float", 100.0, min=1, max=100),
    ]

    def warmup(self):
        return max(self.p["entry_bars"], self.p["exit_bars"]) + 2

    def on_tick(self, ctx):
        if not ctx.new_bar() or len(ctx.bars) < self.warmup():
            return
        prev = ctx.bars[:-1]
        c = ctx.closes[-1]
        hi_e = max(b["h"] for b in prev[-self.p["entry_bars"]:])
        lo_e = min(b["l"] for b in prev[-self.p["entry_bars"]:])
        hi_x = max(b["h"] for b in prev[-self.p["exit_bars"]:])
        lo_x = min(b["l"] for b in prev[-self.p["exit_bars"]:])
        size = ctx.max_notional * self.p["size_pct"] / 100
        if ctx.position > 0 and c < lo_x:
            ctx.close(f"broke {self.p['exit_bars']}-bar low {fp(lo_x)}")
        elif ctx.position < 0 and c > hi_x:
            ctx.close(f"broke {self.p['exit_bars']}-bar high {fp(hi_x)}")
        elif ctx.position == 0:
            if c > hi_e:
                ctx.target_usd(size, f"breakout above {fp(hi_e)}")
            elif self.p["allow_short"] and c < lo_e:
                ctx.target_usd(-size, f"breakdown below {fp(lo_e)}")


# --------------------------------------------------------------------------
class GridTrading(Strategy):
    key = "grid"
    label = "Grid Trading"
    description = ("Splits a price range into levels. Buys one lot each time price falls through a "
                   "level and sells that lot one level higher. Works best in sideways markets.")
    params = [
        P("lower", "Lower price", "float", 0.0, "0 = auto (current price − range %)", 0),
        P("upper", "Upper price", "float", 0.0, "0 = auto (current price + range %)", 0),
        P("range_pct", "Auto range ±%", "float", 3.0, min=0.2, max=50),
        P("levels", "Grid levels", "int", 10, min=3, max=100),
        P("recenter", "Re-center when out of range", "bool", True,
          "Auto range only: rebuild the grid around price once it leaves the range and no lots are held"),
    ]

    def on_flat(self, ctx):
        ctx.state["lots"] = {}

    def on_tick(self, ctx):
        st = ctx.state
        price = ctx.price
        if "grid" not in st:
            lo, hi = self.p["lower"], self.p["upper"]
            if lo <= 0 or hi <= 0:
                lo = price * (1 - self.p["range_pct"] / 100)
                hi = price * (1 + self.p["range_pct"] / 100)
            if hi <= lo:
                raise ValueError("Upper price must be above lower price")
            n = self.p["levels"]
            st["grid"] = [lo + (hi - lo) * i / (n - 1) for i in range(n)]
            st["lots"] = {}
            st["prev"] = price
            ctx.log(f"grid {fp(lo)} – {fp(hi)}, {n} levels")
            return
        grid, lots, prev = st["grid"], st.setdefault("lots", {}), st["prev"]
        auto = self.p["lower"] <= 0 or self.p["upper"] <= 0
        if auto and self.p["recenter"] and not lots and (price > grid[-1] or price < grid[0]):
            del st["grid"]
            ctx.log(f"price {fp(price)} left the grid range - re-centering")
            return self.on_tick(ctx)
        lot_usd = ctx.max_notional / (len(grid) - 1)
        # sells first: a lot bought at level i is sold when price reaches level i+1
        for key in sorted(lots, key=int):
            i = int(key)
            if price >= grid[i + 1]:
                if ctx.trade_coin("sell", lots[key], f"grid sell L{i + 1} @ {fp(grid[i + 1])}",
                                  reduce_only=True):
                    del lots[key]
        for i in range(len(grid) - 1):
            if prev > grid[i] >= price and str(i) not in lots:
                fill = ctx.buy_usd(lot_usd, f"grid buy L{i} @ {fp(grid[i])}")
                if fill:
                    lots[str(i)] = fill["coin"]
        st["prev"] = price


# --------------------------------------------------------------------------
class DCA(Strategy):
    key = "dca"
    label = "Smart DCA"
    description = ("Dollar-cost averaging. Buys a fixed amount every N bars and buys extra when price "
                   "is below your average entry. Pair with take-profit to bank gains.")
    params = [
        P("amount", "Buy amount (USD)", "float", 50.0, min=10),
        P("every", "Every N bars", "int", 1, min=1, max=10000),
        P("dip_pct", "Dip threshold %", "float", 3.0, "Below avg entry by this much → bigger buy", 0, 90),
        P("dip_mult", "Dip multiplier", "float", 2.0, min=1, max=10),
    ]

    def on_tick(self, ctx):
        if not ctx.new_bar():
            return
        st = ctx.state
        st["count"] = st.get("count", 0) + 1
        if (st["count"] - 1) % self.p["every"]:
            return
        amt, why = self.p["amount"], "scheduled buy"
        if ctx.position > 0 and ctx.price < ctx.entry * (1 - self.p["dip_pct"] / 100):
            amt *= self.p["dip_mult"]
            why = f"dip buy ({(ctx.price / ctx.entry - 1) * 100:.1f}% below avg)"
        ctx.buy_usd(amt, why)


STRATEGIES = {c.key: c for c in (GridTrading, MACrossover, RSIReversion, BollingerReversion,
                                 DonchianBreakout, DCA)}


def make_strategy(key: str, params: dict | None = None) -> Strategy:
    if key not in STRATEGIES:
        raise ValueError(f"Unknown strategy {key!r}")
    return STRATEGIES[key](params)
