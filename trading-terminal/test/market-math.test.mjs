import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregateCandles, epochBucket, mondayStart } from "../js/aggregate.js";
import { applyLiveCandle, applyLiveTrade, trimCandles } from "../js/live.js";
import { parseBinanceKline, parseCoinbaseCandle } from "../js/market.js";
import { shouldHandleFetch } from "../js/sw-policy.js";

describe("candle parsers", () => {
  it("reads Binance kline order as time, open, high, low, close, volume", () => {
    const candle = parseBinanceKline([
      1_700_000_000_000,
      "10",
      "14",
      "9",
      "12",
      "3.5",
    ]);
    assert.deepEqual(candle, {
      time: 1_700_000_000_000,
      open: 10,
      high: 14,
      low: 9,
      close: 12,
      volume: 3.5,
    });
  });

  it("reads Coinbase order as time seconds, low, high, open, close, volume", () => {
    const candle = parseCoinbaseCandle([1_700_000_000, 9, 14, 10, 12, 3.5]);
    assert.equal(candle.time, 1_700_000_000_000);
    assert.equal(candle.low, 9);
    assert.equal(candle.high, 14);
    assert.equal(candle.open, 10);
    assert.equal(candle.close, 12);
  });

  it("drops a candle whose high is below its low", () => {
    assert.equal(parseBinanceKline([1, 10, 8, 9, 10, 1]), null);
  });
});

describe("aggregation", () => {
  it("builds epoch buckets from open, high, low, close, and summed volume", () => {
    const hour = 3_600_000;
    const candles = [
      { time: 0, open: 10, high: 12, low: 9, close: 11, volume: 1 },
      { time: hour, open: 11, high: 15, low: 8, close: 14, volume: 2 },
      { time: 4 * hour, open: 14, high: 16, low: 13, close: 15, volume: 4 },
    ];
    const result = aggregateCandles(candles, epochBucket(4 * hour));
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], {
      time: 0,
      open: 10,
      high: 15,
      low: 8,
      close: 14,
      volume: 3,
    });
    assert.equal(result[1].time, 4 * hour);
    assert.equal(result[1].open, 14);
    assert.equal(result[1].close, 15);
  });

  it("aligns a week to Monday 00:00 UTC", () => {
    const monday = Date.UTC(2024, 0, 1);
    const wednesday = Date.UTC(2024, 0, 3, 15, 30);
    const sunday = Date.UTC(2024, 0, 7, 23, 0);
    assert.equal(mondayStart(monday), monday);
    assert.equal(mondayStart(wednesday), monday);
    assert.equal(mondayStart(sunday), monday);
    const nextMonday = Date.UTC(2024, 0, 8);
    const grouped = aggregateCandles(
      [
        { time: wednesday, open: 1, high: 3, low: 1, close: 2, volume: 5 },
        { time: sunday, open: 2, high: 4, low: 2, close: 3, volume: 7 },
        { time: nextMonday, open: 3, high: 3, low: 3, close: 3, volume: 1 },
      ],
      mondayStart,
    );
    assert.equal(grouped.length, 2);
    assert.equal(grouped[0].time, monday);
    assert.equal(grouped[0].open, 1);
    assert.equal(grouped[0].close, 3);
    assert.equal(grouped[0].high, 4);
    assert.equal(grouped[0].volume, 12);
    assert.equal(grouped[1].time, nextMonday);
  });
});

describe("live updates", () => {
  it("replaces the matching candle, appends a newer one, and ignores an older one", () => {
    const candles = [{ time: 10, open: 1, high: 1, low: 1, close: 1, volume: 1 }];
    assert.equal(
      applyLiveCandle(candles, { time: 10, open: 1, high: 2, low: 1, close: 2, volume: 4 }),
      "update",
    );
    assert.equal(candles[0].close, 2);
    assert.equal(candles[0].volume, 4);
    assert.equal(
      applyLiveCandle(candles, { time: 20, open: 2, high: 3, low: 2, close: 3, volume: 1 }),
      "append",
    );
    assert.equal(candles.length, 2);
    assert.equal(
      applyLiveCandle(candles, { time: 10, open: 9, high: 9, low: 9, close: 9, volume: 9 }),
      "ignore",
    );
    assert.equal(candles[0].close, 2);
  });

  it("updates the open bucket and rolls forward when a trade crosses it", () => {
    const candles = [{ time: 0, open: 10, high: 10, low: 10, close: 10, volume: 1 }];
    assert.equal(
      applyLiveTrade(candles, { time: 30_000, price: 12, size: 0.5 }, 60_000),
      "update",
    );
    assert.equal(candles.length, 1);
    assert.equal(candles[0].high, 12);
    assert.equal(candles[0].close, 12);
    assert.equal(candles[0].volume, 1.5);
    assert.equal(
      applyLiveTrade(candles, { time: 60_000, price: 9, size: 2 }, 60_000),
      "append",
    );
    assert.equal(candles[1].time, 60_000);
    assert.equal(candles[1].open, 9);
    assert.equal(candles[1].low, 9);
    assert.equal(candles[1].volume, 2);
  });

  it("trims oldest candles and reports how many were removed", () => {
    const candles = [
      { time: 1 },
      { time: 2 },
      { time: 3 },
    ];
    assert.equal(trimCandles(candles, 2), 1);
    assert.deepEqual(candles.map((candle) => candle.time), [2, 3]);
  });
});

describe("service worker policy", () => {
  const origin = "https://northmark.example";

  it("caches only same-origin shell GETs", () => {
    assert.equal(
      shouldHandleFetch({ method: "GET", url: `${origin}/js/app.js` }, origin),
      true,
    );
    assert.equal(
      shouldHandleFetch({ method: "GET", url: `${origin}/` }, origin),
      true,
    );
  });

  it("does not cache market-data hosts, other methods, or query strings", () => {
    assert.equal(
      shouldHandleFetch(
        { method: "GET", url: "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT" },
        origin,
      ),
      false,
    );
    assert.equal(
      shouldHandleFetch(
        { method: "GET", url: "https://api.exchange.coinbase.com/products/BTC-USD/candles" },
        origin,
      ),
      false,
    );
    assert.equal(
      shouldHandleFetch({ method: "POST", url: `${origin}/js/app.js` }, origin),
      false,
    );
    assert.equal(
      shouldHandleFetch({ method: "GET", url: `${origin}/js/app.js?v=1` }, origin),
      false,
    );
    assert.equal(
      shouldHandleFetch({ method: "GET", url: `${origin}/secret` }, origin),
      false,
    );
  });
});
