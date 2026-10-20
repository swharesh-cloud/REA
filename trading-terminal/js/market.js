import { aggregateCandles, epochBucket, mondayStart } from "./aggregate.js";

export const BINANCE_REST = "https://data-api.binance.vision";
export const BINANCE_WS = "wss://data-stream.binance.vision/ws";
export const COINBASE_REST = "https://api.exchange.coinbase.com";
export const COINBASE_WS = "wss://ws-feed.exchange.coinbase.com";

export const TIMEFRAMES = [
  { id: "1m", label: "1m", binance: "1m", coinbase: 60, bucketMs: 60_000 },
  { id: "5m", label: "5m", binance: "5m", coinbase: 300, bucketMs: 300_000 },
  { id: "15m", label: "15m", binance: "15m", coinbase: 900, bucketMs: 900_000 },
  { id: "1h", label: "1h", binance: "1h", coinbase: 3600, bucketMs: 3_600_000 },
  { id: "4h", label: "4h", binance: "4h", coinbase: 3600, aggregate: 14_400_000, bucketMs: 14_400_000 },
  { id: "1d", label: "1D", binance: "1d", coinbase: 86400, bucketMs: 86_400_000 },
  { id: "1w", label: "1W", binance: "1w", coinbase: 86400, aggregate: "week", bucketMs: 604_800_000 },
];

const POPULAR = {
  binance: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT"],
  coinbase: ["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "DOGE-USD", "ADA-USD", "AVAX-USD", "LINK-USD"],
};

const catalog = { binance: null, coinbase: null };

export function timeframeById(id) {
  return TIMEFRAMES.find((timeframe) => timeframe.id === id) ?? TIMEFRAMES[3];
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function validCandle(candle) {
  if (!candle) return false;
  const values = [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume];
  if (!values.every(finite)) return false;
  if (candle.volume < 0) return false;
  return (
    candle.high >= candle.low &&
    candle.high >= candle.open &&
    candle.high >= candle.close &&
    candle.low <= candle.open &&
    candle.low <= candle.close
  );
}

/** Binance kline: open time, open, high, low, close, volume. */
export function parseBinanceKline(row) {
  const candle = {
    time: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
  return validCandle(candle) ? candle : null;
}

/** Coinbase candle: time (seconds), low, high, open, close, volume. */
export function parseCoinbaseCandle(row) {
  const candle = {
    time: Number(row[0]) * 1000,
    low: Number(row[1]),
    high: Number(row[2]),
    open: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
  return validCandle(candle) ? candle : null;
}

async function getJson(url, signal) {
  let response;
  try {
    response = await fetch(url, { signal });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new Error("Network request failed. Check the connection and try again.");
  }
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error("The data source rate-limited this request. Wait a moment and retry.");
    }
    if (response.status === 451) {
      throw new Error("This data source refused the request from this network (HTTP 451).");
    }
    throw new Error(`The data source returned HTTP ${response.status}.`);
  }
  return response.json();
}

function dedupeSorted(candles) {
  const sorted = candles.slice().sort((a, b) => a.time - b.time);
  const out = [];
  for (const candle of sorted) {
    const last = out[out.length - 1];
    if (last && last.time === candle.time) out[out.length - 1] = candle;
    else out.push(candle);
  }
  return out;
}

async function fetchBinanceCandles(symbol, timeframe, signal) {
  const url = `${BINANCE_REST}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${timeframe.binance}&limit=1000`;
  const rows = await getJson(url, signal);
  if (!Array.isArray(rows)) throw new Error("Binance returned an unexpected candle payload.");
  return dedupeSorted(rows.map(parseBinanceKline).filter(Boolean));
}

async function fetchCoinbaseCandles(symbol, timeframe, signal) {
  const pageSpan = timeframe.coinbase * 299;
  let end = Math.floor(Date.now() / 1000);
  const rows = [];
  for (let page = 0; page < 4; page += 1) {
    const start = end - pageSpan;
    const url = `${COINBASE_REST}/products/${encodeURIComponent(symbol)}/candles?granularity=${timeframe.coinbase}&start=${start}&end=${end}`;
    let payload;
    try {
      payload = await getJson(url, signal);
    } catch (error) {
      if (page === 0) throw error;
      break;
    }
    if (!Array.isArray(payload)) {
      if (page === 0) throw new Error("Coinbase returned an unexpected candle payload.");
      break;
    }
    rows.push(...payload);
    end = start;
  }
  let candles = dedupeSorted(rows.map(parseCoinbaseCandle).filter(Boolean));
  if (timeframe.aggregate === "week") {
    candles = aggregateCandles(candles, mondayStart);
  } else if (typeof timeframe.aggregate === "number") {
    candles = aggregateCandles(candles, epochBucket(timeframe.aggregate));
  }
  return candles;
}

export async function fetchCandles(venue, symbol, timeframeId, signal) {
  const timeframe = timeframeById(timeframeId);
  if (venue === "binance") return fetchBinanceCandles(symbol, timeframe, signal);
  if (venue === "coinbase") return fetchCoinbaseCandles(symbol, timeframe, signal);
  throw new Error("Unknown venue.");
}

function binancePair(symbol) {
  return {
    venue: "binance",
    symbol,
    base: symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol,
    quote: "USDT",
  };
}

function coinbasePair(product) {
  return {
    venue: "coinbase",
    symbol: product.id ?? product.symbol,
    base: product.base ?? product.base_currency ?? String(product.id ?? "").split("-")[0],
    quote: product.quote ?? product.quote_currency ?? "USD",
  };
}

async function loadBinanceCatalog(signal) {
  if (catalog.binance) return catalog.binance;
  const rows = await getJson(`${BINANCE_REST}/api/v3/ticker/price`, signal);
  if (!Array.isArray(rows)) throw new Error("Binance returned an unexpected symbol list.");
  catalog.binance = rows
    .filter((row) => typeof row.symbol === "string" && row.symbol.endsWith("USDT") && !row.symbol.includes("_"))
    .map((row) => binancePair(row.symbol));
  return catalog.binance;
}

async function loadCoinbaseCatalog(signal) {
  if (catalog.coinbase) return catalog.coinbase;
  const rows = await getJson(`${COINBASE_REST}/products`, signal);
  if (!Array.isArray(rows)) throw new Error("Coinbase returned an unexpected product list.");
  catalog.coinbase = rows
    .filter((row) => row.quote_currency === "USD" && row.status === "online" && row.trading_disabled !== true)
    .map((row) => coinbasePair(row));
  return catalog.coinbase;
}

function popularPairs() {
  return [
    ...POPULAR.binance.map((symbol) => binancePair(symbol)),
    ...POPULAR.coinbase.map((symbol) => coinbasePair({ id: symbol, base: symbol.split("-")[0], quote: "USD" })),
  ];
}

export async function searchSymbols(query, signal) {
  const normalized = query.trim().toUpperCase().replace(/\s+/g, "");
  const [binance, coinbase] = await Promise.all([
    loadBinanceCatalog(signal).catch(() => POPULAR.binance.map((symbol) => binancePair(symbol))),
    loadCoinbaseCatalog(signal).catch(() =>
      POPULAR.coinbase.map((symbol) => coinbasePair({ id: symbol, base: symbol.split("-")[0], quote: "USD" })),
    ),
  ]);
  const all = [...binance, ...coinbase];
  if (!normalized) return popularPairs();
  return all
    .filter((pair) => pair.symbol.includes(normalized) || pair.base.includes(normalized))
    .slice(0, 40);
}

export async function fetchPrices(pairs, signal) {
  const prices = new Map();
  const binance = pairs.filter((pair) => pair.venue === "binance");
  const coinbase = pairs.filter((pair) => pair.venue === "coinbase");
  if (binance.length) {
    const symbols = JSON.stringify(binance.map((pair) => pair.symbol));
    const rows = await getJson(
      `${BINANCE_REST}/api/v3/ticker/price?symbols=${encodeURIComponent(symbols)}`,
      signal,
    );
    if (Array.isArray(rows)) {
      for (const row of rows) prices.set(`binance:${row.symbol}`, Number(row.price));
    }
  }
  await Promise.all(
    coinbase.map(async (pair) => {
      try {
        const ticker = await getJson(
          `${COINBASE_REST}/products/${encodeURIComponent(pair.symbol)}/ticker`,
          signal,
        );
        prices.set(`coinbase:${pair.symbol}`, Number(ticker.price));
      } catch {
        prices.set(`coinbase:${pair.symbol}`, Number.NaN);
      }
    }),
  );
  return prices;
}

function connectSocket(url, { onOpen, onMessage, onStatus }) {
  let stopped = false;
  let socket = null;
  let retryMs = 1000;
  let timer = null;
  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(url);
    socket.addEventListener("open", () => {
      retryMs = 1000;
      onOpen?.(socket);
      onStatus?.("live");
    });
    socket.addEventListener("message", (event) => onMessage?.(event, socket));
    socket.addEventListener("close", () => {
      if (stopped) return;
      onStatus?.("reconnecting");
      timer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 15_000);
    });
    socket.addEventListener("error", () => {
      socket.close();
    });
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    socket?.close();
  };
}

export function subscribe({ venue, symbol, timeframeId, onCandle, onTrade, onStatus }) {
  const timeframe = timeframeById(timeframeId);
  if (venue === "binance") {
    const stream = `${symbol.toLowerCase()}@kline_${timeframe.binance}`;
    return connectSocket(`${BINANCE_WS}/${stream}`, {
      onStatus,
      onMessage(event) {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        const kline = message.k;
        if (!kline) return;
        const candle = parseBinanceKline([kline.t, kline.o, kline.h, kline.l, kline.c, kline.v]);
        if (candle) onCandle?.(candle);
      },
    });
  }
  if (venue === "coinbase") {
    return connectSocket(COINBASE_WS, {
      onStatus,
      onOpen(socket) {
        socket.send(
          JSON.stringify({
            type: "subscribe",
            product_ids: [symbol],
            channels: ["matches", "heartbeat"],
          }),
        );
      },
      onMessage(event) {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === "error") {
          onStatus?.("error");
          return;
        }
        if (message.type !== "match" && message.type !== "last_match") return;
        const time = Date.parse(message.time);
        const price = Number(message.price);
        const size = Number(message.size);
        if (!Number.isFinite(time) || !Number.isFinite(price)) return;
        const bucketOf =
          timeframe.aggregate === "week"
            ? mondayStart
            : (tradeTime) => Math.floor(tradeTime / timeframe.bucketMs) * timeframe.bucketMs;
        onTrade?.({
          time,
          price,
          size: Number.isFinite(size) ? size : 0,
          bucketOf,
        });
      },
    });
  }
  return () => {};
}
