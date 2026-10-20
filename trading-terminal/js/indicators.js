/**
 * Indicator math from published formulas.
 * Inputs are finite series. A leading null means the window is not full yet.
 * SMA is a simple arithmetic mean.
 * EMA is seeded with that SMA, then uses multiplier 2 / (period + 1).
 * RSI uses Wilder's smoothing. If average loss is 0, RSI is 100.
 * Bollinger Bands use the population standard deviation (divide by N).
 * MACD line is EMA(fast) - EMA(slow). The signal is an EMA of that line.
 * VWAP is cumulative typical-price * volume / cumulative volume, reset each UTC day.
 */

function assertPeriod(period, label) {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`${label} period must be an integer >= 1`);
  }
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function sma(values, period) {
  assertPeriod(period, "SMA");
  const out = Array(values.length).fill(null);
  for (let end = period - 1; end < values.length; end += 1) {
    let sum = 0;
    let ok = true;
    for (let index = end - period + 1; index <= end; index += 1) {
      if (!finite(values[index])) {
        ok = false;
        break;
      }
      sum += values[index];
    }
    if (ok) out[end] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  assertPeriod(period, "EMA");
  const out = Array(values.length).fill(null);
  const multiplier = 2 / (period + 1);
  let seedSum = 0;
  let seedCount = 0;
  let previous = null;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!finite(value)) {
      seedSum = 0;
      seedCount = 0;
      previous = null;
      continue;
    }
    if (previous === null) {
      seedSum += value;
      seedCount += 1;
      if (seedCount === period) {
        previous = seedSum / period;
        out[index] = previous;
      }
      continue;
    }
    previous = (value - previous) * multiplier + previous;
    out[index] = previous;
  }
  return out;
}

function rsiFromAverages(averageGain, averageLoss) {
  if (averageLoss === 0) return 100;
  const relativeStrength = averageGain / averageLoss;
  return 100 - 100 / (1 + relativeStrength);
}

export function rsi(values, period) {
  assertPeriod(period, "RSI");
  const out = Array(values.length).fill(null);
  let averageGain = null;
  let averageLoss = null;
  let seedGain = 0;
  let seedLoss = 0;
  let seedCount = 0;
  let previousClose = null;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!finite(value)) {
      averageGain = null;
      averageLoss = null;
      seedGain = 0;
      seedLoss = 0;
      seedCount = 0;
      previousClose = null;
      continue;
    }
    if (previousClose === null) {
      previousClose = value;
      continue;
    }
    const change = value - previousClose;
    previousClose = value;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (averageGain === null) {
      seedGain += gain;
      seedLoss += loss;
      seedCount += 1;
      if (seedCount === period) {
        averageGain = seedGain / period;
        averageLoss = seedLoss / period;
        out[index] = rsiFromAverages(averageGain, averageLoss);
      }
      continue;
    }
    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
    out[index] = rsiFromAverages(averageGain, averageLoss);
  }
  return out;
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
  assertPeriod(fast, "MACD fast");
  assertPeriod(slow, "MACD slow");
  assertPeriod(signal, "MACD signal");
  if (fast >= slow) {
    throw new RangeError("MACD fast period must be shorter than the slow period");
  }
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const line = values.map((_, index) => {
    if (fastEma[index] == null || slowEma[index] == null) return null;
    return fastEma[index] - slowEma[index];
  });
  const signalLine = ema(line, signal);
  const histogram = line.map((value, index) => {
    if (value == null || signalLine[index] == null) return null;
    return value - signalLine[index];
  });
  return { macd: line, signal: signalLine, histogram };
}

export function bollinger(values, period = 20, multiplier = 2) {
  assertPeriod(period, "Bollinger");
  if (!finite(multiplier) || multiplier < 0) {
    throw new RangeError("Bollinger multiplier must be a finite number >= 0");
  }
  const middle = sma(values, period);
  const upper = Array(values.length).fill(null);
  const lower = Array(values.length).fill(null);
  for (let end = period - 1; end < values.length; end += 1) {
    if (middle[end] == null) continue;
    let sumSquares = 0;
    for (let index = end - period + 1; index <= end; index += 1) {
      const delta = values[index] - middle[end];
      sumSquares += delta * delta;
    }
    const deviation = Math.sqrt(sumSquares / period);
    upper[end] = middle[end] + multiplier * deviation;
    lower[end] = middle[end] - multiplier * deviation;
  }
  return { middle, upper, lower };
}

export function utcDay(time) {
  return Math.floor(time / 86_400_000);
}

export function vwap(candles) {
  const out = Array(candles.length).fill(null);
  let day = null;
  let pricedVolume = 0;
  let volumeSum = 0;
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const nextDay = utcDay(candle.time);
    if (nextDay !== day) {
      day = nextDay;
      pricedVolume = 0;
      volumeSum = 0;
    }
    const typical = (candle.high + candle.low + candle.close) / 3;
    if (finite(typical) && finite(candle.volume) && candle.volume > 0) {
      pricedVolume += typical * candle.volume;
      volumeSum += candle.volume;
    }
    out[index] = volumeSum > 0 ? pricedVolume / volumeSum : null;
  }
  return out;
}

/** Volume is plotted directly. This preserves the candle field and drops non-finite values. */
export function volume(candles) {
  return candles.map((candle) => (finite(candle.volume) ? candle.volume : null));
}
