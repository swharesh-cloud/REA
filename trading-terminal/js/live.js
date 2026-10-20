/** Replace the open candle, append a newer one, or ignore an older print. Mutates the array. */
export function applyLiveCandle(candles, next) {
  const last = candles[candles.length - 1];
  if (!last) {
    candles.push(next);
    return "append";
  }
  if (next.time === last.time) {
    candles[candles.length - 1] = next;
    return "update";
  }
  if (next.time > last.time) {
    candles.push(next);
    return "append";
  }
  return "ignore";
}

/** Fold one trade into a bucket. bucket is a millisecond size or a start-time function. */
export function applyLiveTrade(candles, trade, bucket) {
  const start =
    typeof bucket === "function" ? bucket(trade.time) : Math.floor(trade.time / bucket) * bucket;
  const price = trade.price;
  const size = trade.size > 0 ? trade.size : 0;
  const last = candles[candles.length - 1];
  if (!last || start > last.time) {
    candles.push({
      time: start,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: size,
    });
    return "append";
  }
  if (start < last.time) return "ignore";
  candles[candles.length - 1] = {
    ...last,
    high: Math.max(last.high, price),
    low: Math.min(last.low, price),
    close: price,
    volume: last.volume + size,
  };
  return "update";
}

export function trimCandles(candles, max = 5000) {
  const extra = candles.length - max;
  if (extra <= 0) return 0;
  candles.splice(0, extra);
  return extra;
}
