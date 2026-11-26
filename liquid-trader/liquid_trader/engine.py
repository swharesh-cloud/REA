"""Bot engine: accounting, risk controls, paper/live execution, and backtesting."""
from __future__ import annotations

import json
import os
import threading
import time
import traceback
import uuid
from collections import deque

from .market import INTERVALS, interval_ms
from .notify import Notifier
from .strategies import STRATEGIES, fp, make_strategy

MIN_ORDER_USD = 10.0     # Hyperliquid's minimum order value
TAKER_FEE = 0.00045      # paper-trading fee estimate (0.045%)
PAPER_SLIPPAGE = 0.0002  # paper-trading slippage estimate (0.02%)


# ---------------------------------------------------------------------------
class Book:
    """Position accounting for one bot (size in coin, signed: + long / − short)."""

    def __init__(self, budget: float):
        self.budget = budget
        self.size = 0.0
        self.entry = 0.0
        self.realized = 0.0
        self.fees = 0.0
        self.closed_pnls: list = []

    def apply(self, side: str, coin: float, price: float, fee: float) -> float:
        signed = coin if side == "buy" else -coin
        self.fees += fee
        realized = 0.0
        if self.size == 0 or (self.size > 0) == (signed > 0):
            new = self.size + signed
            self.entry = (self.entry * abs(self.size) + price * abs(signed)) / abs(new)
            self.size = new
        else:
            closing = min(abs(signed), abs(self.size))
            realized = closing * (price - self.entry) * (1 if self.size > 0 else -1)
            self.realized += realized
            flipped = abs(signed) > abs(self.size) + 1e-12
            self.size += signed
            if abs(self.size) < 1e-10 or abs(self.size * price) < 0.01:
                self.size, self.entry = 0.0, 0.0
            elif flipped:
                self.entry = price
            self.closed_pnls.append(realized)
        return realized

    def unrealized(self, price):
        return self.size * (price - self.entry) if self.size else 0.0

    def equity(self, price):
        return self.budget + self.realized - self.fees + self.unrealized(price)

    def to_dict(self):
        return {"budget": self.budget, "size": self.size, "entry": self.entry, "realized": self.realized,
                "fees": self.fees, "closed_pnls": self.closed_pnls[-500:]}

    @classmethod
    def from_dict(cls, d):
        b = cls(d["budget"])
        b.size, b.entry, b.realized, b.fees = d["size"], d["entry"], d["realized"], d["fees"]
        b.closed_pnls = d.get("closed_pnls", [])
        return b


# ---------------------------------------------------------------------------
class PaperExecutor:
    live = False

    def execute(self, symbol, side, coin, price, leverage):
        fill = price * (1 + PAPER_SLIPPAGE if side == "buy" else 1 - PAPER_SLIPPAGE)
        return {"price": fill, "coin": coin, "fee": coin * fill * TAKER_FEE, "order_id": "paper-" + uuid.uuid4().hex[:8]}


class LiveExecutor:
    live = True

    def __init__(self, client):
        self.client = client

    def execute(self, symbol, side, coin, price, leverage):
        usd = coin * price
        res = self.client.place_order(symbol, side, usd, type="market", leverage=leverage) or {}
        try:
            fill = float(res.get("price") or price)
        except (TypeError, ValueError):
            fill = price
        return {"price": fill, "coin": usd / fill, "fee": usd * TAKER_FEE,
                "order_id": str(res.get("order_id", "")), "status": res.get("status")}


# ---------------------------------------------------------------------------
class Context:
    """What a strategy sees and can do on each tick."""

    def __init__(self, bot, price, bars, now_ms, executor, risk):
        self.bot, self._exec, self._risk = bot, executor, risk
        self.symbol = bot.symbol
        self.price = price
        self.bars = bars
        self.closes = [b["c"] for b in bars]
        self.now_ms = now_ms
        self.state = bot.state
        self.max_notional = bot.budget * bot.leverage
        self.fills = []

    @property
    def position(self):
        return self.bot.book.size

    @property
    def entry(self):
        return self.bot.book.entry

    @property
    def notional(self):
        return self.bot.book.size * self.price

    def log(self, msg):
        self.bot.log(msg, self.now_ms)

    def new_bar(self):
        if not self.bars:
            return False
        t = self.bars[-1]["t"]
        if self.state.get("_last_bar") == t:
            return False
        self.state["_last_bar"] = t
        return True

    # ---- orders ----
    def trade_coin(self, side, coin, reason="", reduce_only=False):
        book = self.bot.book
        if coin <= 0:
            return None
        signed = coin if side == "buy" else -coin
        reducing = book.size != 0 and (book.size > 0) != (signed > 0)
        if reduce_only or reducing:
            if reduce_only and not reducing:
                return None
            if reduce_only:
                coin = min(coin, abs(book.size))
        if not reducing:
            room = self.max_notional - abs(book.size) * self.price
            coin = min(coin, max(room, 0) / self.price)
            coin = min(coin, self._risk.get("max_order_usd", 1e18) / self.price)
        elif abs(signed) > abs(book.size):  # flip: clamp the new side
            extra = min(coin - abs(book.size), self.max_notional / self.price,
                        self._risk.get("max_order_usd", 1e18) / self.price)
            coin = abs(book.size) + max(extra, 0)
        closing_all = reducing and abs(coin - abs(book.size)) / max(abs(book.size), 1e-18) < 1e-9
        if coin * self.price < MIN_ORDER_USD and not closing_all:
            return None
        fill = self._exec.execute(self.symbol, side, coin, self.price, self.bot.leverage)
        if closing_all:
            fill["coin"] = abs(book.size)
        pnl = book.apply(side, fill["coin"], fill["price"], fill["fee"])
        trade = {"t": self.now_ms, "side": side, "coin": fill["coin"], "price": fill["price"],
                 "usd": fill["coin"] * fill["price"], "fee": fill["fee"], "pnl": pnl, "reason": reason,
                 "order_id": fill.get("order_id", "")}
        self.bot.record_trade(trade)
        self.fills.append(trade)
        self.log(f"{side.upper()} {fill['coin']:.6g} @ {fp(fill['price'])} (${trade['usd']:.2f}) — {reason}")
        return trade

    def buy_usd(self, usd, reason=""):
        return self.trade_coin("buy", usd / self.price, reason)

    def sell_usd(self, usd, reason=""):
        return self.trade_coin("sell", usd / self.price, reason)

    def target_usd(self, target, reason=""):
        cur = self.bot.book.size * self.price
        if target == 0:
            return self.close(reason)
        diff = target - cur
        if abs(diff) < MIN_ORDER_USD:
            return None
        return self.trade_coin("buy" if diff > 0 else "sell", abs(diff) / self.price, reason)

    def close(self, reason=""):
        size = self.bot.book.size
        if size == 0:
            return None
        return self.trade_coin("sell" if size > 0 else "buy", abs(size), reason, reduce_only=True)


# ---------------------------------------------------------------------------
class Bot:
    def __init__(self, cfg: dict):
        self.id = cfg.get("id") or uuid.uuid4().hex[:8]
        self.name = cfg.get("name") or f"{STRATEGIES[cfg['strategy']].label} {cfg['symbol']}"
        self.strategy_key = cfg["strategy"]
        self.symbol = cfg["symbol"]
        self.interval = cfg.get("interval", "5m")
        if self.interval not in INTERVALS:
            raise ValueError("Bad interval")
        self.params = cfg.get("params", {})
        self.mode = cfg.get("mode", "paper")
        if self.mode not in ("paper", "live"):
            raise ValueError("mode must be paper or live")
        self.budget = float(cfg.get("budget", 1000))
        self.leverage = float(cfg.get("leverage", 1))
        if self.budget < MIN_ORDER_USD:
            raise ValueError(f"Budget must be at least ${MIN_ORDER_USD:.0f}")
        if not 1 <= self.leverage <= 50:
            raise ValueError("Leverage must be between 1 and 50")
        self.stop_loss_pct = float(cfg.get("stop_loss_pct") or 0)
        self.take_profit_pct = float(cfg.get("take_profit_pct") or 0)
        self.max_drawdown_pct = float(cfg.get("max_drawdown_pct") or 0)
        self.poll_seconds = float(cfg.get("poll_seconds") or 0)
        self.strategy = make_strategy(self.strategy_key, self.params)
        self.book = Book.from_dict(cfg["book"]) if cfg.get("book") else Book(self.budget)
        self.state = cfg.get("state", {})
        self.running = False
        self.resume = bool(cfg.get("running"))  # was running before the app/engine restarted
        self.status = cfg.get("status", "stopped")
        self.error = cfg.get("error", "")
        self.created = cfg.get("created", time.time())
        self.logs = deque(cfg.get("logs", []), maxlen=400)
        self.trades = deque(cfg.get("trades", []), maxlen=1000)
        self.equity_curve = deque(cfg.get("equity_curve", []), maxlen=1500)
        self.peak_equity = cfg.get("peak_equity", self.budget)
        self.last_price = cfg.get("last_price", 0.0)
        self.last_tick = 0.0
        self.lock = threading.RLock()

    def log(self, msg, t_ms=None):
        self.logs.append({"t": t_ms or int(time.time() * 1000), "msg": msg})

    def record_trade(self, trade):
        self.trades.append(trade)

    def summary(self):
        p = self.last_price
        eq = self.book.equity(p) if p else self.budget
        wins = [x for x in self.book.closed_pnls if x > 0]
        return {
            "id": self.id, "name": self.name, "strategy": self.strategy_key,
            "strategy_label": STRATEGIES[self.strategy_key].label, "symbol": self.symbol,
            "interval": self.interval, "mode": self.mode, "budget": self.budget, "leverage": self.leverage,
            "params": self.strategy.p, "status": self.status, "error": self.error,
            "stop_loss_pct": self.stop_loss_pct, "take_profit_pct": self.take_profit_pct,
            "max_drawdown_pct": self.max_drawdown_pct, "poll_seconds": self.poll_seconds,
            "price": p, "position": self.book.size, "entry": self.book.entry,
            "notional": self.book.size * p, "realized": self.book.realized, "fees": self.book.fees,
            "unrealized": self.book.unrealized(p) if p else 0.0, "equity": eq,
            "return_pct": (eq / self.budget - 1) * 100, "trades": len(self.trades),
            "win_rate": (len(wins) / len(self.book.closed_pnls) * 100) if self.book.closed_pnls else None,
            "created": self.created,
        }

    def to_config(self):
        return {"id": self.id, "name": self.name, "strategy": self.strategy_key, "symbol": self.symbol,
                "interval": self.interval, "params": self.strategy.p, "mode": self.mode, "budget": self.budget,
                "leverage": self.leverage, "stop_loss_pct": self.stop_loss_pct,
                "take_profit_pct": self.take_profit_pct, "max_drawdown_pct": self.max_drawdown_pct,
                "poll_seconds": self.poll_seconds, "book": self.book.to_dict(), "state": self.state,
                "status": "stopped" if self.status == "running" else self.status, "error": self.error,
                "running": self.running,
                "created": self.created, "logs": list(self.logs)[-100:], "trades": list(self.trades)[-300:],
                "equity_curve": list(self.equity_curve)[-500:], "peak_equity": self.peak_equity,
                "last_price": self.last_price}


def run_tick(bot: Bot, price: float, bars: list, now_ms: int, executor, risk: dict):
    """One strategy step with the generic risk rules applied. Shared by live engine and backtester."""
    ctx = Context(bot, price, bars, now_ms, executor, risk)
    book = bot.book
    bot.last_price = price
    if book.size:
        move = (price / book.entry - 1) * 100 * (1 if book.size > 0 else -1)
        if bot.stop_loss_pct and move <= -bot.stop_loss_pct:
            ctx.close(f"stop-loss {move:.2f}%")
            bot.strategy.on_flat(ctx)
        elif bot.take_profit_pct and move >= bot.take_profit_pct:
            ctx.close(f"take-profit +{move:.2f}%")
            bot.strategy.on_flat(ctx)
    bot.strategy.on_tick(ctx)
    eq = book.equity(price)
    bot.peak_equity = max(bot.peak_equity, eq)
    halted = False
    if bot.max_drawdown_pct and eq < bot.peak_equity * (1 - bot.max_drawdown_pct / 100):
        ctx.close(f"max drawdown {bot.max_drawdown_pct}% hit — bot halted")
        bot.strategy.on_flat(ctx)
        halted = True
    return ctx, halted


def closed_bars(bars, interval, now_ms):
    ms = interval_ms(interval)
    return [b for b in bars if b["t"] + ms <= now_ms]


# ---------------------------------------------------------------------------
class Engine:
    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self.market = None
        self.client = None
        self.bots: dict = {}
        self.lock = threading.RLock()
        self.kill_switch = False
        self.risk = {"max_order_usd": 5000.0, "max_total_live_usd": 20000.0}
        self.settings = {"source": "liquid"}  # preferred data source when an API key exists
        self.events = deque(maxlen=200)
        self._stop = threading.Event()
        self._thread = None
        self.started_at = time.time()
        self.heartbeat = time.time()
        self.notifier = Notifier()
        self._save_lock = threading.Lock()
        self._load()
        self.notifier.url = os.environ.get("LT_NOTIFY_URL") or self.settings.get("notify_url", "")
        self.notifier.min_level = self.settings.get("notify_level", "trade")

    # ---- persistence ----
    @property
    def _path(self):
        return os.path.join(self.data_dir, "bots.json")

    def _load(self):
        try:
            with open(self._path) as f:
                data = json.load(f)
        except (OSError, ValueError):
            return
        self.risk.update(data.get("risk", {}))
        self.settings.update(data.get("settings", {}))
        self.kill_switch = bool(data.get("kill_switch", False))
        for cfg in data.get("bots", []):
            try:
                b = Bot(cfg)
                self.bots[b.id] = b
            except Exception as e:  # keep going if one config is bad
                self.event(f"Could not load bot {cfg.get('name')}: {e}")

    def save(self):
        """Atomic, durable write (fsync + rename) so a crash or power cut never corrupts bots.json."""
        with self._save_lock:
            with self.lock:
                data = {"risk": self.risk, "settings": self.settings, "kill_switch": self.kill_switch,
                        "bots": [b.to_config() for b in self.bots.values()]}
            tmp = self._path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(data, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self._path)

    def event(self, msg, level="info"):
        self.events.append({"t": int(time.time() * 1000), "msg": msg,
                            "level": "info" if level in ("trade", "paper") else level})
        self.notifier.send(msg, level)

    def set_notify(self, url: str, min_level: str = "trade"):
        self.settings["notify_url"], self.settings["notify_level"] = url, min_level
        self.notifier.url = os.environ.get("LT_NOTIFY_URL") or url
        self.notifier.min_level = min_level

    # ---- lifecycle ----
    def set_market(self, market, client=None):
        with self.lock:
            changed = self.market is not None and self.market.name != market.name
            self.market, self.client = market, client
            if changed:
                for b in self.bots.values():
                    if b.running:
                        self._stop_bot(b, f"stopped: data source changed to {market.name}")

    def start(self):
        if self._thread:
            return
        self._thread = threading.Thread(target=self._loop, daemon=True, name="engine")
        self._thread.start()

    def shutdown(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=10)
        self.save()

    def _loop(self):
        last_save = time.time()
        while not self._stop.is_set():
            self.heartbeat = time.time()
            try:  # the loop must never die: one bad tick can't stop the other bots
                for bot in list(self.bots.values()):
                    if bot.running and time.time() - bot.last_tick >= self._poll(bot):
                        bot.last_tick = time.time()
                        self._tick(bot)
                if time.time() - last_save > 15:
                    last_save = time.time()
                    self.save()
            except Exception:
                traceback.print_exc()
            self._stop.wait(0.25)

    def resume_bots(self, live_ok: bool):
        """Restart bots that were running when the engine last stopped (24/7 operation)."""
        for b in self.bots.values():
            if not b.resume or b.running:
                continue
            if b.mode == "live" and not live_ok:
                b.error = "waiting for Liquid connection to resume"
                continue
            if self.kill_switch:
                continue
            b.resume = False
            b.running, b.status, b.error, b.last_tick = True, "running", "", 0
            b.log("resumed after restart")
            self.event(f"Resumed {b.name} ({b.mode})")

    def _poll(self, bot):
        if bot.poll_seconds:
            return bot.poll_seconds
        return 10.0 if self.market and self.market.live else 1.0

    def _tick(self, bot):
        if self.kill_switch:
            return
        with bot.lock:
            try:
                m = self.market
                price = m.price(bot.symbol)
                warm = max(bot.strategy.warmup() + 5, 60)
                bars = closed_bars(m.candles(bot.symbol, bot.interval, min(max(warm, 100), 200)),
                                   bot.interval, m.now_ms())
                executor = LiveExecutor(self.client) if bot.mode == "live" else PaperExecutor()
                if bot.mode == "live" and not m.live:
                    raise RuntimeError("Live bots need a Liquid connection")
                ctx, halted = run_tick(bot, price, bars, m.now_ms(), executor, self.risk)
                bot.equity_curve.append([m.now_ms(), round(bot.book.equity(price), 4)])
                bot.error = ""
                for tr in ctx.fills:
                    self.event(f"[{bot.name}] {tr['side'].upper()} {bot.symbol} ${tr['usd']:.2f} @ {fp(tr['price'])}"
                               + (f" — {tr['reason']}" if tr.get("reason") else "")
                               + (" (LIVE)" if bot.mode == "live" else ""),
                               "trade" if bot.mode == "live" else "paper")
                if bot.state.pop("_err_notified", False):
                    self.event(f"{bot.name}: recovered", "info")
                if ctx.fills:
                    self.save()  # persist every fill at once: a crash must never lose a position
                if halted:
                    self._stop_bot(bot, "halted by max drawdown")
            except Exception as e:
                bot.error = str(e)
                if not bot.state.get("_err_notified"):
                    bot.state["_err_notified"] = True
                    self.event(f"{bot.name}: error — {e}", "warn")
                bot.log(f"error: {e}")
                status = getattr(e, "status", None)
                transient = status is None or status == 429 or status >= 500  # network blips, outages
                if transient:
                    bot.log("transient error - will retry next tick")
                else:
                    bot.state["_errors"] = bot.state.get("_errors", 0) + 1
                    if bot.mode == "live" and bot.state["_errors"] >= 5:
                        self._stop_bot(bot, "stopped after 5 consecutive API rejections")
                traceback.print_exc()
            else:
                bot.state["_errors"] = 0

    # ---- bot management ----
    def create_bot(self, cfg):
        bot = Bot(cfg)
        if self.market and not self.market.live:
            self.market._check(bot.symbol)
        with self.lock:
            self.bots[bot.id] = bot
        bot.log(f"created ({bot.mode}, budget ${bot.budget:.2f}, {bot.leverage:g}x)")
        self.save()
        return bot

    def start_bot(self, bot_id, confirm_live=False):
        bot = self.bots[bot_id]
        if self.kill_switch:
            raise ValueError("Kill switch is engaged — reset it first")
        if bot.mode == "live":
            if not (self.market and self.market.live):
                raise ValueError("Connect your Liquid API key before starting a live bot")
            if not confirm_live:
                raise ValueError("Live bots require explicit confirmation")
            live_total = sum(b.budget * b.leverage for b in self.bots.values()
                             if b.mode == "live" and b.running) + bot.budget * bot.leverage
            if live_total > self.risk["max_total_live_usd"]:
                raise ValueError(f"Total live exposure ${live_total:,.0f} would exceed your limit "
                                 f"${self.risk['max_total_live_usd']:,.0f} (Risk settings)")
        bot.running, bot.status, bot.error = True, "running", ""
        bot.last_tick = 0
        bot.log("started")
        self.event(f"Started {bot.name} ({bot.mode})")
        self.save()

    def _stop_bot(self, bot, why="stopped"):
        bot.running = False
        bot.resume = False
        bot.status = "stopped"
        bot.log(why)
        bad = any(k in why for k in ("halt", "error", "after", "kill"))
        self.event(f"{bot.name}: {why}", "warn" if bad else "info")

    def stop_bot(self, bot_id):
        self._stop_bot(self.bots[bot_id])
        self.save()

    def flatten_bot(self, bot_id, reason="closed manually"):
        bot = self.bots[bot_id]
        with bot.lock:
            if bot.book.size == 0:
                return None
            m = self.market
            price = m.price(bot.symbol)
            executor = LiveExecutor(self.client) if bot.mode == "live" else PaperExecutor()
            ctx = Context(bot, price, [], m.now_ms(), executor, self.risk)
            tr = ctx.close(reason)
            bot.strategy.on_flat(ctx)
            self.save()
            return tr

    def delete_bot(self, bot_id):
        bot = self.bots[bot_id]
        if bot.book.size and bot.mode == "live":
            raise ValueError("Close this bot's live position before deleting it")
        with self.lock:
            del self.bots[bot_id]
        self.save()

    def engage_kill_switch(self, flatten=True):
        self.kill_switch = True
        results = []
        for b in self.bots.values():
            if b.running:
                self._stop_bot(b, "stopped by kill switch")
            if flatten and b.book.size:
                try:
                    results.append(self.flatten_bot(b.id, "kill switch"))
                except Exception as e:
                    self.event(f"Kill switch could not flatten {b.name}: {e}", "error")
        self.event("KILL SWITCH engaged" + (" — positions flattened" if flatten else ""), "error")
        self.save()
        return results


# ---------------------------------------------------------------------------
def backtest(strategy_key, params, bars, interval, budget=1000.0, leverage=1.0,
             stop_loss_pct=0, take_profit_pct=0, max_drawdown_pct=0, symbol="SIM"):
    """Replay closed candles through a strategy with paper fills at each bar's close."""
    bot = Bot({"strategy": strategy_key, "params": params, "symbol": symbol, "interval": interval,
               "budget": budget, "leverage": leverage, "stop_loss_pct": stop_loss_pct,
               "take_profit_pct": take_profit_pct, "max_drawdown_pct": max_drawdown_pct})
    executor = PaperExecutor()
    risk = {"max_order_usd": 1e18}
    curve, trades = [], []
    ms = interval_ms(interval)
    halted_at = None
    for i in range(len(bars)):
        hist = bars[: i + 1]
        price = bars[i]["c"]
        ctx, halted = run_tick(bot, price, hist, bars[i]["t"] + ms, executor, risk)
        trades.extend(ctx.fills)
        curve.append([bars[i]["t"], bot.book.equity(price)])
        if halted:
            halted_at = bars[i]["t"]
            break
    end_price = bars[-1]["c"] if bars else 0
    eq = [c[1] for c in curve] or [budget]
    peak, mdd = eq[0], 0.0
    for v in eq:
        peak = max(peak, v)
        mdd = max(mdd, (peak - v) / peak * 100 if peak else 0)
    closed = bot.book.closed_pnls
    wins = [x for x in closed if x > 0]
    losses = [x for x in closed if x < 0]
    rets = [(eq[i] / eq[i - 1] - 1) for i in range(1, len(eq)) if eq[i - 1]]
    sharpe = None
    if len(rets) > 2:
        mean = sum(rets) / len(rets)
        sd = (sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)) ** 0.5
        if sd > 0:
            sharpe = mean / sd * (365 * 24 * 60 / INTERVALS[interval]) ** 0.5
    return {
        "final_equity": eq[-1], "return_pct": (eq[-1] / budget - 1) * 100,
        "buy_hold_pct": (end_price / bars[0]["c"] - 1) * 100 * leverage if bars else 0,
        "max_drawdown_pct": mdd, "trades": len(trades), "round_trips": len(closed),
        "win_rate": len(wins) / len(closed) * 100 if closed else None,
        "profit_factor": (sum(wins) / -sum(losses)) if losses else None,
        "fees": bot.book.fees, "sharpe": sharpe, "open_position": bot.book.size,
        "halted_at": halted_at, "equity_curve": curve, "fills": trades, "bars": len(bars),
        "start": bars[0]["t"] if bars else None, "end": bars[-1]["t"] if bars else None,
    }
