"""Indicator and backtest math for the AlpacaDesk chart page.

Pure functions: no Flask, no broker client, and no order placement.
SMA is an arithmetic mean. EMA is seeded with that SMA, then uses
2 / (period + 1). RSI uses Wilder smoothing and is 100 when average
loss is 0. MACD is EMA(fast) - EMA(slow); the signal is an EMA of that
line. Bollinger Bands use the population standard deviation (divide by N).
Intraday VWAP resets on the America/New_York date. Daily and weekly VWAP
accumulates across the loaded bars.

The simulator is long or flat. A signal uses only data through that bar's
close and fills at the next bar's open.
"""
import datetime as dt
import math
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
ASSUMPTIONS = (
    "Long or flat. A signal uses only bars through that close and fills at the next bar's open. "
    "Buy slippage raises the fill and sell slippage lowers it. "
    "Fees are charged on the cash used to enter and on the proceeds of the exit. "
    "An open position is marked in the equity curve and the total return, and it is excluded from the win rate and the trade count. "
    "This simulation does not place orders."
)


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _period(value, label):
    if isinstance(value, bool):
        raise ValueError("%s period must be an integer >= 1" % label)
    if isinstance(value, float):
        if not value.is_integer():
            raise ValueError("%s period must be an integer >= 1" % label)
        value = int(value)
    if not isinstance(value, int) or value < 1:
        raise ValueError("%s period must be an integer >= 1" % label)
    return value


def _bps(value, label):
    if not _finite(value) or value < 0 or value > 10000:
        raise ValueError("%s must be a finite number of basis points from 0 through 10000" % label)
    return float(value)


def _capital(value):
    if not _finite(value) or value <= 0:
        raise ValueError("Initial capital must be a finite number > 0")
    return float(value)


def sma(values, period):
    period = _period(period, "SMA")
    out = [None] * len(values)
    for end in range(period - 1, len(values)):
        window = values[end - period + 1:end + 1]
        if any(not _finite(item) for item in window):
            continue
        out[end] = sum(window) / period
    return out


def ema(values, period):
    period = _period(period, "EMA")
    out = [None] * len(values)
    multiplier = 2.0 / (period + 1)
    seed_sum = 0.0
    seed_count = 0
    previous = None
    for index, value in enumerate(values):
        if not _finite(value):
            seed_sum = 0.0
            seed_count = 0
            previous = None
            continue
        if previous is None:
            seed_sum += value
            seed_count += 1
            if seed_count == period:
                previous = seed_sum / period
                out[index] = previous
            continue
        previous = (value - previous) * multiplier + previous
        out[index] = previous
    return out


def _rsi_from_averages(average_gain, average_loss):
    if average_loss == 0:
        return 100.0
    return 100.0 - 100.0 / (1.0 + average_gain / average_loss)


def rsi(values, period):
    period = _period(period, "RSI")
    out = [None] * len(values)
    average_gain = None
    average_loss = None
    seed_gain = 0.0
    seed_loss = 0.0
    seed_count = 0
    previous_close = None
    for index, value in enumerate(values):
        if not _finite(value):
            average_gain = None
            average_loss = None
            seed_gain = 0.0
            seed_loss = 0.0
            seed_count = 0
            previous_close = None
            continue
        if previous_close is None:
            previous_close = value
            continue
        change = value - previous_close
        previous_close = value
        gain = change if change > 0 else 0.0
        loss = -change if change < 0 else 0.0
        if average_gain is None:
            seed_gain += gain
            seed_loss += loss
            seed_count += 1
            if seed_count == period:
                average_gain = seed_gain / period
                average_loss = seed_loss / period
                out[index] = _rsi_from_averages(average_gain, average_loss)
            continue
        average_gain = (average_gain * (period - 1) + gain) / period
        average_loss = (average_loss * (period - 1) + loss) / period
        out[index] = _rsi_from_averages(average_gain, average_loss)
    return out


def macd(values, fast=12, slow=26, signal=9):
    fast = _period(fast, "MACD fast")
    slow = _period(slow, "MACD slow")
    signal = _period(signal, "MACD signal")
    if fast >= slow:
        raise ValueError("MACD fast period must be shorter than the slow period")
    fast_ema = ema(values, fast)
    slow_ema = ema(values, slow)
    line = []
    for index in range(len(values)):
        if fast_ema[index] is None or slow_ema[index] is None:
            line.append(None)
        else:
            line.append(fast_ema[index] - slow_ema[index])
    signal_line = ema(line, signal)
    histogram = []
    for index, value in enumerate(line):
        if value is None or signal_line[index] is None:
            histogram.append(None)
        else:
            histogram.append(value - signal_line[index])
    return {"macd": line, "signal": signal_line, "histogram": histogram}


def bollinger(values, period=20, multiplier=2):
    period = _period(period, "Bollinger")
    if not _finite(multiplier) or multiplier < 0:
        raise ValueError("Bollinger multiplier must be a finite number >= 0")
    middle = sma(values, period)
    upper = [None] * len(values)
    lower = [None] * len(values)
    for end in range(period - 1, len(values)):
        if middle[end] is None:
            continue
        sum_squares = 0.0
        for index in range(end - period + 1, end + 1):
            delta = values[index] - middle[end]
            sum_squares += delta * delta
        deviation = math.sqrt(sum_squares / period)
        upper[end] = middle[end] + multiplier * deviation
        lower[end] = middle[end] - multiplier * deviation
    return {"middle": middle, "upper": upper, "lower": lower}


def _num(bar, key):
    if not isinstance(bar, dict):
        return None
    value = bar.get(key)
    if not _finite(value):
        return None
    return float(value)


def vwap(bars, tf="5m"):
    """Typical price is (high + low + close) / 3. Intraday sessions reset at the New York date."""
    out = []
    reset = tf not in ("1D", "1W")
    day = None
    priced_volume = 0.0
    volume_sum = 0.0
    for bar in bars:
        if reset:
            stamp = _num(bar, "time")
            if stamp is None:
                out.append(None)
                continue
            next_day = dt.datetime.fromtimestamp(stamp, tz=dt.timezone.utc).astimezone(NY).date()
            if next_day != day:
                day = next_day
                priced_volume = 0.0
                volume_sum = 0.0
        typical = None
        high, low, close = _num(bar, "high"), _num(bar, "low"), _num(bar, "close")
        if high is not None and low is not None and close is not None:
            typical = (high + low + close) / 3.0
        volume = _num(bar, "volume")
        if typical is not None and volume is not None and volume > 0:
            priced_volume += typical * volume
            volume_sum += volume
        out.append(priced_volume / volume_sum if volume_sum > 0 else None)
    return out


def volumes(bars):
    return [_num(bar, "volume") for bar in bars]


def pack(bars, tf):
    closes = [bar.get("close") if isinstance(bar, dict) else None for bar in bars]
    bands = bollinger(closes, 20, 2)
    macd_lines = macd(closes, 12, 26, 9)
    return {
        "sma20": sma(closes, 20),
        "sma50": sma(closes, 50),
        "sma200": sma(closes, 200),
        "ema20": ema(closes, 20),
        "bb_middle": bands["middle"],
        "bb_upper": bands["upper"],
        "bb_lower": bands["lower"],
        "vwap": vwap(bars, tf),
        "vwap_label": "Cumulative VWAP" if tf in ("1D", "1W") else "Session VWAP",
        "rsi": rsi(closes, 14),
        "macd": macd_lines["macd"],
        "macd_signal": macd_lines["signal"],
        "macd_histogram": macd_lines["histogram"],
    }


def max_drawdown(equity):
    if not equity:
        return None
    peak = equity[0]
    worst = 0.0
    for value in equity:
        if not _finite(value):
            raise ValueError("Equity values must be finite numbers")
        if value > peak:
            peak = value
        if peak > 0:
            decline = (peak - value) / peak
            if decline > worst:
                worst = decline
    return worst


def signals_sma_cross(bars, fast=10, slow=30):
    fast = _period(fast, "Fast SMA")
    slow = _period(slow, "Slow SMA")
    if fast >= slow:
        raise ValueError("Fast moving-average period must be shorter than the slow period")
    closes = [bar.get("close") if isinstance(bar, dict) else None for bar in bars]
    fast_average = sma(closes, fast)
    slow_average = sma(closes, slow)
    signals = []
    for index, value in enumerate(fast_average):
        slow_value = slow_average[index]
        signals.append(1 if value is not None and slow_value is not None and value > slow_value else 0)
    return signals


def signals_rsi(bars, period=14, oversold=30, overbought=70):
    period = _period(period, "RSI")
    if (not _finite(oversold) or not _finite(overbought) or oversold < 0 or overbought > 100
            or oversold >= overbought):
        raise ValueError("RSI thresholds must satisfy 0 <= oversold < overbought <= 100")
    closes = [bar.get("close") if isinstance(bar, dict) else None for bar in bars]
    values = rsi(closes, period)
    position = 0
    out = []
    for value in values:
        if value is not None and position == 0 and value < oversold:
            position = 1
        elif value is not None and position == 1 and value > overbought:
            position = 0
        out.append(position)
    return out


def _opt(options, key, default):
    if not isinstance(options, dict) or key not in options or options[key] is None:
        return default
    return options[key]


def simulate_fills(bars, target_position, fee_bps=0, slippage_bps=0, initial_capital=10000):
    if not isinstance(bars, list):
        raise TypeError("Bars must be a list")
    if not isinstance(target_position, list):
        raise TypeError("Target positions must be a list")
    fee = _bps(fee_bps, "Fee") / 10000.0
    slip = _bps(slippage_bps, "Slippage") / 10000.0
    initial_capital = _capital(initial_capital)
    cash = initial_capital
    shares = 0.0
    entry_cash = None
    entry = None
    pending = None
    trades = []
    equity = []
    for index, bar in enumerate(bars):
        if not isinstance(bar, dict):
            raise TypeError("Each bar must be an object")
        opened = _num(bar, "open")
        close = _num(bar, "close")
        if pending == "buy" and shares == 0 and opened is not None:
            fill = opened * (1.0 + slip)
            spend = cash - cash * fee
            if fill > 0 and spend > 0 and cash > 0:
                shares = spend / fill
                entry_cash = cash
                entry = {"time": bar.get("time"), "price": fill}
                cash = 0.0
        elif pending == "sell" and shares > 0 and entry is not None and entry_cash is not None and opened is not None:
            fill = opened * (1.0 - slip)
            if fill > 0:
                gross = shares * fill
                next_cash = gross - gross * fee
                trades.append({
                    "entry_time": entry["time"],
                    "entry_price": entry["price"],
                    "exit_time": bar.get("time"),
                    "exit_price": fill,
                    "pnl": next_cash - entry_cash,
                    "return": None if entry_cash == 0 else (next_cash - entry_cash) / entry_cash,
                })
                cash = next_cash
                shares = 0.0
                entry = None
                entry_cash = None
        pending = None
        mark = close if close is not None else opened
        if mark is None:
            raise ValueError("Each bar needs a finite open or close")
        equity.append({"time": bar.get("time"), "equity": cash + shares * mark})
        desired = 1 if index < len(target_position) and target_position[index] else 0
        held = 1 if shares > 0 else 0
        if desired == 1 and held == 0:
            pending = "buy"
        elif desired == 0 and held == 1:
            pending = "sell"
    final_equity = equity[-1]["equity"] if equity else initial_capital
    wins = len([trade for trade in trades if trade["pnl"] > 0])
    curve = [point["equity"] for point in equity]
    return {
        "initial_capital": initial_capital,
        "final_equity": final_equity,
        "return": (final_equity - initial_capital) / initial_capital,
        "max_drawdown": max_drawdown(curve),
        "win_rate": None if not trades else wins / len(trades),
        "trade_count": len(trades),
        "equity": equity,
        "trades": trades,
        "open_position": shares > 0,
        "bar_count": len(bars),
        "assumptions": ASSUMPTIONS,
    }


def run_backtest(bars, options=None):
    if not isinstance(bars, list):
        raise TypeError("Bars must be a list")
    options = options or {}
    strategy = _opt(options, "strategy", None)
    fee_bps = _opt(options, "fee_bps", 0)
    slippage_bps = _opt(options, "slippage_bps", 0)
    initial_capital = _opt(options, "initial_capital", 10000)
    if strategy == "sma":
        target = signals_sma_cross(bars, _opt(options, "fast", 10), _opt(options, "slow", 30))
    elif strategy == "rsi":
        target = signals_rsi(
            bars,
            _opt(options, "period", 14),
            _opt(options, "oversold", 30),
            _opt(options, "overbought", 70),
        )
    else:
        raise ValueError('Strategy must be "sma" or "rsi"')
    return simulate_fills(bars, target, fee_bps, slippage_bps, initial_capital)
