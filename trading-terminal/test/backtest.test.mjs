import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  maxDrawdown,
  runBacktest,
  signalsSmaCross,
  simulateFills,
} from "../js/backtest.js";

function near(actual, expected, epsilon = 1e-8) {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= epsilon,
    `expected ${expected}, got ${actual}`,
  );
}

function flat(time, price, extras = {}) {
  return {
    time,
    open: extras.open ?? price,
    high: extras.high ?? Math.max(extras.open ?? price, extras.close ?? price),
    low: extras.low ?? Math.min(extras.open ?? price, extras.close ?? price),
    close: extras.close ?? price,
    volume: extras.volume ?? 1,
  };
}

describe("max drawdown", () => {
  it("is the largest peak-to-trough decline and does not reset after a new high", () => {
    near(maxDrawdown([100, 80, 130, 90]), 40 / 130);
  });

  it("is zero when equity never falls, and null when there is no curve", () => {
    near(maxDrawdown([10, 11, 12]), 0);
    near(maxDrawdown([5]), 0);
    assert.equal(maxDrawdown([]), null);
  });
});

describe("fills, fees, slippage, and drawdown", () => {
  it("fills the next bar's open and does not use the signal bar", () => {
    const candles = [
      flat(0, 10),
      flat(1, 50, { open: 10, close: 50 }),
      flat(2, 20),
      flat(3, 20),
      flat(4, 30),
    ];
    const result = simulateFills({
      candles,
      targetPosition: [0, 1, 1, 0, 0],
      initialCapital: 1000,
    });
    assert.equal(result.tradeCount, 1);
    near(result.trades[0].entryPrice, 20);
    near(result.trades[0].exitPrice, 30);
    near(result.finalEquity, 1500);
    near(result.return, 0.5);
    assert.equal(result.winRate, 1);
    assert.equal(result.openPosition, false);
  });

  it("does not open a trade when the only signal is on the last bar", () => {
    const candles = [flat(0, 10), flat(1, 12), flat(2, 14)];
    const result = simulateFills({
      candles,
      targetPosition: [0, 0, 1],
      initialCapital: 1000,
    });
    assert.equal(result.tradeCount, 0);
    assert.equal(result.winRate, null);
    assert.equal(result.openPosition, false);
    near(result.finalEquity, 1000);
    near(result.return, 0);
    near(result.maxDrawdown, 0);
  });

  it("marks an open position in the return and keeps it out of the win rate", () => {
    const candles = [flat(0, 10), flat(1, 15, { open: 10, close: 15 })];
    const result = simulateFills({
      candles,
      targetPosition: [1, 1],
      initialCapital: 100,
    });
    assert.equal(result.tradeCount, 0);
    assert.equal(result.winRate, null);
    assert.equal(result.openPosition, true);
    near(result.finalEquity, 150);
    near(result.return, 0.5);
  });

  it("charges fees on entry and exit, which can turn a higher exit into a loss", () => {
    const candles = [flat(0, 10), flat(1, 10), flat(2, 12)];
    const paid = simulateFills({
      candles,
      targetPosition: [1, 0, 0],
      feeBps: 1000,
      initialCapital: 1000,
    });
    const free = simulateFills({
      candles,
      targetPosition: [1, 0, 0],
      feeBps: 0,
      initialCapital: 1000,
    });
    near(free.finalEquity, 1200);
    near(paid.finalEquity, 972);
    assert.ok(paid.finalEquity < free.finalEquity);
    assert.equal(paid.winRate, 0);
    assert.equal(paid.tradeCount, 1);
    near(paid.trades[0].pnl, -28);
  });

  it("buys higher and sells lower when slippage is set", () => {
    const candles = [flat(0, 10), flat(1, 10), flat(2, 12)];
    const slipped = simulateFills({
      candles,
      targetPosition: [1, 0, 0],
      slippageBps: 1000,
      initialCapital: 1000,
    });
    near(slipped.trades[0].entryPrice, 11);
    near(slipped.trades[0].exitPrice, 10.8);
    near(slipped.finalEquity, (1000 / 11) * 10.8);
    assert.ok(slipped.finalEquity < 1200);
  });

  it("applies fees and slippage together on both sides", () => {
    const candles = [flat(0, 10), flat(1, 10), flat(2, 12)];
    const result = simulateFills({
      candles,
      targetPosition: [1, 0, 0],
      feeBps: 100,
      slippageBps: 50,
      initialCapital: 10_000,
    });
    const entry = 10 * 1.005;
    const exit = 12 * 0.995;
    const spend = 10_000 * 0.99;
    const shares = spend / entry;
    const cash = shares * exit * 0.99;
    near(result.trades[0].entryPrice, entry);
    near(result.trades[0].exitPrice, exit);
    near(result.finalEquity, cash);
  });

  it("reports unrealized drawdown while a position is still open", () => {
    const candles = [
      flat(0, 10),
      flat(1, 10),
      flat(2, 10),
      flat(3, 5, { open: 10, close: 5 }),
      flat(4, 10, { open: 5, close: 10 }),
      flat(5, 10),
    ];
    const result = simulateFills({
      candles,
      targetPosition: [0, 1, 1, 1, 0, 0],
      initialCapital: 100,
    });
    near(result.trades[0].entryPrice, 10);
    near(result.trades[0].exitPrice, 10);
    near(result.finalEquity, 100);
    near(result.maxDrawdown, 0.5);
    assert.equal(result.winRate, 0);
    const marked = result.equity.map((point) => point.equity);
    near(marked[3], 50);
    assert.equal(result.maxDrawdown, maxDrawdown(marked));
  });

  it("counts wins only when round-trip cash increases", () => {
    const candles = [
      flat(0, 10),
      flat(1, 10),
      flat(2, 12),
      flat(3, 12),
      flat(4, 10),
    ];
    const result = simulateFills({
      candles,
      targetPosition: [1, 0, 1, 0, 0],
      initialCapital: 100,
    });
    assert.equal(result.tradeCount, 2);
    assert.ok(result.trades[0].pnl > 0);
    assert.ok(result.trades[1].pnl < 0);
    near(result.winRate, 0.5);
    near(result.finalEquity, 100);
    near(result.maxDrawdown, 20 / 120);
  });

  it("refuses a fee or capital value outside the simulator bounds", () => {
    const candles = [flat(0, 10)];
    assert.throws(
      () => simulateFills({ candles, targetPosition: [0], feeBps: -1 }),
      RangeError,
    );
    assert.throws(
      () => simulateFills({ candles, targetPosition: [0], initialCapital: 0 }),
      RangeError,
    );
  });
});

describe("strategy rules", () => {
  it("goes long only after the fast average is above the slow average", () => {
    const prices = [10, 10, 10, 11, 13, 16, 14, 12, 11];
    const candles = prices.map((price, index) => flat(index, price));
    const signals = signalsSmaCross(candles, { fast: 2, slow: 3 });
    assert.deepEqual(signals, [0, 0, 0, 1, 1, 1, 1, 0, 0]);
    const result = runBacktest(candles, {
      strategy: "sma",
      fast: 2,
      slow: 3,
      feeBps: 0,
      slippageBps: 0,
      initialCapital: 1300,
    });
    assert.equal(result.tradeCount, 1);
    near(result.trades[0].entryPrice, 13);
    near(result.trades[0].exitPrice, 11);
    near(result.finalEquity, 1100);
    near(result.return, -200 / 1300);
    near(result.maxDrawdown, 500 / 1600);
    assert.equal(result.winRate, 0);
  });

  it("reduces that same cross trade when fees are charged", () => {
    const prices = [10, 10, 10, 11, 13, 16, 14, 12, 11];
    const candles = prices.map((price, index) => flat(index, price));
    const result = runBacktest(candles, {
      strategy: "sma",
      fast: 2,
      slow: 3,
      feeBps: 100,
      slippageBps: 0,
      initialCapital: 1300,
    });
    near(result.finalEquity, 1078.11);
    assert.ok(result.finalEquity < 1100);
  });

  it("enters RSI only below the lower threshold and exits only above the upper one", () => {
    const candles = [
      flat(0, 10),
      flat(1, 9, { open: 10, close: 9 }),
      flat(2, 8, { open: 20, close: 8 }),
      flat(3, 11, { open: 21, close: 11 }),
      flat(4, 12, { open: 30, close: 12 }),
    ];
    const result = runBacktest(candles, {
      strategy: "rsi",
      period: 1,
      oversold: 30,
      overbought: 70,
      feeBps: 0,
      slippageBps: 0,
      initialCapital: 100,
    });
    assert.equal(result.tradeCount, 1);
    near(result.trades[0].entryPrice, 20);
    near(result.trades[0].exitPrice, 30);
    near(result.finalEquity, 150);
    near(result.return, 0.5);
    near(result.maxDrawdown, 0.6);
    assert.equal(result.winRate, 1);
  });

  it("rejects an inverted RSI band and an unknown strategy", () => {
    const candles = [flat(0, 1), flat(1, 1)];
    assert.throws(
      () => runBacktest(candles, { strategy: "rsi", oversold: 80, overbought: 20 }),
      RangeError,
    );
    assert.throws(() => runBacktest(candles, { strategy: "breakout" }), RangeError);
    assert.throws(
      () => runBacktest(candles, { strategy: "sma", fast: 5, slow: 5 }),
      RangeError,
    );
  });
});
