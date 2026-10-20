# Northmark

Northmark is an independent, mobile-first market charting and quant research app. It is not TradingView and is not affiliated with TradingView, Binance, or Coinbase. The chart, indicators, and backtester are original implementations of publicly documented formulas and ideas. The app does not copy another product's code, assets, branding, or private indicator scripts, and it does not call private, authenticated, or paywalled APIs.

Runtime dependencies: none. Local tests use Node.js 20 or newer (`npm test`). The site is static.

## Run locally

```bash
cd trading-terminal
npm test
npm start
```

`npm start` serves the folder at `http://127.0.0.1:4173` with the right MIME types for the manifest and module service worker. Open that origin so the service worker scope matches the app.

## What it does

- Candlestick chart with pan, wheel zoom, and pinch zoom. Arrow keys pan; plus and minus zoom.
- Symbol search and timeframes from 1 minute through 1 week.
- SMA, EMA, RSI (Wilder), MACD, Bollinger Bands (population standard deviation), session VWAP reset each UTC day, and raw volume.
- Trend lines and horizontal levels, stored per symbol in `localStorage`.
- A device watchlist, also in `localStorage`.
- A long-or-flat backtest on the candles currently loaded. Signals use that bar's close. Fills happen at the next bar's open. Fees are charged on entry cash and on exit proceeds. Slippage raises buys and lowers sells. The report includes total return, max drawdown, win rate, completed trade count, and an equity curve. An open position is marked at the last close and is not counted as a completed trade.
- A PWA manifest, icons, and a service worker. The worker caches the app shell only. It ignores other origins, so Binance and Coinbase responses are never cached.

## Data sources and limits

No API key is used. The browser calls these public endpoints directly.

### Binance public market data

- REST: `https://data-api.binance.vision`
- WebSocket: `wss://data-stream.binance.vision/ws`
- Spot symbols quoted in USDT, taken from the public price list (not the full exchange-info document, which is very large).
- History: one `GET /api/v3/klines` request, `limit=1000`.
- Live: `<symbol>@kline_<interval>` for 1m, 5m, 15m, 1h, 4h, 1d, and 1w.
- The app does not call `api.binance.com`. From this development network that host returned HTTP 451. Availability of the market-data host can still change by region or by Binance's own rules.
- Binance's `exchangeInfo` document advertises a request-weight limit (6000 per minute on the payload checked while building this app). Northmark uses one kline request per symbol load, one symbol-list request when search opens, and the websocket after that.
- Kline responses observed here used `cache-control: no-cache`. The stream is still a public market-data feed, not a colocated trading link.

### Coinbase Exchange public market data

- REST: `https://api.exchange.coinbase.com`
- WebSocket: `wss://ws-feed.exchange.coinbase.com` (`matches` and `heartbeat`)
- Online USD products.
- Candles: `GET /products/{id}/candles`. Coinbase rejects a range that would return more than 300 candles. Northmark requests four pages of 299 candles.
- Native intervals: 1m, 5m, 15m, 1h, 1d. **4h** is aggregated in the app from 1h candles. **1w** is aggregated from 1d candles into weeks that start Monday 00:00 UTC. Live trades use that same bucket.
- A candle response observed during development included `cache-control: public, max-age=300`, so closed-candle history can be a few minutes behind the exchange. The open candle is updated from the matches channel, which is not that cached REST body.
- Coinbase can rate-limit public REST. This app does not poll candles in a loop.

### Stocks

No stock symbols. A keyless stock source that both allows browser calls (CORS) and clearly permits this use was not found. The app does not use unofficial or keyed stock APIs.

### Other limits

- The backtest only sees the loaded window (about 1000 Binance candles, or up to about 1,196 Coinbase base candles before 4h or 1w aggregation).
- Chart times are UTC.
- Drawings and the watchlist never leave the device.
- Nothing in Northmark places orders or asks for an exchange account.
- A simulation is not a forecast and is not investment advice.

## Deploy on Vercel

Create a Vercel project from this repository and set:

| Setting | Value |
| --- | --- |
| Root Directory | `trading-terminal` |
| Framework Preset | Other |
| Install Command | empty (skip install; there are no dependencies) |
| Build Command | none, or leave the committed no-op |
| Output Directory | `.` (this directory, where `index.html` lives) |

`vercel.json` already sets `"framework": null` (Other), `"installCommand": ""`, a no-op `buildCommand`, and `"outputDirectory": "."`. Those values override the dashboard for a deployment. Do not point the project at the repository root, or Vercel will try to build the surrounding toolkit instead of this static app.

The service worker is `sw.js` at the site root and is served with `Cache-Control: no-cache`. It must stay at the root of the deployed origin so its scope covers the app.

## Tests

`npm test` runs Node's built-in test runner. Coverage includes indicator math, the backtester (next-bar fills, fees, slippage, drawdown, win rate, open positions), candle parsing, aggregation, live candle updates, and the service-worker rule that refuses market-data URLs.
