/** Group ascending candles into fixed buckets. bucketOf(time) returns the bucket start. */
export function aggregateCandles(candles, bucketOf) {
  const sorted = candles.slice().sort((a, b) => a.time - b.time);
  const buckets = new Map();
  const order = [];
  for (const candle of sorted) {
    const start = bucketOf(candle.time);
    const existing = buckets.get(start);
    if (!existing) {
      buckets.set(start, {
        time: start,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      });
      order.push(start);
      continue;
    }
    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += candle.volume;
  }
  return order.map((start) => buckets.get(start));
}

/** Monday 00:00 UTC of the week containing time. */
export function mondayStart(time) {
  const date = new Date(time);
  const midnight = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );
  const day = new Date(midnight).getUTCDay();
  const daysFromMonday = (day + 6) % 7;
  return midnight - daysFromMonday * 86_400_000;
}

export function epochBucket(bucketMs) {
  return (time) => Math.floor(time / bucketMs) * bucketMs;
}
