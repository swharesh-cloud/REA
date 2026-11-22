"""Strategy Builder core: rule language, indicators, backtest, and saved strategies.

Pure module. It does not import Flask, the broker, or any existing strategy
(ORB, Gap Fade, 4H Swing, EMA Pullback, Momentum, Premarket Gappers, GFS, CBC).
Paper trading lives in builder_live.py and only submits orders whose
client_order_id starts with that strategy's own ``bld-<id>-`` prefix.

A signal may use only bars through that close. The backtest fills at the next
bar's open. Energy and utilities are excluded before a symbol is simulated.
"""
from __future__ import annotations

import json
import math
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

CT = ZoneInfo("America/Chicago")
NY = ZoneInfo("America/New_York")

TF_MINUTES = {"5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 24 * 60}
TF_ALIASES = {
    "5m": "5m", "5min": "5m", "5minute": "5m",
    "15m": "15m", "15min": "15m", "15minute": "15m",
    "1h": "1h", "60m": "1h", "1hr": "1h", "60min": "1h",
    "4h": "4h", "4hr": "4h", "240m": "4h",
    "1d": "1d", "d": "1d", "1day": "1d", "daily": "1d", "day": "1d",
}
ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$")
SYM_RE = re.compile(r"^[A-Z][A-Z0-9.]{0,9}$")
# A full ORB-style scan is about 180 names. 200 leaves room without an unbounded download.
SYMBOL_CAP = 200

# Used only when excluded.py cannot be imported (standalone tests, partial copy).
# On a Trade Tracker install, excluded.blocked is the authority.
FALLBACK_EXCLUDED = frozenset({
    "XOM", "CVX", "COP", "EOG", "OXY", "SLB", "PSX", "MPC", "XLE", "XOP", "USO", "OIH",
    "NEE", "SO", "DUK", "AEP", "EXC", "SRE", "XEL", "D", "CEG", "VST", "XLU",
})

ASSUMPTIONS = (
    "A signal uses only data through that bar's close and fills at the next bar's open.",
    "Take-profit and stop are percentages of the actual fill (long: TP above / stop below; short: the reverse), rounded to a US equity tick.",
    "If the stop and the take-profit are both touched in the same bar, the stop is filled first.",
    "A gap through a level fills at the bar's open.",
    "Flat-by exits at the open of the first bar that starts at or after that Chicago time.",
    "At most one open position per symbol. Max trades per day is across the whole symbol list, in time order; the same timestamp trades the earlier symbol name first.",
    "Shares are floor(equity × size% / fill). Equity changes only after a trade closes. A name that would be under one share is skipped.",
    "The regular session default is 08:30–15:00 CT on intraday charts. Daily bars ignore the session clock.",
    "rvol is this session's volume so far divided by the average full-session volume of up to 20 prior days. rvol5 is the 08:30–08:35 CT volume divided by the average of that same window over up to 14 prior days.",
    "Opening-range high/low is the 08:30–08:35 CT high and low. On 15-minute or slower charts it is taken from 5-minute bars when those were loaded; otherwise the condition stays unknown and does not fire.",
    "Energy and utilities are excluded before simulation. A missing mood history does not block trades; a supplied mood history does.",
    "This backtest does not place orders.",
)

SYNTAX = """\
# One statement per line. # starts a comment.
name ORB-style breakout
timeframe 5m            # 5m, 15m, 1h, 4h, daily
session 08:36-10:00     # Chicago time; intraday default is 08:30-15:00
flat by 14:50
side both               # long, short, or both
max trades 1
price min 20
rvol5 min 5             # first-5-minute relative volume
rvol min 1.2            # daily relative volume (partial until the close)
size 10%                # percent of current equity per trade
respect market mood     # or: ignore mood
take profit 0.5%
stop 2%

long when close crosses_above or_high and rvol5 > 5 and close > 20
short when close crosses_below or_low and rvol5 > 5 and close > 20
exit when rsi(14) crosses_above 50

# Series: open high low close volume
# sma(n) ema(n) rsi(n) atr(n) vwap
# macd macd_signal macd_hist   (defaults 12, 26, 9)
# bb_upper bb_lower bb_mid     (defaults 20, 2)
# rvol(n) rvol5(n) or_high or_low prior_high prior_low
# Comparisons: > >= < <= == !=   crosses_above / crosses_below
# Combine with and / or / not. Parentheses work.
"""


class ParseError(ValueError):
    def __init__(self, message: str, line: int | None = None):
        self.line = line
        text = f"line {line}: {message}" if line else message
        super().__init__(text)


@dataclass(frozen=True)
class Num:
    value: float


@dataclass(frozen=True)
class Series:
    name: str
    args: tuple


@dataclass(frozen=True)
class Bin:
    op: str
    left: object
    right: object


@dataclass(frozen=True)
class Unary:
    op: str
    expr: object


@dataclass(frozen=True)
class Cross:
    op: str
    left: object
    right: object


@dataclass
class Spec:
    name: str = "Untitled strategy"
    timeframe: str = "5m"
    session_start: str | None = None
    session_end: str | None = None
    flat_by: str | None = None
    side: str = "long"
    max_trades: int = 1
    price_min: float | None = None
    rvol5_min: float | None = None
    rvol_min: float | None = None
    respect_mood: bool = False
    take_profit_pct: float = 0.5
    stop_pct: float = 2.0
    size_pct: float = 10.0
    long_src: str | None = None
    short_src: str | None = None
    exit_src: str | None = None
    long_expr: object = None
    short_expr: object = None
    exit_expr: object = None
    symbols: list = field(default_factory=list)
    side_explicit: bool = False


@dataclass
class Bar:
    time: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float
    or_high: float | None = None
    or_low: float | None = None
    open5_volume: float | None = None


def tick_size(px: float) -> float:
    return 0.0001 if abs(float(px)) < 1 else 0.01


def tick_round(px: float, direction: str | None = None) -> float:
    """Same US-equity tick rule as brackets.tick_round."""
    px = float(px)
    step = tick_size(px)
    if direction == "up":
        n = math.ceil(px / step - 1e-12)
    elif direction == "down":
        n = math.floor(px / step + 1e-12)
    else:
        n = round(px / step)
    q = n * step
    return round(q, 4 if step < 0.01 else 2)


def px_str(px: float) -> str:
    px = tick_round(px)
    return f"{px:.4f}" if tick_size(px) < 0.01 else f"{px:.2f}"


def exit_levels(entry: float, side: str, tp_pct: float, sl_pct: float) -> tuple[float, float]:
    """Take-profit and stop from the fill. Matches brackets.exit_prices."""
    entry = float(entry)
    d = 1.0 if str(side).lower() in ("long", "buy") else -1.0
    tp = tick_round(entry * (1 + d * float(tp_pct) / 100.0))
    sl = tick_round(entry * (1 - d * float(sl_pct) / 100.0))
    step = tick_size(entry)
    if d > 0:
        if tp <= entry:
            tp = tick_round(entry + step, "up")
        if sl >= entry:
            sl = tick_round(entry - step, "down")
    else:
        if tp >= entry:
            tp = tick_round(entry - step, "down")
        if sl <= entry:
            sl = tick_round(entry + step, "up")
    return tp, sl


def provisional_levels(entry: float, side: str, tp_pct: float, sl_pct: float, pad: float = 3.0):
    """Wider pre-fill bracket, replaced from the real fill by brackets.wait_and_adjust."""
    return exit_levels(entry, side, float(tp_pct) + pad, float(sl_pct) + pad)


# --------------------------------------------------------------------------------------
# Parser
# --------------------------------------------------------------------------------------

def _strip_comment(line: str) -> str:
    out = []
    for ch in line:
        if ch == "#":
            break
        out.append(ch)
    return "".join(out)


def _hhmm(token: str, line: int) -> str:
    m = re.fullmatch(r"(\d{1,2}):(\d{2})", token.strip())
    if not m:
        raise ParseError(f"expected HH:MM, got {token!r}", line)
    hour, minute = int(m.group(1)), int(m.group(2))
    if hour > 23 or minute > 59:
        raise ParseError(f"clock time out of range: {token}", line)
    return f"{hour:02d}:{minute:02d}"


def _number_token(token: str, line: int) -> float:
    raw = token.strip()
    if raw.endswith("%"):
        raw = raw[:-1].strip()
    try:
        value = float(raw)
    except ValueError as exc:
        raise ParseError(f"expected a number, got {token!r}", line) from exc
    if not math.isfinite(value):
        raise ParseError(f"number must be finite, got {token!r}", line)
    return value


def _timeframe(token: str, line: int) -> str:
    key = token.strip().lower()
    if key not in TF_ALIASES:
        raise ParseError("timeframe must be 5m, 15m, 1h, 4h, or daily", line)
    return TF_ALIASES[key]


def parse_expr(text: str, line: int = 1):
    tokens = _tokenize(text, line)
    if not tokens:
        raise ParseError("empty expression", line)
    parser = _ExprParser(tokens, line)
    expr = parser.parse_or()
    if parser.peek() is not None:
        kind, value = parser.peek()
        raise ParseError(f"unexpected {value!r} after the expression", line)
    return expr


class _ExprParser:
    def __init__(self, tokens, line: int):
        self.tokens = tokens
        self.line = line
        self.i = 0

    def peek(self):
        return self.tokens[self.i] if self.i < len(self.tokens) else None

    def pop(self):
        tok = self.peek()
        if tok is None:
            raise ParseError("unexpected end of expression", self.line)
        self.i += 1
        return tok

    def _is_ident(self, *names) -> bool:
        tok = self.peek()
        return bool(tok and tok[0] == "ident" and tok[1] in names)

    def _is_op(self, *ops) -> bool:
        tok = self.peek()
        return bool(tok and tok[0] == "op" and tok[1] in ops)

    def parse_or(self):
        left = self.parse_and()
        while self._is_ident("or"):
            self.pop()
            left = Bin("or", left, self.parse_and())
        return left

    def parse_and(self):
        left = self.parse_not()
        while self._is_ident("and"):
            self.pop()
            left = Bin("and", left, self.parse_not())
        return left

    def parse_not(self):
        if self._is_ident("not"):
            self.pop()
            return Unary("not", self.parse_not())
        return self.parse_cmp()

    def parse_cmp(self):
        left = self.parse_add()
        if self._is_op(">", ">=", "<", "<=", "==", "!="):
            op = self.pop()[1]
            return Bin(op, left, self.parse_add())
        if self._is_ident("crosses_above", "crosses_below"):
            op = self.pop()[1]
            return Cross(op, left, self.parse_add())
        return left

    def parse_add(self):
        left = self.parse_mul()
        while self._is_op("+", "-"):
            op = self.pop()[1]
            left = Bin(op, left, self.parse_mul())
        return left

    def parse_mul(self):
        left = self.parse_unary()
        while self._is_op("*", "/"):
            op = self.pop()[1]
            left = Bin(op, left, self.parse_unary())
        return left

    def parse_unary(self):
        if self._is_op("-"):
            self.pop()
            return Unary("neg", self.parse_unary())
        return self.parse_primary()

    def parse_primary(self):
        tok = self.pop()
        kind, value = tok
        if kind == "num":
            return Num(value)
        if kind == "lp":
            expr = self.parse_or()
            close = self.pop()
            if close[0] != "rp":
                raise ParseError("missing closing parenthesis", self.line)
            return expr
        if kind != "ident":
            raise ParseError(f"unexpected {value!r}", self.line)
        if value in ("and", "or", "not"):
            raise ParseError(f"unexpected {value!r}", self.line)
        if value in ("crosses_above", "crosses_below") and self.peek() and self.peek()[0] == "lp":
            args = self._args()
            if len(args) != 2:
                raise ParseError(f"{value} takes two inputs", self.line)
            return Cross(value, args[0], args[1])
        if self.peek() and self.peek()[0] == "lp":
            args = self._args()
            return _series_call(value, args, self.line)
        return _series_bare(value, self.line)

    def _args(self):
        self.pop()  # (
        args = []
        if self.peek() and self.peek()[0] == "rp":
            self.pop()
            return args
        while True:
            args.append(self.parse_or())
            tok = self.pop()
            if tok[0] == "rp":
                return args
            if tok[0] != "comma":
                raise ParseError("expected a comma or ')' in the argument list", self.line)


_BARE = {
    "open": ("open", ()), "high": ("high", ()), "low": ("low", ()),
    "close": ("close", ()), "volume": ("volume", ()), "vwap": ("vwap", ()),
    "or_high": ("or_high", ()), "or_low": ("or_low", ()),
    "prior_high": ("prior_high", ()), "prior_low": ("prior_low", ()),
    "pdh": ("prior_high", ()), "pdl": ("prior_low", ()),
    "prior_day_high": ("prior_high", ()), "prior_day_low": ("prior_low", ()),
    "rvol": ("rvol", (20,)), "rvol5": ("rvol5", (14,)),
    "atr": ("atr", (14,)), "rsi": ("rsi", (14,)),
    "macd": ("macd", (12, 26, 9)), "macd_signal": ("macd_signal", (12, 26, 9)),
    "macd_hist": ("macd_hist", (12, 26, 9)),
    "bb_upper": ("bb_upper", (20, 2.0)), "bb_lower": ("bb_lower", (20, 2.0)),
    "bb_mid": ("bb_mid", (20, 2.0)), "bb_middle": ("bb_mid", (20, 2.0)),
}


def _series_bare(name: str, line: int) -> Series:
    if name not in _BARE:
        raise ParseError(f"unknown series {name!r}. sma and ema need a period, for example ema(20)", line)
    key, args = _BARE[name]
    return Series(key, args)


def _as_period(expr, line: int, label: str) -> int:
    if not isinstance(expr, Num) or not float(expr.value).is_integer() or expr.value < 1:
        raise ParseError(f"{label} must be an integer >= 1", line)
    return int(expr.value)


def _as_mult(expr, line: int) -> float:
    if not isinstance(expr, Num) or expr.value < 0:
        raise ParseError("Bollinger multiplier must be a number >= 0", line)
    return float(expr.value)


def _series_call(name: str, args: list, line: int) -> Series:
    alias = {"bb_middle": "bb_mid"}.get(name, name)
    if alias in ("sma", "ema"):
        if len(args) != 1:
            raise ParseError(f"{alias}(period) needs one period", line)
        return Series(alias, (_as_period(args[0], line, alias),))
    if alias == "rsi":
        if len(args) > 1:
            raise ParseError("rsi takes zero or one period", line)
        period = 14 if not args else _as_period(args[0], line, "rsi")
        return Series("rsi", (period,))
    if alias == "atr":
        if len(args) > 1:
            raise ParseError("atr takes zero or one period", line)
        period = 14 if not args else _as_period(args[0], line, "atr")
        return Series("atr", (period,))
    if alias == "vwap":
        if args:
            raise ParseError("vwap takes no arguments", line)
        return Series("vwap", ())
    if alias in ("macd", "macd_signal", "macd_hist"):
        if args and len(args) != 3:
            raise ParseError(f"{alias}() or {alias}(fast, slow, signal)", line)
        if not args:
            return Series(alias, (12, 26, 9))
        fast = _as_period(args[0], line, "MACD fast")
        slow = _as_period(args[1], line, "MACD slow")
        signal = _as_period(args[2], line, "MACD signal")
        if fast >= slow:
            raise ParseError("MACD fast period must be shorter than the slow period", line)
        return Series(alias, (fast, slow, signal))
    if alias in ("bb_upper", "bb_lower", "bb_mid"):
        if len(args) > 2:
            raise ParseError(f"{alias} takes a period and an optional multiplier", line)
        period = 20 if not args else _as_period(args[0], line, alias)
        mult = 2.0 if len(args) < 2 else _as_mult(args[1], line)
        return Series(alias, (period, mult))
    if alias == "rvol":
        if len(args) > 1:
            raise ParseError("rvol takes an optional lookback", line)
        look = 20 if not args else _as_period(args[0], line, "rvol")
        return Series("rvol", (look,))
    if alias == "rvol5":
        if len(args) > 1:
            raise ParseError("rvol5 takes an optional lookback", line)
        look = 14 if not args else _as_period(args[0], line, "rvol5")
        return Series("rvol5", (look,))
    if alias in ("or_high", "or_low", "prior_high", "prior_low", "open", "high", "low", "close", "volume"):
        if args:
            raise ParseError(f"{alias} takes no arguments", line)
        return Series(alias, ())
    raise ParseError(f"unknown series {name!r}", line)


def _tokenize(text: str, line: int):
    out = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch.isspace():
            i += 1
            continue
        if ch == "(":
            out.append(("lp", "(")); i += 1; continue
        if ch == ")":
            out.append(("rp", ")")); i += 1; continue
        if ch == ",":
            out.append(("comma", ",")); i += 1; continue
        if ch in "+-*/":
            out.append(("op", ch)); i += 1; continue
        if ch in "<>!=":
            if i + 1 < n and text[i + 1] == "=":
                out.append(("op", ch + "=")); i += 2; continue
            if ch == "!":
                raise ParseError("expected !=", line)
            out.append(("op", ch)); i += 1; continue
        if ch.isdigit() or (ch == "." and i + 1 < n and text[i + 1].isdigit()):
            j = i + 1
            while j < n and (text[j].isdigit() or text[j] == "."):
                j += 1
            try:
                value = float(text[i:j])
            except ValueError as exc:
                raise ParseError(f"bad number {text[i:j]!r}", line) from exc
            if not math.isfinite(value):
                raise ParseError("number must be finite", line)
            out.append(("num", value)); i = j; continue
        if ch.isalpha() or ch == "_":
            j = i + 1
            while j < n and (text[j].isalnum() or text[j] == "_"):
                j += 1
            out.append(("ident", text[i:j].lower())); i = j; continue
        raise ParseError(f"unexpected character {ch!r}", line)
    return out


def _name_value(compact: str) -> str:
    raw = compact.split(None, 1)[1].strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        raw = raw[1:-1].strip()
    raw = re.sub(r"\s+", " ", raw)
    if not raw or len(raw) > 80:
        raise ParseError("strategy name must be 1–80 characters")
    return raw


def _finish_spec(spec: Spec, line_count: int):
    if spec.long_expr is None and spec.short_expr is None:
        raise ParseError("add a 'long when ...' or 'short when ...' rule")
    if not spec.side_explicit:
        if spec.long_expr and spec.short_expr:
            spec.side = "both"
        elif spec.short_expr:
            spec.side = "short"
        else:
            spec.side = "long"
    if spec.side == "long" and spec.long_expr is None:
        raise ParseError("side is long, but there is no 'long when' rule")
    if spec.side == "short" and spec.short_expr is None:
        raise ParseError("side is short, but there is no 'short when' rule")
    if spec.side == "both" and spec.long_expr is None and spec.short_expr is None:
        raise ParseError("side is both, but no entry rule was given")
    for label, value in (("take profit", spec.take_profit_pct), ("stop", spec.stop_pct), ("size", spec.size_pct)):
        if not math.isfinite(value) or value <= 0 or value > 100:
            raise ParseError(f"{label} must be greater than 0 and at most 100")
    if spec.max_trades < 1 or spec.max_trades > 50:
        raise ParseError("max trades must be from 1 through 50")
    if spec.price_min is not None and spec.price_min < 0:
        raise ParseError("price min cannot be negative")
    if spec.session_start and spec.session_end and spec.session_start >= spec.session_end:
        raise ParseError("session start must be earlier than session end")
    if line_count < 0:
        raise ParseError("empty script")


def parse_script(text: str) -> Spec:
    if text is None or not str(text).strip():
        raise ParseError("script is empty")
    if len(text) > 20_000:
        raise ParseError("script is longer than 20000 characters")
    spec = Spec()
    seen = False
    for lineno, raw in enumerate(str(text).splitlines(), 1):
        line = _strip_comment(raw).strip()
        if not line:
            continue
        seen = True
        try:
            _apply_statement(spec, line, lineno)
        except ParseError:
            raise
        except Exception as exc:
            raise ParseError(str(exc), lineno) from exc
    if not seen:
        raise ParseError("script is empty")
    _finish_spec(spec, 1)
    return spec


def _apply_statement(spec: Spec, line: str, lineno: int):
    compact = re.sub(r"\s+", " ", line.strip())
    low = (compact.lower()
           .replace("take-profit", "take profit")
           .replace("stop-loss", "stop loss")
           .replace("trades/day", "trades"))
    if low.startswith("long when "):
        spec.long_src = compact[len("long when "):].strip()
        spec.long_expr = parse_expr(spec.long_src, lineno)
        return
    if low.startswith("short when "):
        spec.short_src = compact[len("short when "):].strip()
        spec.short_expr = parse_expr(spec.short_src, lineno)
        return
    if low.startswith("exit when "):
        spec.exit_src = compact[len("exit when "):].strip()
        spec.exit_expr = parse_expr(spec.exit_src, lineno)
        return
    if low in ("long only", "side long"):
        spec.side, spec.side_explicit = "long", True
        return
    if low in ("short only", "side short"):
        spec.side, spec.side_explicit = "short", True
        return
    if low in ("side both", "side long short", "long and short"):
        spec.side, spec.side_explicit = "both", True
        return
    if low.startswith("name ") or low.startswith("strategy "):
        spec.name = _name_value(compact)
        return
    if low.startswith("timeframe ") or low.startswith("tf "):
        spec.timeframe = _timeframe(low.split()[-1], lineno)
        return
    if low.startswith("session "):
        body = low[len("session "):].replace("ct", "").strip()
        if "-" not in body:
            raise ParseError("session must look like 08:36-10:00", lineno)
        start, end = body.split("-", 1)
        spec.session_start, spec.session_end = _hhmm(start, lineno), _hhmm(end, lineno)
        return
    if low.startswith("flat by ") or low.startswith("flat "):
        token = low.replace("ct", "").split()[-1]
        spec.flat_by = _hhmm(token, lineno)
        return
    if "trade" in low and (low.startswith("max trades") or low.startswith("max ")):
        nums = re.findall(r"\d+", low)
        if len(nums) != 1:
            raise ParseError("max trades must be a whole number", lineno)
        spec.max_trades = int(nums[0])
        return
    if low.startswith("price min ") or low.startswith("price >= ") or low.startswith("price > "):
        spec.price_min = _number_token(low.split()[-1], lineno)
        return
    if low.startswith("rvol5 min ") or low.startswith("rvol5 >= ") or low.startswith("rvol5 > "):
        spec.rvol5_min = _number_token(low.split()[-1], lineno)
        return
    if (low.startswith("rvol min ") or low.startswith("rvol >= ") or low.startswith("rvol > ")
            or low.startswith("daily rvol min ") or low.startswith("daily rvol >= ")):
        spec.rvol_min = _number_token(low.split()[-1], lineno)
        return
    if low in ("respect market mood", "respect mood", "respect mood on", "mood on"):
        spec.respect_mood = True
        return
    if low in ("ignore mood", "ignore market mood", "respect mood off", "mood off"):
        spec.respect_mood = False
        return
    if low.startswith("take profit ") or low.startswith("tp "):
        spec.take_profit_pct = _number_token(low.split()[-1], lineno)
        return
    if low.startswith("stop loss ") or low.startswith("stop ") or low.startswith("sl "):
        spec.stop_pct = _number_token(low.split()[-1], lineno)
        return
    if low.startswith("size "):
        spec.size_pct = _number_token(low.split()[-1], lineno)
        return
    if low.startswith("symbols ") or low.startswith("symbol "):
        spec.symbols = parse_symbols(compact.split(None, 1)[1])
        return
    if low.startswith("side "):
        raise ParseError("side must be long, short, or both", lineno)
    raise ParseError(f"unknown statement: {compact}", lineno)


def parse_symbols(text: str) -> list[str]:
    parts = re.split(r"[\s,]+", str(text or "").upper())
    out = []
    for part in parts:
        if not part:
            continue
        if not SYM_RE.fullmatch(part):
            raise ParseError(f"bad symbol {part!r}")
        if part not in out:
            out.append(part)
    if len(out) > SYMBOL_CAP:
        raise ParseError(f"use at most {SYMBOL_CAP} symbols")
    return out


def session_bounds(spec: Spec) -> tuple[str | None, str | None]:
    if spec.timeframe == "1d":
        return None, None
    return spec.session_start or "08:30", spec.session_end or "15:00"


def spec_public(spec: Spec) -> dict:
    start, end = session_bounds(spec)
    return {
        "name": spec.name,
        "timeframe": spec.timeframe,
        "session_start": spec.session_start,
        "session_end": spec.session_end,
        "session_effective": None if start is None else f"{start}-{end}",
        "flat_by": spec.flat_by,
        "side": spec.side,
        "max_trades": spec.max_trades,
        "price_min": spec.price_min,
        "rvol5_min": spec.rvol5_min,
        "rvol_min": spec.rvol_min,
        "respect_mood": spec.respect_mood,
        "take_profit_pct": spec.take_profit_pct,
        "stop_pct": spec.stop_pct,
        "size_pct": spec.size_pct,
        "long_when": spec.long_src,
        "short_when": spec.short_src,
        "exit_when": spec.exit_src,
        "symbols": list(spec.symbols),
    }


def compile_script(fields: dict) -> str:
    """Turn form fields into the rule language. Expression text is kept as written."""
    name = str(fields.get("name") or "Untitled strategy").strip() or "Untitled strategy"
    lines = [f"name {name}"]
    tf = _timeframe(str(fields.get("timeframe") or "5m"), 0)
    lines.append(f"timeframe {tf}")
    start, end = fields.get("session_start"), fields.get("session_end")
    if start or end:
        if not start or not end:
            raise ParseError("set both session start and session end, or leave both blank")
        lines.append(f"session {_hhmm(str(start), 0)}-{_hhmm(str(end), 0)}")
    if fields.get("flat_by"):
        lines.append(f"flat by {_hhmm(str(fields['flat_by']), 0)}")
    side = str(fields.get("side") or "both").lower()
    if side not in ("long", "short", "both"):
        raise ParseError("side must be long, short, or both")
    lines.append(f"side {side}")
    lines.append(f"max trades {int(fields.get('max_trades') or 1)}")
    if fields.get("price_min") not in (None, ""):
        lines.append(f"price min {_number_token(str(fields['price_min']), 0):g}")
    if fields.get("rvol5_min") not in (None, ""):
        lines.append(f"rvol5 min {_number_token(str(fields['rvol5_min']), 0):g}")
    if fields.get("rvol_min") not in (None, ""):
        lines.append(f"rvol min {_number_token(str(fields['rvol_min']), 0):g}")
    size = _number_token(str(fields.get("size_pct") if fields.get("size_pct") not in (None, "") else 10), 0)
    lines.append(f"size {size:g}%")
    if fields.get("respect_mood") in (True, "true", "on", "yes", 1, "1"):
        lines.append("respect market mood")
    else:
        lines.append("ignore mood")
    tp = _number_token(str(fields.get("take_profit_pct") if fields.get("take_profit_pct") not in (None, "") else 0.5), 0)
    sl = _number_token(str(fields.get("stop_pct") if fields.get("stop_pct") not in (None, "") else 2), 0)
    lines.append(f"take profit {tp:g}%")
    lines.append(f"stop {sl:g}%")
    symbols = fields.get("symbols") or []
    if isinstance(symbols, str):
        symbols = parse_symbols(symbols)
    if symbols:
        lines.append("symbols " + " ".join(parse_symbols(" ".join(symbols))))
    long_src = str(fields.get("long_when") or "").strip()
    short_src = str(fields.get("short_when") or "").strip()
    exit_src = str(fields.get("exit_when") or "").strip()
    if long_src:
        lines.append("long when " + long_src)
    if short_src:
        lines.append("short when " + short_src)
    if exit_src:
        lines.append("exit when " + exit_src)
    script = "\n".join(lines) + "\n"
    parse_script(script)  # refuse a form that does not parse
    return script


def walk_series(expr):
    if isinstance(expr, Series):
        yield expr
    elif isinstance(expr, (Bin, Cross)):
        yield from walk_series(expr.left)
        yield from walk_series(expr.right)
    elif isinstance(expr, Unary):
        yield from walk_series(expr.expr)


def needs_opening_context(spec: Spec) -> bool:
    if spec.rvol5_min is not None:
        return True
    for expr in (spec.long_expr, spec.short_expr, spec.exit_expr):
        for series in walk_series(expr):
            if series.name in ("rvol5", "or_high", "or_low"):
                return True
    return False


# --------------------------------------------------------------------------------------
# Indicators
# --------------------------------------------------------------------------------------

def sma(values, period: int):
    period = int(period)
    out = [None] * len(values)
    for end in range(period - 1, len(values)):
        window = values[end - period + 1:end + 1]
        if any(item is None or not math.isfinite(item) for item in window):
            continue
        out[end] = sum(window) / period
    return out


def ema(values, period: int):
    """Seed with the SMA, then 2/(period+1). A gap resets the seed. Same rule as studies.ema."""
    period = int(period)
    out = [None] * len(values)
    mult = 2.0 / (period + 1)
    seed_sum = 0.0
    seed_count = 0
    prev = None
    for index, value in enumerate(values):
        if value is None or not math.isfinite(value):
            seed_sum = 0.0
            seed_count = 0
            prev = None
            continue
        if prev is None:
            seed_sum += value
            seed_count += 1
            if seed_count == period:
                prev = seed_sum / period
                out[index] = prev
            continue
        prev = (value - prev) * mult + prev
        out[index] = prev
    return out


def rsi(values, period: int):
    """Wilder RSI. 100 when average loss is 0. Same smoothing as studies.rsi."""
    period = int(period)
    out = [None] * len(values)
    avg_gain = avg_loss = None
    seed_gain = seed_loss = 0.0
    seed_count = 0
    prev_close = None
    for index, value in enumerate(values):
        if value is None or not math.isfinite(value):
            avg_gain = avg_loss = None
            seed_gain = seed_loss = 0.0
            seed_count = 0
            prev_close = None
            continue
        if prev_close is None:
            prev_close = value
            continue
        change = value - prev_close
        prev_close = value
        gain = change if change > 0 else 0.0
        loss = -change if change < 0 else 0.0
        if avg_gain is None:
            seed_gain += gain
            seed_loss += loss
            seed_count += 1
            if seed_count == period:
                avg_gain = seed_gain / period
                avg_loss = seed_loss / period
                out[index] = 100.0 if avg_loss == 0 else 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
            continue
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        out[index] = 100.0 if avg_loss == 0 else 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
    return out


def atr(bars: list[Bar], period: int):
    period = int(period)
    trs = []
    prev_close = None
    for bar in bars:
        if prev_close is None:
            tr = bar.high - bar.low
        else:
            tr = max(bar.high - bar.low, abs(bar.high - prev_close), abs(bar.low - prev_close))
        trs.append(tr)
        prev_close = bar.close
    return _wilder(trs, period)


def _wilder(values, period: int):
    out = [None] * len(values)
    if len(values) < period or period < 1:
        return out
    prev = sum(values[:period]) / period
    out[period - 1] = prev
    for index in range(period, len(values)):
        prev = (prev * (period - 1) + values[index]) / period
        out[index] = prev
    return out


def macd_lines(values, fast=12, slow=26, signal=9):
    fast_ema = ema(values, fast)
    slow_ema = ema(values, slow)
    line = []
    for a, b in zip(fast_ema, slow_ema):
        line.append(None if a is None or b is None else a - b)
    signal_line = ema(line, signal)
    hist = []
    for a, b in zip(line, signal_line):
        hist.append(None if a is None or b is None else a - b)
    return line, signal_line, hist


def bollinger(values, period=20, multiplier=2.0):
    period = int(period)
    middle = sma(values, period)
    upper = [None] * len(values)
    lower = [None] * len(values)
    for end in range(period - 1, len(values)):
        if middle[end] is None:
            continue
        acc = 0.0
        for index in range(end - period + 1, end + 1):
            delta = values[index] - middle[end]
            acc += delta * delta
        dev = math.sqrt(acc / period)
        upper[end] = middle[end] + multiplier * dev
        lower[end] = middle[end] - multiplier * dev
    return middle, upper, lower


def vwap_series(bars: list[Bar], days: list[str], timeframe: str):
    out = []
    pv = vol = 0.0
    current = None
    reset = timeframe != "1d"
    for bar, day in zip(bars, days):
        if reset and day != current:
            current = day
            pv = vol = 0.0
        typical = (bar.high + bar.low + bar.close) / 3.0
        if bar.volume > 0:
            pv += typical * bar.volume
            vol += bar.volume
        out.append(pv / vol if vol > 0 else None)
    return out


# --------------------------------------------------------------------------------------
# Frames and signals
# --------------------------------------------------------------------------------------

def _as_ct(value) -> datetime:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=CT)
        return value.astimezone(CT)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return datetime.fromtimestamp(float(value), tz=timezone.utc).astimezone(CT)
    text = str(value).strip().replace("Z", "+00:00")
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(CT)


def _f(bar: dict, *keys):
    for key in keys:
        if key in bar and bar[key] is not None:
            try:
                value = float(bar[key])
            except (TypeError, ValueError):
                return None
            if math.isfinite(value):
                return value
    return None


def normalize_bars(raw) -> list[Bar]:
    if not isinstance(raw, list):
        raise TypeError("bars must be a list")
    out = []
    for item in raw:
        if isinstance(item, Bar):
            out.append(item)
            continue
        if not isinstance(item, dict):
            raise TypeError("each bar must be an object")
        when = item.get("t", item.get("time"))
        if when is None:
            continue
        o = _f(item, "o", "open")
        h = _f(item, "h", "high")
        l = _f(item, "l", "low")
        c = _f(item, "c", "close")
        v = _f(item, "v", "volume")
        if None in (o, h, l, c):
            continue
        high, low = max(h, o, c, l), min(l, o, c, h)
        out.append(Bar(
            time=_as_ct(when), open=o, high=high, low=low, close=c, volume=v or 0.0,
            or_high=_f(item, "or_high"), or_low=_f(item, "or_low"),
            open5_volume=_f(item, "open5_volume", "rvol5_volume"),
        ))
    out.sort(key=lambda bar: bar.time)
    dedup = {}
    for bar in out:
        dedup[bar.time] = bar
    return [dedup[key] for key in sorted(dedup)]


def attach_opening_context(bars, bars_5m) -> list[dict]:
    """Copy 08:30–08:35 CT high/low/volume from 5-minute bars onto slower bars.

    Values are stored on each bar. The frame still withholds them until that
    bar ends after 08:35, so a signal cannot see the opening range early.
    """
    five = normalize_bars(bars_5m)
    by_day: dict[str, list[Bar]] = {}
    for bar in five:
        by_day.setdefault(_trading_day(bar.time), []).append(bar)
    ctx = {}
    for day, group in by_day.items():
        window = [bar for bar in group if "08:30" <= bar.time.strftime("%H:%M") < "08:35"]
        if not window:
            continue
        ctx[day] = (
            max(bar.high for bar in window),
            min(bar.low for bar in window),
            sum(bar.volume for bar in window),
        )
    stamped = []
    for item in bars:
        if not isinstance(item, dict):
            continue
        row = dict(item)
        when = row.get("t", row.get("time"))
        if when is None:
            stamped.append(row)
            continue
        day = _trading_day(_as_ct(when))
        if day in ctx:
            row["or_high"], row["or_low"], row["open5_volume"] = ctx[day]
        stamped.append(row)
    return stamped


def _trading_day(when: datetime) -> str:
    """Cash-session date in Chicago.

    Alpaca's daily bar is stamped at midnight New York, which is still the
    previous evening in Chicago. Clocks outside 08:30–20:00 CT use the New
    York date so that stamp stays on the session it belongs to.
    """
    local = when.astimezone(CT)
    if "08:30" <= local.strftime("%H:%M") < "20:00":
        return local.strftime("%Y-%m-%d")
    return when.astimezone(NY).strftime("%Y-%m-%d")


class Frame:
    def __init__(self, bars: list[Bar], timeframe: str):
        if timeframe not in TF_MINUTES:
            raise ValueError(f"unknown timeframe {timeframe}")
        self.bars = bars
        self.timeframe = timeframe
        self.minutes = TF_MINUTES[timeframe]
        self.cache: dict = {}
        self._build()

    def _day_of(self, when: datetime) -> str:
        if self.timeframe == "1d":
            return when.astimezone(NY).strftime("%Y-%m-%d")
        return when.strftime("%Y-%m-%d")

    def _build(self):
        bars = self.bars
        n = len(bars)
        self.day = [self._day_of(bar.time) for bar in bars]
        self.prior_high = [None] * n
        self.prior_low = [None] * n
        self.or_high = [None] * n
        self.or_low = [None] * n
        self.cum_vol = [0.0] * n
        self.open5: dict[str, float | None] = {}
        self.day_volume: dict[str, float] = {}
        self.day_order: list[str] = []
        groups: dict[str, list[int]] = {}
        running: dict[str, float] = {}
        for i, bar in enumerate(bars):
            day = self.day[i]
            if day not in groups:
                groups[day] = []
                self.day_order.append(day)
            groups[day].append(i)
            self.day_volume[day] = self.day_volume.get(day, 0.0) + bar.volume
            running[day] = running.get(day, 0.0) + bar.volume
            self.cum_vol[i] = running[day]
        prev_h = prev_l = None
        for day in self.day_order:
            for i in groups[day]:
                self.prior_high[i] = prev_h
                self.prior_low[i] = prev_l
            prev_h = max(bars[i].high for i in groups[day])
            prev_l = min(bars[i].low for i in groups[day])
        for day in self.day_order:
            idxs = groups[day]
            derived = []
            pre_hi = pre_lo = pre_vol = None
            for i in idxs:
                bar = bars[i]
                if bar.or_high is not None:
                    pre_hi = bar.or_high
                if bar.or_low is not None:
                    pre_lo = bar.or_low
                if bar.open5_volume is not None:
                    pre_vol = bar.open5_volume
                hm = bar.time.strftime("%H:%M")
                if self.minutes <= 5 and "08:30" <= hm < "08:35":
                    derived.append(bar)
            hi = lo = vol = None
            if derived:
                hi = max(bar.high for bar in derived)
                lo = min(bar.low for bar in derived)
                vol = sum(bar.volume for bar in derived)
            if pre_hi is not None:
                hi = pre_hi
            if pre_lo is not None:
                lo = pre_lo
            if pre_vol is not None:
                vol = pre_vol
            self.open5[day] = vol
            for i in idxs:
                bar = bars[i]
                end = bar.time + timedelta(minutes=self.minutes)
                ready = self.timeframe == "1d" or end.strftime("%H:%M") > "08:35" or end.date() != bar.time.date()
                if self.timeframe == "1d":
                    ready = pre_hi is not None
                if ready and hi is not None:
                    self.or_high[i] = hi
                    self.or_low[i] = lo

    def column(self, series: Series):
        key = (series.name, series.args)
        if key not in self.cache:
            self.cache[key] = self._column(series)
        return self.cache[key]

    def _column(self, series: Series):
        closes = [bar.close for bar in self.bars]
        name, args = series.name, series.args
        if name == "open":
            return [bar.open for bar in self.bars]
        if name == "high":
            return [bar.high for bar in self.bars]
        if name == "low":
            return [bar.low for bar in self.bars]
        if name == "close":
            return closes
        if name == "volume":
            return [bar.volume for bar in self.bars]
        if name == "sma":
            return sma(closes, args[0])
        if name == "ema":
            return ema(closes, args[0])
        if name == "rsi":
            return rsi(closes, args[0])
        if name == "atr":
            return atr(self.bars, args[0])
        if name == "vwap":
            return vwap_series(self.bars, self.day, self.timeframe)
        if name in ("macd", "macd_signal", "macd_hist"):
            line, signal, hist = macd_lines(closes, *args)
            return {"macd": line, "macd_signal": signal, "macd_hist": hist}[name]
        if name in ("bb_mid", "bb_upper", "bb_lower"):
            mid, upper, lower = bollinger(closes, int(args[0]), float(args[1]))
            return {"bb_mid": mid, "bb_upper": upper, "bb_lower": lower}[name]
        if name == "prior_high":
            return list(self.prior_high)
        if name == "prior_low":
            return list(self.prior_low)
        if name == "or_high":
            return list(self.or_high)
        if name == "or_low":
            return list(self.or_low)
        if name == "rvol":
            return [self.rvol_at(i, args[0]) for i in range(len(self.bars))]
        if name == "rvol5":
            return [self.rvol5_at(i, args[0]) for i in range(len(self.bars))]
        raise ParseError(f"unknown series {name}")

    def rvol_at(self, index: int, lookback: int):
        day = self.day[index]
        priors = []
        for older in self.day_order:
            if older >= day:
                break
            priors.append(self.day_volume.get(older, 0.0))
        if not priors:
            return None
        window = priors[-int(lookback):]
        avg = sum(window) / len(window)
        if avg <= 0:
            return None
        return self.cum_vol[index] / avg

    def rvol5_at(self, index: int, lookback: int):
        if self.or_high[index] is None and self.timeframe != "1d":
            return None
        day = self.day[index]
        vol = self.open5.get(day)
        if vol is None:
            return None
        priors = []
        for older in self.day_order:
            if older >= day:
                break
            older_vol = self.open5.get(older)
            if older_vol is not None:
                priors.append(older_vol)
        if not priors:
            return None
        window = priors[-int(lookback):]
        avg = sum(window) / len(window)
        if avg <= 0:
            return None
        return vol / avg


def prepare(bars, timeframe: str) -> Frame:
    return Frame(normalize_bars(bars), timeframe)


def _num(value):
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    return None


def _boolish(value):
    if value is True or value is False or value is None:
        return value
    return None


def eval_expr(expr, frame: Frame, index: int):
    if isinstance(expr, Num):
        return expr.value
    if isinstance(expr, Series):
        return frame.column(expr)[index]
    if isinstance(expr, Unary):
        if expr.op == "neg":
            value = _num(eval_expr(expr.expr, frame, index))
            return None if value is None else -value
        value = _boolish(eval_expr(expr.expr, frame, index))
        if value is None:
            return None
        return (not value)
    if isinstance(expr, Cross):
        return _cross_at(expr, frame, index)
    if isinstance(expr, Bin):
        if expr.op in ("and", "or"):
            return _logic(expr.op, eval_expr(expr.left, frame, index), eval_expr(expr.right, frame, index))
        if expr.op in (">", ">=", "<", "<=", "==", "!="):
            return _cmp(expr.op, _num(eval_expr(expr.left, frame, index)), _num(eval_expr(expr.right, frame, index)))
        left, right = _num(eval_expr(expr.left, frame, index)), _num(eval_expr(expr.right, frame, index))
        if left is None or right is None:
            return None
        if expr.op == "+":
            return left + right
        if expr.op == "-":
            return left - right
        if expr.op == "*":
            return left * right
        if expr.op == "/":
            return None if right == 0 else left / right
    raise ParseError("cannot evaluate expression")


def _logic(op, left, right):
    a, b = _boolish(left), _boolish(right)
    if op == "and":
        if a is False or b is False:
            return False
        if a is True and b is True:
            return True
        return None
    if a is True or b is True:
        return True
    if a is False and b is False:
        return False
    return None


def _cmp(op, left, right):
    if left is None or right is None:
        return None
    if op == ">":
        return left > right
    if op == ">=":
        return left >= right
    if op == "<":
        return left < right
    if op == "<=":
        return left <= right
    if op == "==":
        return left == right
    return left != right


def _cross_at(expr: Cross, frame: Frame, index: int):
    if index < 1:
        return False
    left_prev = _num(eval_expr(expr.left, frame, index - 1))
    left_now = _num(eval_expr(expr.left, frame, index))
    right_prev = _num(eval_expr(expr.right, frame, index - 1))
    right_now = _num(eval_expr(expr.right, frame, index))
    if None in (left_prev, left_now, right_prev, right_now):
        return False
    if expr.op == "crosses_above":
        return left_prev <= right_prev and left_now > right_now
    return left_prev >= right_prev and left_now < right_now


def evaluate_series(bars, timeframe: str, expression: str):
    """Evaluate one expression on each bar. Used by tests and the parser check."""
    frame = prepare(bars, timeframe)
    expr = parse_expr(expression, 1)
    return [eval_expr(expr, frame, i) for i in range(len(frame.bars))]


def _in_session(spec: Spec, when: datetime) -> bool:
    start, end = session_bounds(spec)
    if start is None:
        return True
    clock = when.strftime("%H:%M")
    return start <= clock < end


def _filters_ok(spec: Spec, frame: Frame, index: int) -> bool:
    bar = frame.bars[index]
    if not _in_session(spec, bar.time):
        return False
    if spec.price_min is not None and bar.close < spec.price_min:
        return False
    if spec.rvol5_min is not None:
        value = frame.rvol5_at(index, 14)
        if value is None or value < spec.rvol5_min:
            return False
    if spec.rvol_min is not None:
        value = frame.rvol_at(index, 20)
        if value is None or value < spec.rvol_min:
            return False
    return True


def entry_side(spec: Spec, frame: Frame, index: int):
    if not _filters_ok(spec, frame, index):
        return None
    long_ok = spec.side in ("long", "both") and spec.long_expr is not None and eval_expr(spec.long_expr, frame, index) is True
    short_ok = spec.side in ("short", "both") and spec.short_expr is not None and eval_expr(spec.short_expr, frame, index) is True
    if long_ok and short_ok:
        return None
    if long_ok:
        return "long"
    if short_ok:
        return "short"
    return None


def mood_allows(spec: Spec, mood: dict | None, day: str, side: str) -> bool:
    if not spec.respect_mood:
        return True
    if not mood:
        return True
    call = mood.get(day)
    if not call:
        return False
    call = str(call).upper()
    if side == "long" and call == "RISK-OFF":
        return False
    if side == "short" and call == "RISK-ON":
        return False
    return True


def default_sector_block(symbol: str):
    """Reason string when a new entry must be skipped, else None.

    Calls excluded.blocked when that module is installed next to this file.
    If it cannot be imported, a short built-in list still blocks the obvious
    energy and utility names.
    """
    try:
        from excluded import blocked as excluded_blocked
    except Exception:
        excluded_blocked = None
    if excluded_blocked is not None:
        try:
            return excluded_blocked(symbol)
        except Exception:
            return "energy/utilities lookup failed"
    if str(symbol or "").upper() in FALLBACK_EXCLUDED:
        return "energy/utilities"
    return None


# --------------------------------------------------------------------------------------
# Backtest
# --------------------------------------------------------------------------------------

def run_backtest(spec, bars_by_symbol, *, initial_equity=100_000.0, mood=None,
                 sector_block=None, size_pct=None) -> dict:
    if isinstance(spec, str):
        spec = parse_script(spec)
    if not isinstance(spec, Spec):
        raise TypeError("spec must be a script or a parsed strategy")
    if not math.isfinite(initial_equity) or initial_equity <= 0:
        raise ValueError("initial equity must be a finite number > 0")
    size = spec.size_pct if size_pct is None else float(size_pct)
    if not math.isfinite(size) or size <= 0 or size > 100:
        raise ValueError("size percent must be greater than 0 and at most 100")
    block = sector_block or default_sector_block
    notes = []
    if spec.respect_mood and not mood:
        notes.append("Respect Market Mood is on, but no mood history was supplied, so that filter was not applied.")
    if spec.respect_mood and mood is not None:
        notes.append("Market Mood blocks new longs on RISK-OFF days and new shorts on RISK-ON days. Days with no call are skipped.")
    frames = {}
    skipped = []
    for symbol, raw in sorted((str(k).upper(), v) for k, v in (bars_by_symbol or {}).items()):
        why = block(symbol)
        if why:
            skipped.append({"symbol": symbol, "reason": str(why)})
            continue
        bars = normalize_bars(raw)
        if len(bars) < 2:
            skipped.append({"symbol": symbol, "reason": "not enough bars"})
            continue
        frames[symbol] = prepare(bars, spec.timeframe)
    if needs_opening_context(spec) and frames:
        if all(value is None for frame in frames.values() for value in frame.open5.values()):
            notes.append("First-5-minute RVOL and the opening range need 5-minute (or 1-minute) bars. Those conditions did not fire.")
    events = []
    for symbol, frame in frames.items():
        for index, bar in enumerate(frame.bars):
            events.append((bar.time, symbol, index))
    events.sort(key=lambda item: (item[0], item[1], item[2]))

    equity = float(initial_equity)
    peak = equity
    max_dd = 0.0
    max_dd_pct = 0.0
    positions = {}
    pending_in = {}
    pending_out = {}
    per_day = {}
    trades = []
    curve = []
    if events:
        curve.append({"time": events[0][0].isoformat(), "equity": round(equity, 2)})

    def mark():
        nonlocal peak, max_dd, max_dd_pct
        if equity > peak:
            peak = equity
        drop = peak - equity
        if drop > max_dd:
            max_dd = drop
            max_dd_pct = (drop / peak * 100.0) if peak else 0.0

    def close_position(symbol, index, price, reason):
        nonlocal equity
        pos = positions.pop(symbol)
        pending_out.pop(symbol, None)
        direction = 1.0 if pos["side"] == "long" else -1.0
        pnl = round((float(price) - pos["entry"]) * pos["qty"] * direction, 2)
        pnl_pct = round((float(price) / pos["entry"] - 1.0) * direction * 100.0, 4)
        equity = round(equity + pnl, 2)
        mark()
        when = frames[symbol].bars[index].time
        trades.append({
            "symbol": symbol,
            "side": pos["side"],
            "qty": pos["qty"],
            "entry_time": pos["entry_time"].isoformat(),
            "entry": pos["entry"],
            "exit_time": when.isoformat(),
            "exit": float(price),
            "reason": reason,
            "pnl": pnl,
            "pnl_pct": pnl_pct,
        })
        curve.append({"time": when.isoformat(), "equity": round(equity, 2)})

    for when, symbol, index in events:
        frame = frames[symbol]
        bar = frame.bars[index]
        day = frame.day[index]
        pend = pending_in.get(symbol)
        if pend and pend["i"] == index and symbol not in positions:
            pending_in.pop(symbol, None)
            too_late = spec.flat_by and spec.timeframe != "1d" and bar.time.strftime("%H:%M") >= spec.flat_by
            if not too_late and per_day.get(day, 0) < spec.max_trades and bar.open > 0:
                qty = int((equity * size / 100.0) // bar.open)
                if qty >= 1:
                    tp, sl = exit_levels(bar.open, pend["side"], spec.take_profit_pct, spec.stop_pct)
                    positions[symbol] = {
                        "side": pend["side"], "entry": bar.open, "qty": qty, "tp": tp, "sl": sl,
                        "entry_i": index, "entry_time": bar.time,
                    }
                    per_day[day] = per_day.get(day, 0) + 1
                else:
                    notes.append(f"{symbol} {day}: skipped, size was under 1 share at {bar.open:.2f}")
        elif pend and pend["i"] == index:
            pending_in.pop(symbol, None)

        if symbol in positions:
            pos = positions[symbol]
            flat_now = (spec.flat_by and spec.timeframe != "1d" and index != pos["entry_i"]
                        and bar.time.strftime("%H:%M") >= spec.flat_by)
            signal_exit = pending_out.get(symbol, {}).get("i") == index
            if flat_now:
                close_position(symbol, index, bar.open, "flat")
            elif signal_exit:
                close_position(symbol, index, bar.open, "signal")
            elif symbol in positions:
                pos = positions[symbol]
                if pos["side"] == "long":
                    if bar.low <= pos["sl"]:
                        close_position(symbol, index, min(pos["sl"], bar.open), "stop")
                    elif bar.high >= pos["tp"]:
                        close_position(symbol, index, max(pos["tp"], bar.open), "tp")
                else:
                    if bar.high >= pos["sl"]:
                        close_position(symbol, index, max(pos["sl"], bar.open), "stop")
                    elif bar.low <= pos["tp"]:
                        close_position(symbol, index, min(pos["tp"], bar.open), "tp")

        if index + 1 >= len(frame.bars) or symbol in positions:
            if symbol in positions and spec.exit_expr is not None and eval_expr(spec.exit_expr, frame, index) is True:
                pending_out[symbol] = {"i": index + 1}
            continue
        side = entry_side(spec, frame, index)
        if side is None:
            continue
        if not mood_allows(spec, mood, day, side):
            continue
        nxt = frame.bars[index + 1]
        if spec.flat_by and spec.timeframe != "1d" and nxt.time.strftime("%H:%M") >= spec.flat_by:
            continue
        pending_in[symbol] = {"i": index + 1, "side": side}

    for symbol in list(positions):
        close_position(symbol, len(frames[symbol].bars) - 1, frames[symbol].bars[-1].close, "end")

    wins = [row for row in trades if row["pnl"] > 0]
    losses = [row for row in trades if row["pnl"] <= 0]
    gross_win = sum(row["pnl"] for row in wins)
    gross_loss = -sum(row["pnl"] for row in losses)
    stats = {
        "trades": len(trades),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": round(len(wins) / len(trades) * 100.0, 1) if trades else 0.0,
        "total_pnl": round(sum(row["pnl"] for row in trades), 2),
        "avg_win": round(gross_win / len(wins), 2) if wins else 0.0,
        "avg_loss": round(sum(row["pnl"] for row in losses) / len(losses), 2) if losses else 0.0,
        "profit_factor": round(gross_win / gross_loss, 2) if gross_loss else None,
        "max_drawdown": round(max_dd, 2),
        "max_drawdown_pct": round(max_dd_pct, 2),
        "initial_equity": round(float(initial_equity), 2),
        "final_equity": round(equity, 2),
        "longs": sum(row["side"] == "long" for row in trades),
        "shorts": sum(row["side"] == "short" for row in trades),
    }
    if stats["profit_factor"] is None and wins:
        notes.append("Profit factor is undefined because there were no losing trades.")
    return {
        "ok": True,
        "stats": stats,
        "trades": trades,
        "equity": curve,
        "notes": notes,
        "skipped": skipped,
        "assumptions": list(ASSUMPTIONS),
        "spec": spec_public(spec),
    }


# --------------------------------------------------------------------------------------
# Saved strategies (data/builder/<id>.json). Paper flag defaults off.
# --------------------------------------------------------------------------------------

def app_root(root=None) -> Path:
    if root is not None:
        return Path(root)
    env = os.environ.get("BUILDER_ROOT")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent


def builder_dir(root=None) -> Path:
    path = app_root(root) / "data" / "builder"
    path.mkdir(parents=True, exist_ok=True)
    return path


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", str(name or "").lower()).strip("-")[:24].strip("-")
    return slug or "strategy"


def _stamp() -> str:
    return datetime.now(CT).isoformat(timespec="seconds")


def list_strategies(root=None) -> list[dict]:
    folder = builder_dir(root)
    rows = []
    for path in sorted(folder.glob("*.json")):
        if path.name.startswith("_"):
            continue
        try:
            row = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            rows.append({"id": path.stem, "name": path.stem, "error": "could not read file", "paper": False})
            continue
        if not isinstance(row, dict) or not row.get("id"):
            continue
        rows.append(row)
    rows.sort(key=lambda row: (str(row.get("name") or "").lower(), row.get("id") or ""))
    return rows


def load_strategy(strategy_id: str, root=None) -> dict:
    if not ID_RE.fullmatch(str(strategy_id or "")):
        raise ValueError("unknown strategy")
    path = builder_dir(root) / f"{strategy_id}.json"
    if not path.is_file():
        raise ValueError("unknown strategy")
    row = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(row, dict):
        raise ValueError("strategy file is not valid")
    return row


def save_strategy(payload: dict, root=None) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("strategy must be an object")
    script = str(payload.get("script") or "")
    spec = parse_script(script)
    symbols = payload.get("symbols", spec.symbols)
    if isinstance(symbols, str):
        symbols = parse_symbols(symbols)
    else:
        symbols = parse_symbols(" ".join(symbols or []))
    strategy_id = str(payload.get("id") or "").strip().lower()
    folder = builder_dir(root)
    created = _stamp()
    previous = None
    if strategy_id:
        if not ID_RE.fullmatch(strategy_id):
            raise ValueError("strategy id must be lowercase letters, numbers, and hyphens")
        existing = folder / f"{strategy_id}.json"
        if existing.is_file():
            try:
                previous = json.loads(existing.read_text(encoding="utf-8"))
                created = previous.get("created") or created
            except Exception:
                previous = None
    if "paper" in payload:
        paper = bool(payload.get("paper"))
    else:
        paper = bool((previous or {}).get("paper", False))
    if paper and not symbols:
        raise ValueError("add at least one symbol before enabling paper trading")
    if not strategy_id:
        base = slugify(spec.name)
        strategy_id = base
        n = 2
        while (folder / f"{strategy_id}.json").is_file():
            suffix = f"-{n}"
            strategy_id = (base[:24 - len(suffix)]).strip("-") + suffix
            n += 1
        created = _stamp()
    row = {
        "id": strategy_id,
        "name": spec.name,
        "script": script if script.endswith("\n") else script + "\n",
        "symbols": symbols,
        "paper": paper,
        "prefix": f"bld-{strategy_id}-",
        "created": created,
        "updated": _stamp(),
        "summary": spec_public(spec),
    }
    (folder / f"{strategy_id}.json").write_text(json.dumps(row, indent=2) + "\n", encoding="utf-8")
    return row


def delete_strategy(strategy_id: str, root=None, force: bool = False) -> dict:
    row = load_strategy(strategy_id, root)
    if row.get("paper") and not force:
        raise ValueError("turn paper trading off before deleting this strategy")
    path = builder_dir(root) / f"{row['id']}.json"
    path.unlink()
    return {"id": row["id"], "deleted": True}


def set_paper(strategy_id: str, enabled: bool, root=None) -> dict:
    row = load_strategy(strategy_id, root)
    row["paper"] = bool(enabled)
    if row["paper"]:
        parse_script(row.get("script") or "")
        if not row.get("symbols"):
            raise ValueError("add at least one symbol before enabling paper trading")
    row["updated"] = _stamp()
    (builder_dir(root) / f"{row['id']}.json").write_text(json.dumps(row, indent=2) + "\n", encoding="utf-8")
    return row


EXAMPLES = [
    {
        "id": "orb-breakout",
        "name": "ORB-style breakout",
        "blurb": "First-5-minute range break with RVOL and a $20 floor. One trade a day, flat by 2:50 PM CT.",
        "script": """name ORB-style breakout
timeframe 5m
session 08:36-10:00
flat by 14:50
side both
max trades 1
price min 20
rvol5 min 5
respect market mood
take profit 0.5%
stop 2%
long when close crosses_above or_high and rvol5 > 5 and close > 20
short when close crosses_below or_low and rvol5 > 5 and close > 20
""",
    },
    {
        "id": "ema-pullback",
        "name": "EMA pullback",
        "blurb": "Daily uptrend: EMA20 above EMA50, RSI above 50, and a dip that holds the 20 EMA.",
        "script": """name EMA pullback
timeframe daily
side long
max trades 1
price min 5
respect market mood
take profit 1%
stop 2%
long when ema(20) > ema(50) and rsi(14) > 50 and low <= ema(20) * 1.01 and close >= ema(20) * 0.98 and close > ema(50)
""",
    },
    {
        "id": "rsi-reversion",
        "name": "RSI mean reversion",
        "blurb": "15-minute fades: buy an RSI cross under 30 above VWAP, short a cross over 70 below VWAP.",
        "script": """name RSI mean reversion
timeframe 15m
session 08:45-14:30
flat by 14:50
side both
max trades 3
price min 20
ignore mood
take profit 0.5%
stop 1.5%
long when rsi(14) crosses_below 30 and close > vwap
short when rsi(14) crosses_above 70 and close < vwap
""",
    },
]
