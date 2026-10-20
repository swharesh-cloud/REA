const WATCHLIST_KEY = "northmark.v1.watchlist";
const DRAWINGS_KEY = "northmark.v1.drawings";
const PREFS_KEY = "northmark.v1.prefs";

export const DEFAULT_INDICATORS = {
  volume: true,
  sma: { enabled: true, period: 20 },
  ema: { enabled: false, period: 21 },
  bb: { enabled: false, period: 20, multiplier: 2 },
  vwap: false,
  rsi: { enabled: false, period: 14 },
  macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
};

export function defaultWatchlist() {
  return [
    { venue: "binance", symbol: "BTCUSDT" },
    { venue: "binance", symbol: "ETHUSDT" },
    { venue: "binance", symbol: "SOLUSDT" },
    { venue: "coinbase", symbol: "BTC-USD" },
    { venue: "coinbase", symbol: "ETH-USD" },
  ];
}

function browserStorage() {
  try {
    if (typeof localStorage === "undefined") return null;
    const probe = "__northmark_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

function readJson(key) {
  const storage = browserStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  const storage = browserStorage();
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function isPair(value) {
  return (
    value &&
    (value.venue === "binance" || value.venue === "coinbase") &&
    typeof value.symbol === "string" &&
    value.symbol.length > 0
  );
}

export function loadWatchlist() {
  const stored = readJson(WATCHLIST_KEY);
  if (!Array.isArray(stored)) return defaultWatchlist();
  const pairs = stored.filter(isPair);
  return pairs.length ? pairs : defaultWatchlist();
}

export function saveWatchlist(pairs) {
  return writeJson(WATCHLIST_KEY, pairs.filter(isPair));
}

function drawingOk(value) {
  if (!value || typeof value.id !== "string") return false;
  if (value.type === "hline") return Number.isFinite(value.price);
  if (value.type === "trend") {
    return (
      value.a &&
      value.b &&
      Number.isFinite(value.a.time) &&
      Number.isFinite(value.a.price) &&
      Number.isFinite(value.b.time) &&
      Number.isFinite(value.b.price)
    );
  }
  return false;
}

export function loadDrawings(symbolKey) {
  const stored = readJson(DRAWINGS_KEY);
  if (!stored || typeof stored !== "object") return [];
  const list = stored[symbolKey];
  if (!Array.isArray(list)) return [];
  return list.filter(drawingOk);
}

export function saveDrawings(symbolKey, drawings) {
  const stored = readJson(DRAWINGS_KEY);
  const next = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  next[symbolKey] = drawings.filter(drawingOk);
  return writeJson(DRAWINGS_KEY, next);
}

function mergeIndicators(stored) {
  const base = structuredClone(DEFAULT_INDICATORS);
  if (!stored || typeof stored !== "object") return base;
  if (typeof stored.volume === "boolean") base.volume = stored.volume;
  if (typeof stored.vwap === "boolean") base.vwap = stored.vwap;
  for (const key of ["sma", "ema", "bb", "rsi", "macd"]) {
    if (stored[key] && typeof stored[key] === "object") {
      base[key] = { ...base[key], ...stored[key] };
    }
  }
  return base;
}

export function loadPrefs() {
  const stored = readJson(PREFS_KEY);
  if (!stored || typeof stored !== "object") {
    return {
      venue: "binance",
      symbol: "BTCUSDT",
      timeframe: "1h",
      indicators: structuredClone(DEFAULT_INDICATORS),
    };
  }
  const venue = stored.venue === "coinbase" ? "coinbase" : "binance";
  const symbol = typeof stored.symbol === "string" ? stored.symbol : venue === "coinbase" ? "BTC-USD" : "BTCUSDT";
  const timeframe = typeof stored.timeframe === "string" ? stored.timeframe : "1h";
  return {
    venue,
    symbol,
    timeframe,
    indicators: mergeIndicators(stored.indicators),
  };
}

export function savePrefs(prefs) {
  return writeJson(PREFS_KEY, prefs);
}

export function symbolKey(venue, symbol) {
  return `${venue}:${symbol}`;
}
