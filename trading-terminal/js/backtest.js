/**
 * Long-or-flat spot simulator.
 * A signal is the desired position after that candle closes, using only data
 * through that close. The fill is the next candle's open. Buy slippage raises
 * the fill and sell slippage lowers it. Fees are charged on entry cash and on
 * exit proceeds. Equity is marked at each close after that bar's open fill.
 * Completed round trips win only when ending cash is greater than starting cash.
 * An open position is marked in the equity curve and total return, and is
 * excluded from win rate and trade count.
 */
import { sma, rsi } from "./indicators.js";

function assertPeriod(period, label) {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`${label} period must be an integer >= 1`);
  }
}

function assertBps(value, label) {
  if (!Number.isFinite(value) || value < 0 || value > 10_000) {
    throw new RangeError(
      `${label} must be a finite number of basis points from 0 through 10000`,
    );
  }
}

export function maxDrawdown(equity) {
  if (!equity.length) return null;
  let peak = equity[0];
  let worst = 0;
  for (const value of equity) {
    if (!Number.isFinite(value)) {
      throw new RangeError("Equity values must be finite numbers");
    }
    if (value > peak) peak = value;
    if (peak > 0) {
      const decline = (peak - value) / peak;
      if (decline > worst) worst = decline;
    }
  }
  return worst;
}

export function signalsSmaCross(candles, { fast = 10, slow = 30 } = {}) {
  assertPeriod(fast, "Fast SMA");
  assertPeriod(slow, "Slow SMA");
  if (fast >= slow) {
    throw new RangeError(
      "Fast moving-average period must be shorter than the slow period",
    );
  }
  const closes = candles.map((candle) => candle.close);
  const fastAverage = sma(closes, fast);
  const slowAverage = sma(closes, slow);
  return fastAverage.map((value, index) => {
    const slowValue = slowAverage[index];
    if (value == null || slowValue == null) return 0;
    return value > slowValue ? 1 : 0;
  });
}

export function signalsRsi(
  candles,
  { period = 14, oversold = 30, overbought = 70 } = {},
) {
  assertPeriod(period, "RSI");
  if (
    !Number.isFinite(oversold) ||
    !Number.isFinite(overbought) ||
    oversold < 0 ||
    overbought > 100 ||
    oversold >= overbought
  ) {
    throw new RangeError(
      "RSI thresholds must satisfy 0 <= oversold < overbought <= 100",
    );
  }
  const values = rsi(
    candles.map((candle) => candle.close),
    period,
  );
  const out = Array(candles.length).fill(0);
  let position = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value != null && position === 0 && value < oversold) position = 1;
    else if (value != null && position === 1 && value > overbought) position = 0;
    out[index] = position;
  }
  return out;
}

function targetAt(targetPosition, index) {
  return targetPosition[index] ? 1 : 0;
}

export function simulateFills({
  candles,
  targetPosition,
  feeBps = 0,
  slippageBps = 0,
  initialCapital = 10_000,
}) {
  if (!Array.isArray(candles)) throw new TypeError("Candles must be an array");
  if (!Array.isArray(targetPosition)) {
    throw new TypeError("Target positions must be an array");
  }
  assertBps(feeBps, "Fee");
  assertBps(slippageBps, "Slippage");
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) {
    throw new RangeError("Initial capital must be a finite number > 0");
  }
  const fee = feeBps / 10_000;
  const slip = slippageBps / 10_000;
  let cash = initialCapital;
  let shares = 0;
  let entryCash = null;
  let entry = null;
  let pending = null;
  const trades = [];
  const equity = [];

  for (let index = 0; index < candles.length; index += 1) {
    const bar = candles[index];
    if (pending === "buy" && shares === 0) {
      const fill = bar.open * (1 + slip);
      const spend = cash - cash * fee;
      if (fill > 0 && spend > 0 && cash > 0) {
        shares = spend / fill;
        entryCash = cash;
        entry = { time: bar.time, price: fill, index };
        cash = 0;
      }
    } else if (pending === "sell" && shares > 0 && entry && entryCash != null) {
      const fill = bar.open * (1 - slip);
      if (fill > 0) {
        const gross = shares * fill;
        const nextCash = gross - gross * fee;
        trades.push({
          entryTime: entry.time,
          entryPrice: entry.price,
          exitTime: bar.time,
          exitPrice: fill,
          pnl: nextCash - entryCash,
          return: entryCash === 0 ? null : (nextCash - entryCash) / entryCash,
        });
        cash = nextCash;
        shares = 0;
        entry = null;
        entryCash = null;
      }
    }
    pending = null;

    const mark = Number.isFinite(bar.close) ? bar.close : bar.open;
    equity.push({ time: bar.time, equity: cash + shares * mark });

    const desired = targetAt(targetPosition, index);
    const held = shares > 0 ? 1 : 0;
    if (desired === 1 && held === 0) pending = "buy";
    else if (desired === 0 && held === 1) pending = "sell";
  }

  const finalEquity = equity.length ? equity[equity.length - 1].equity : initialCapital;
  const wins = trades.filter((trade) => trade.pnl > 0).length;
  return {
    initialCapital,
    finalEquity,
    return: (finalEquity - initialCapital) / initialCapital,
    maxDrawdown: maxDrawdown(equity.map((point) => point.equity)),
    winRate: trades.length === 0 ? null : wins / trades.length,
    tradeCount: trades.length,
    equity,
    trades,
    openPosition: shares > 0,
    barCount: candles.length,
  };
}

export function runBacktest(candles, options = {}) {
  if (!Array.isArray(candles)) throw new TypeError("Candles must be an array");
  const feeBps = options.feeBps ?? 0;
  const slippageBps = options.slippageBps ?? 0;
  const initialCapital = options.initialCapital ?? 10_000;
  let targetPosition;
  if (options.strategy === "sma") {
    targetPosition = signalsSmaCross(candles, options);
  } else if (options.strategy === "rsi") {
    targetPosition = signalsRsi(candles, options);
  } else {
    throw new RangeError('Strategy must be "sma" or "rsi"');
  }
  return simulateFills({
    candles,
    targetPosition,
    feeBps,
    slippageBps,
    initialCapital,
  });
}
