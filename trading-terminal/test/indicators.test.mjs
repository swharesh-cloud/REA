import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bollinger,
  ema,
  macd,
  rsi,
  sma,
  volume,
  vwap,
} from "../js/indicators.js";

function near(actual, expected, epsilon = 1e-9) {
  assert.ok(
    actual != null && Math.abs(actual - expected) <= epsilon,
    `expected ${expected}, got ${actual}`,
  );
}

describe("SMA", () => {
  it("averages the trailing window and stays null until the window is full", () => {
    const result = sma([1, 2, 3, 4, 5], 3);
    assert.deepEqual(result.slice(0, 2), [null, null]);
    near(result[2], 2);
    near(result[3], 3);
    near(result[4], 4);
  });

  it("returns nulls when the series is shorter than the period", () => {
    assert.deepEqual(sma([1, 2], 5), [null, null]);
  });

  it("rejects a non-integer period", () => {
    assert.throws(() => sma([1, 2, 3], 1.5), RangeError);
  });
});

describe("EMA", () => {
  it("seeds with the SMA and then applies the 2/(n+1) multiplier", () => {
    const result = ema([10, 11, 12, 13], 3);
    assert.equal(result[0], null);
    assert.equal(result[1], null);
    near(result[2], 11);
    near(result[3], 12);
  });

  it("tracks the series itself when the period is 1", () => {
    assert.deepEqual(ema([4, 7, 2], 1), [4, 7, 2]);
  });
});

describe("RSI", () => {
  it("uses Wilder smoothing and starts after the first full set of changes", () => {
    const result = rsi([10, 11, 12, 11, 13], 3);
    assert.equal(result[0], null);
    assert.equal(result[1], null);
    assert.equal(result[2], null);
    near(result[3], 100 - 100 / 3);
    near(result[4], 100 - 100 / 6);
  });

  it("is 100 when every change is a gain", () => {
    const result = rsi([1, 2, 3, 4], 3);
    near(result[3], 100);
  });

  it("stays null when there are not enough changes", () => {
    assert.deepEqual(rsi([1, 2, 3], 14).every((value) => value == null), true);
  });
});

describe("MACD", () => {
  it("matches EMA(fast) - EMA(slow), then an EMA signal and histogram", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = macd(values, 3, 5, 3);
    assert.equal(result.macd[3], null);
    near(result.macd[4], 1);
    near(result.macd[9], 1);
    assert.equal(result.signal[5], null);
    near(result.signal[6], 1);
    near(result.histogram[6], 0);
    near(result.histogram[9], 0);
  });

  it("rejects a fast period that is not shorter than the slow period", () => {
    assert.throws(() => macd([1, 2, 3, 4, 5], 5, 5, 3), RangeError);
  });
});

describe("Bollinger Bands", () => {
  it("centers on the SMA and uses the population standard deviation", () => {
    const result = bollinger([10, 12, 14], 3, 2);
    const deviation = Math.sqrt(8 / 3);
    near(result.middle[2], 12);
    near(result.upper[2], 12 + 2 * deviation);
    near(result.lower[2], 12 - 2 * deviation);
    near(result.upper[2] - result.middle[2], result.middle[2] - result.lower[2]);
  });

  it("collapses to the average when the multiplier is 0", () => {
    const result = bollinger([2, 4, 6], 3, 0);
    near(result.upper[2], 4);
    near(result.lower[2], 4);
  });
});

describe("VWAP and volume", () => {
  it("accumulates typical price by volume and resets on the next UTC day", () => {
    const day = Date.UTC(2024, 0, 1, 0, 0, 0);
    const candles = [
      { time: day, high: 3, low: 1, close: 2, volume: 10 },
      { time: day + 3_600_000, high: 5, low: 3, close: 4, volume: 10 },
      { time: Date.UTC(2024, 0, 2, 0, 0, 0), high: 9, low: 3, close: 6, volume: 5 },
    ];
    const result = vwap(candles);
    near(result[0], 2);
    near(result[1], 3);
    near(result[2], 6);
  });

  it("ignores a zero-volume bar without changing the running VWAP", () => {
    const day = Date.UTC(2024, 0, 1);
    const result = vwap([
      { time: day, high: 3, low: 1, close: 2, volume: 10 },
      { time: day + 60_000, high: 100, low: 0, close: 50, volume: 0 },
    ]);
    near(result[0], 2);
    near(result[1], 2);
  });

  it("passes volume through and drops values that are not finite", () => {
    assert.deepEqual(
      volume([
        { volume: 12 },
        { volume: Number.NaN },
        { volume: 0 },
      ]),
      [12, null, 0],
    );
  });
});
