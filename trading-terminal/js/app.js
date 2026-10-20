import { runBacktest } from "./backtest.js";
import { createChart } from "./chart.js";
import { drawEquity } from "./equity.js";
import {
  formatCandleTime,
  formatPercent,
  formatPlainPercent,
  formatPrice,
  formatSymbol,
  formatVolume,
  venueLabel,
} from "./format.js";
import { bollinger, ema, macd, rsi, sma, vwap } from "./indicators.js";
import { applyLiveCandle, applyLiveTrade, trimCandles } from "./live.js";
import { fetchCandles, fetchPrices, searchSymbols, subscribe, TIMEFRAMES } from "./market.js";
import {
  loadDrawings,
  loadPrefs,
  loadWatchlist,
  saveDrawings,
  savePrefs,
  saveWatchlist,
  symbolKey,
} from "./store.js";

const $ = (id) => document.getElementById(id);
const knownTimeframes = new Set(TIMEFRAMES.map((timeframe) => timeframe.id));
const toolHelp = {
  pan: "Drag to pan. Pinch or scroll to zoom.",
  trend: "Tap the first point, then tap the second.",
  hline: "Tap the chart to place a horizontal level.",
  erase: "Tap a trend line or level to delete it.",
};

const state = {
  venue: "binance",
  symbol: "BTCUSDT",
  timeframe: "1h",
  candles: [],
  drawings: [],
  watchlist: [],
  tool: "pan",
  request: 0,
  abort: null,
  unsubscribe: null,
  priceTimer: null,
  priceAbort: null,
  hover: null,
  viewFrame: 0,
  pendingShift: 0,
  storageWarned: false,
};

const chart = createChart($("chart"));

function setStatus(text, bad = false) {
  const status = $("status");
  status.textContent = text;
  status.classList.toggle("bad", bad);
  status.classList.toggle("live", !bad && text.startsWith("Live"));
}

function warnStorage(saved) {
  if (saved || state.storageWarned) return;
  state.storageWarned = true;
  setStatus("This browser is not saving data on the device.", true);
}

function acceptableSymbol(venue, symbol) {
  if (venue === "binance") return /^[A-Z0-9]{2,30}$/.test(symbol);
  return /^[A-Z0-9]{1,15}-[A-Z0-9]{1,15}$/.test(symbol);
}

function currentPrefs() {
  return {
    venue: state.venue,
    symbol: state.symbol,
    timeframe: state.timeframe,
    indicators: readIndicators(),
  };
}

function integerInput(id, fallback) {
  const value = Number($(id).value);
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

function numberInput(id, fallback, min = 0) {
  const value = Number($(id).value);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

function readIndicators() {
  return {
    volume: $("ind-volume").checked,
    sma: { enabled: $("ind-sma").checked, period: integerInput("sma-period", 20) },
    ema: { enabled: $("ind-ema").checked, period: integerInput("ema-period", 21) },
    bb: {
      enabled: $("ind-bb").checked,
      period: integerInput("bb-period", 20),
      multiplier: numberInput("bb-mult", 2, 0),
    },
    vwap: $("ind-vwap").checked,
    rsi: { enabled: $("ind-rsi").checked, period: integerInput("rsi-period", 14) },
    macd: {
      enabled: $("ind-macd").checked,
      fast: integerInput("macd-fast", 12),
      slow: integerInput("macd-slow", 26),
      signal: integerInput("macd-signal", 9),
    },
  };
}

function applyIndicatorForm(indicators) {
  $("ind-volume").checked = indicators.volume;
  $("ind-sma").checked = indicators.sma.enabled;
  $("sma-period").value = String(indicators.sma.period);
  $("ind-ema").checked = indicators.ema.enabled;
  $("ema-period").value = String(indicators.ema.period);
  $("ind-bb").checked = indicators.bb.enabled;
  $("bb-period").value = String(indicators.bb.period);
  $("bb-mult").value = String(indicators.bb.multiplier);
  $("ind-vwap").checked = indicators.vwap;
  $("ind-rsi").checked = indicators.rsi.enabled;
  $("rsi-period").value = String(indicators.rsi.period);
  $("ind-macd").checked = indicators.macd.enabled;
  $("macd-fast").value = String(indicators.macd.fast);
  $("macd-slow").value = String(indicators.macd.slow);
  $("macd-signal").value = String(indicators.macd.signal);
}

function safeSeries(label, compute) {
  try {
    return compute();
  } catch (error) {
    setStatus(`${label}: ${error.message}`, true);
    return null;
  }
}

function buildSeries() {
  const closes = state.candles.map((candle) => candle.close);
  const indicators = readIndicators();
  const overlays = [];
  const panes = [];
  if (indicators.sma.enabled) {
    const values = safeSeries("SMA", () => sma(closes, indicators.sma.period));
    if (values) overlays.push({ color: "#e2a15a", values });
  }
  if (indicators.ema.enabled) {
    const values = safeSeries("EMA", () => ema(closes, indicators.ema.period));
    if (values) overlays.push({ color: "#8eb6e0", values });
  }
  if (indicators.bb.enabled) {
    const bands = safeSeries("Bollinger", () =>
      bollinger(closes, indicators.bb.period, indicators.bb.multiplier),
    );
    if (bands) {
      overlays.push({ color: "rgba(196, 182, 224, 0.95)", dashed: true, values: bands.middle });
      overlays.push({ color: "rgba(196, 182, 224, 0.85)", values: bands.upper });
      overlays.push({ color: "rgba(196, 182, 224, 0.85)", values: bands.lower });
    }
  }
  if (indicators.vwap) overlays.push({ color: "#e6d38a", values: vwap(state.candles) });
  if (indicators.rsi.enabled) {
    const values = safeSeries("RSI", () => rsi(closes, indicators.rsi.period));
    if (values) {
      panes.push({
        fixed: { min: 0, max: 100 },
        guides: [30, 70],
        lines: [{ color: "#e2a15a", values }],
      });
    }
  }
  if (indicators.macd.enabled) {
    const result = safeSeries("MACD", () =>
      macd(closes, indicators.macd.fast, indicators.macd.slow, indicators.macd.signal),
    );
    if (result) {
      panes.push({
        guides: [0],
        histograms: [{ up: "rgba(143, 212, 170, 0.85)", down: "rgba(229, 137, 111, 0.85)", values: result.histogram }],
        lines: [
          { color: "#8eb6e0", values: result.macd },
          { color: "#e2a15a", values: result.signal },
        ],
      });
    }
  }
  chart.setTimeframe(state.timeframe);
  chart.setSeries({ overlays, panes, showVolume: indicators.volume });
  return indicators;
}

function updateQuote() {
  const candle = state.candles[state.candles.length - 1];
  const previous = state.candles[state.candles.length - 2];
  $("symbol-label").textContent = formatSymbol(state.venue, state.symbol);
  $("venue-label").textContent = venueLabel(state.venue);
  document.title = `${formatSymbol(state.venue, state.symbol)} · Northmark`;
  if (!candle) {
    $("last-price").textContent = "—";
    $("price-change").textContent = "";
    return;
  }
  const change = previous ? (candle.close - previous.close) / previous.close : 0;
  const direction = change > 0 ? "up" : change < 0 ? "down" : "";
  const price = $("last-price");
  price.textContent = formatPrice(candle.close);
  price.className = `price ${direction}`;
  const node = $("price-change");
  node.textContent = previous ? formatPercent(change) : "";
  node.className = `change ${direction}`;
}

function legendValue(values, index) {
  const value = values?.[index];
  return Number.isFinite(value) ? formatPrice(value) : "—";
}

function updateLegend(cursor) {
  const index = cursor?.index ?? state.candles.length - 1;
  const candle = state.candles[index];
  const legend = $("legend");
  legend.replaceChildren();
  if (!candle) return;
  const parts = [
    ["O", formatPrice(candle.open)],
    ["H", formatPrice(candle.high)],
    ["L", formatPrice(candle.low)],
    ["C", formatPrice(candle.close)],
    ["V", formatVolume(candle.volume)],
    ["T", formatCandleTime(candle.time, state.timeframe)],
  ];
  for (const [label, value] of parts) {
    const item = document.createElement("span");
    const name = document.createElement("b");
    name.textContent = label;
    item.append(name, ` ${value}`);
    legend.append(item);
  }
}

function updateCoverage() {
  const source =
    state.venue === "binance"
      ? "Binance public market data, up to 1000 candles"
      : "Coinbase public candles, four pages of 299 before any aggregation";
  const label = TIMEFRAMES.find((item) => item.id === state.timeframe)?.label ?? state.timeframe;
  $("coverage").textContent = `${state.candles.length} × ${label} · ${source} · UTC`;
  $("bt-sample").textContent = `Sample: ${state.candles.length} ${label} candles, ${formatSymbol(state.venue, state.symbol)}, ${venueLabel(state.venue)}.`;
}

function scheduleView(removed = 0) {
  state.pendingShift += removed;
  if (state.viewFrame) return;
  state.viewFrame = requestAnimationFrame(() => {
    const shift = state.pendingShift;
    state.pendingShift = 0;
    state.viewFrame = 0;
    buildSeries();
    chart.setCandles(state.candles, { indexShift: shift });
    updateQuote();
    updateLegend(state.hover);
    updateCoverage();
  });
}

async function loadSymbol({ allowFallback = false } = {}) {
  const request = ++state.request;
  state.unsubscribe?.();
  state.unsubscribe = null;
  state.abort?.abort();
  state.abort = new AbortController();
  setStatus("Loading candles…");
  $("retry-button").hidden = true;
  try {
    const candles = await fetchCandles(state.venue, state.symbol, state.timeframe, state.abort.signal);
    if (request !== state.request) return;
    if (!candles.length) throw new Error("The source returned no candles for this symbol.");
    state.candles = candles;
    state.drawings = loadDrawings(symbolKey(state.venue, state.symbol));
    chart.setDrawings(state.drawings);
    chart.setCandles(state.candles);
    buildSeries();
    updateQuote();
    updateLegend(null);
    updateCoverage();
    renderDrawings();
    warnStorage(savePrefs(currentPrefs()));
    const live = state.venue === "binance" ? "Live · Binance" : "Live · Coinbase";
    setStatus("Connecting…");
    state.unsubscribe = subscribe({
      venue: state.venue,
      symbol: state.symbol,
      timeframeId: state.timeframe,
      onStatus(status) {
        if (request !== state.request) return;
        if (status === "live") setStatus(live);
        else if (status === "reconnecting") setStatus("Reconnecting…");
        else setStatus("The live feed reported an error.", true);
      },
      onCandle(candle) {
        if (request !== state.request) return;
        applyLiveCandle(state.candles, candle);
        scheduleView(trimCandles(state.candles));
      },
      onTrade(trade) {
        if (request !== state.request) return;
        applyLiveTrade(state.candles, trade, trade.bucketOf);
        scheduleView(trimCandles(state.candles));
      },
    });
  } catch (error) {
    if (error?.name === "AbortError" || request !== state.request) return;
    const message = error.message || "Couldn't load candles.";
    if (allowFallback && state.venue === "binance") {
      setStatus(`${message} Trying Coinbase…`, true);
      state.venue = "coinbase";
      state.symbol = "BTC-USD";
      updateQuote();
      await loadSymbol({ allowFallback: false });
      return;
    }
    setStatus(message, true);
    $("retry-button").hidden = false;
  }
}

function selectSymbol(venue, symbol) {
  if (!acceptableSymbol(venue, symbol)) {
    setStatus("That symbol is not in a supported form.", true);
    return;
  }
  state.venue = venue;
  state.symbol = symbol.toUpperCase();
  setTab("chart");
  loadSymbol();
}

function renderPairs(container, pairs, { onPick, extra }) {
  container.replaceChildren();
  if (!pairs.length) {
    const empty = document.createElement("p");
    empty.className = "note";
    empty.textContent = "No matching symbols.";
    container.append(empty);
    return;
  }
  for (const pair of pairs) {
    const row = document.createElement("div");
    row.className = "pair";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pair";
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = formatSymbol(pair.venue, pair.symbol);
    const meta = document.createElement("small");
    meta.textContent = venueLabel(pair.venue);
    text.append(title, meta);
    button.append(text);
    button.addEventListener("click", () => onPick(pair));
    if (extra) row.append(button, extra(pair));
    else container.append(button);
    if (extra) container.append(row);
  }
}

async function runSearch() {
  const query = $("search-input").value;
  let pairs = [];
  try {
    pairs = await searchSymbols(query);
  } catch (error) {
    setStatus(error.message, true);
  }
  renderPairs($("search-results"), pairs, {
    onPick: (pair) => selectSymbol(pair.venue, pair.symbol),
    extra(pair) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "ghost";
      add.textContent = "Save";
      add.addEventListener("click", () => addWatch(pair));
      return add;
    },
  });
}

function exactSymbol(query) {
  const text = query.trim().toUpperCase();
  if (/^[A-Z0-9]{2,30}USDT$/.test(text)) return { venue: "binance", symbol: text };
  if (/^[A-Z0-9]{1,15}-USD$/.test(text)) return { venue: "coinbase", symbol: text };
  return null;
}

function renderWatchlist(prices = new Map()) {
  const container = $("watch-list");
  container.replaceChildren();
  const present = state.watchlist.some((pair) => pair.venue === state.venue && pair.symbol === state.symbol);
  $("add-current").textContent = present ? "Remove current symbol" : "Save current symbol";
  if (!state.watchlist.length) {
    const empty = document.createElement("p");
    empty.className = "note";
    empty.textContent = "No saved symbols yet.";
    container.append(empty);
    return;
  }
  for (const pair of state.watchlist) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pair";
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = formatSymbol(pair.venue, pair.symbol);
    const meta = document.createElement("small");
    meta.textContent = venueLabel(pair.venue);
    text.append(title, meta);
    const price = document.createElement("strong");
    const value = prices.get(`${pair.venue}:${pair.symbol}`);
    price.textContent = Number.isFinite(value) ? formatPrice(value) : "…";
    button.append(text, price);
    button.addEventListener("click", () => selectSymbol(pair.venue, pair.symbol));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${pair.symbol}`);
    remove.addEventListener("click", () => {
      state.watchlist = state.watchlist.filter((item) => item !== pair);
      warnStorage(saveWatchlist(state.watchlist));
      renderWatchlist(prices);
    });
    const row = document.createElement("div");
    row.className = "result-line";
    row.append(button, remove);
    container.append(row);
  }
}

async function refreshPrices() {
  state.priceAbort?.abort();
  state.priceAbort = new AbortController();
  renderWatchlist();
  try {
    const prices = await fetchPrices(state.watchlist, state.priceAbort.signal);
    renderWatchlist(prices);
  } catch (error) {
    if (error?.name === "AbortError") return;
    $("list-note").textContent = error.message || "Prices are unavailable right now.";
  }
}

function addWatch(pair) {
  if (state.watchlist.some((item) => item.venue === pair.venue && item.symbol === pair.symbol)) return;
  state.watchlist = state.watchlist.concat({ venue: pair.venue, symbol: pair.symbol });
  warnStorage(saveWatchlist(state.watchlist));
  renderWatchlist();
}

function toggleCurrentWatch() {
  const index = state.watchlist.findIndex((pair) => pair.venue === state.venue && pair.symbol === state.symbol);
  if (index >= 0) state.watchlist = state.watchlist.filter((_, item) => item !== index);
  else state.watchlist = state.watchlist.concat({ venue: state.venue, symbol: state.symbol });
  warnStorage(saveWatchlist(state.watchlist));
  refreshPrices();
}

function persistDrawings() {
  chart.setDrawings(state.drawings);
  warnStorage(saveDrawings(symbolKey(state.venue, state.symbol), state.drawings));
  renderDrawings();
}

function renderDrawings() {
  const container = $("drawing-list");
  container.replaceChildren();
  if (!state.drawings.length) {
    const empty = document.createElement("p");
    empty.className = "help";
    empty.textContent = "No saved lines for this symbol.";
    container.append(empty);
    return;
  }
  for (const drawing of state.drawings) {
    const row = document.createElement("div");
    row.className = "drawing-row";
    const label = document.createElement("span");
    label.textContent = drawing.type === "hline" ? `Level ${formatPrice(drawing.price)}` : "Trend line";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => {
      state.drawings = state.drawings.filter((item) => item.id !== drawing.id);
      persistDrawings();
    });
    row.append(label, remove);
    container.append(row);
  }
}

function newId() {
  return `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function setTool(tool) {
  state.tool = tool;
  chart.setTool(tool);
  for (const button of document.querySelectorAll("[data-tool]")) {
    button.setAttribute("aria-pressed", button.dataset.tool === tool ? "true" : "false");
  }
  $("draw-help").textContent = toolHelp[tool] ?? toolHelp.pan;
}

function stopPrices() {
  clearInterval(state.priceTimer);
  state.priceTimer = null;
  state.priceAbort?.abort();
}

function setTab(tab) {
  document.querySelectorAll("[data-sheet]").forEach((sheet) => {
    sheet.hidden = sheet.dataset.sheet !== tab;
  });
  $("draw-dock").hidden = tab !== "draw";
  document.querySelectorAll(".tab").forEach((button) => {
    button.setAttribute("aria-selected", button.dataset.tab === tab ? "true" : "false");
  });
  if (tab !== "list") stopPrices();
  if (tab === "search") {
    $("search-input").focus();
    runSearch();
  }
  if (tab === "list") {
    refreshPrices();
    state.priceTimer = setInterval(refreshPrices, 20_000);
  }
  if (tab === "test") updateCoverage();
  requestAnimationFrame(() => chart.resize());
}

function syncStrategyFields() {
  const smaRule = $("strategy").value === "sma";
  $("sma-fields").hidden = !smaRule;
  $("rsi-fields").hidden = smaRule;
}

function runTest(event) {
  event.preventDefault();
  const error = $("bt-error");
  error.hidden = true;
  if (!state.candles.length) {
    error.hidden = false;
    error.textContent = "Load candles before running a test.";
    return;
  }
  const strategy = $("strategy").value;
  try {
    const result = runBacktest(state.candles, {
      strategy,
      fast: integerInput("bt-fast", 10),
      slow: integerInput("bt-slow", 30),
      period: integerInput("bt-rsi", 14),
      oversold: numberInput("bt-oversold", 30, 0),
      overbought: numberInput("bt-overbought", 70, 0),
      feeBps: numberInput("bt-fee", 10, 0),
      slippageBps: numberInput("bt-slip", 5, 0),
      initialCapital: numberInput("bt-capital", 10_000, 0),
    });
    $("bt-results").hidden = false;
    const returnNode = $("bt-return");
    returnNode.textContent = formatPercent(result.return);
    returnNode.className = result.return > 0 ? "up" : result.return < 0 ? "down" : "";
    $("bt-dd").textContent = formatPlainPercent(result.maxDrawdown);
    $("bt-win").textContent = result.winRate == null ? "—" : formatPlainPercent(result.winRate, 1);
    $("bt-trades").textContent = String(result.tradeCount);
    const open = result.openPosition
      ? " One position is still open, marked at the last close, and excluded from the win rate."
      : "";
    $("bt-detail").textContent = `Ending equity ${formatPrice(result.finalEquity)} from ${formatPrice(result.initialCapital)}.${open}`;
    requestAnimationFrame(() => drawEquity($("equity"), result.equity));
  } catch (failure) {
    error.hidden = false;
    error.textContent = failure.message;
    $("bt-results").hidden = true;
  }
}

function bind() {
  $("symbol-button").addEventListener("click", () => setTab("search"));
  $("about-button").addEventListener("click", () => setTab("about"));
  $("retry-button").addEventListener("click", () => loadSymbol());
  $("latest-button").addEventListener("click", () => chart.pin());
  $("add-current").addEventListener("click", toggleCurrentWatch);
  $("search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const direct = exactSymbol($("search-input").value);
    if (direct) selectSymbol(direct.venue, direct.symbol);
    else runSearch();
  });
  $("search-input").addEventListener("input", () => {
    clearTimeout(bind.searchTimer);
    bind.searchTimer = setTimeout(runSearch, 150);
  });
  for (const button of document.querySelectorAll(".tab")) {
    button.addEventListener("click", () => setTab(button.dataset.tab));
  }
  for (const button of document.querySelectorAll("[data-close]")) {
    button.addEventListener("click", () => setTab("chart"));
  }
  for (const button of document.querySelectorAll("[data-tool]")) {
    button.addEventListener("click", () => setTool(button.dataset.tool));
  }
  document.querySelector('[data-sheet="study"]').querySelectorAll("input").forEach((input) => {
    input.addEventListener("change", () => {
      buildSeries();
      warnStorage(savePrefs(currentPrefs()));
    });
  });
  $("strategy").addEventListener("change", syncStrategyFields);
  $("backtest-form").addEventListener("submit", runTest);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setTab("chart");
  });
  chart.setOnCursor((cursor) => {
    state.hover = cursor;
    updateLegend(cursor);
  });
  chart.setOnView(({ pinned }) => {
    $("latest-button").hidden = pinned;
  });
  chart.setOnCommit((drawing) => {
    state.drawings = state.drawings.concat({ ...drawing, id: newId() });
    persistDrawings();
  });
  chart.setOnDelete((id) => {
    state.drawings = state.drawings.filter((drawing) => drawing.id !== id);
    persistDrawings();
  });
}

function buildTimeframes() {
  const row = $("tf-row");
  for (const timeframe of TIMEFRAMES) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = timeframe.label;
    button.dataset.timeframe = timeframe.id;
    button.setAttribute("aria-pressed", timeframe.id === state.timeframe ? "true" : "false");
    button.addEventListener("click", () => {
      if (state.timeframe === timeframe.id) return;
      state.timeframe = timeframe.id;
      for (const item of row.querySelectorAll("button")) {
        item.setAttribute("aria-pressed", item.dataset.timeframe === timeframe.id ? "true" : "false");
      }
      loadSymbol();
    });
    row.append(button);
  }
}

function init() {
  const prefs = loadPrefs();
  state.venue = prefs.venue;
  state.symbol = acceptableSymbol(prefs.venue, prefs.symbol)
    ? prefs.symbol
    : prefs.venue === "coinbase"
      ? "BTC-USD"
      : "BTCUSDT";
  state.timeframe = knownTimeframes.has(prefs.timeframe) ? prefs.timeframe : "1h";
  state.watchlist = loadWatchlist();
  applyIndicatorForm(prefs.indicators);
  buildTimeframes();
  bind();
  syncStrategyFields();
  setTool("pan");
  updateQuote();
  loadSymbol({ allowFallback: state.venue === "binance" });
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js", { type: "module" }).catch(() => {
      // The chart still runs when the worker cannot install.
    });
  }
}

init();
