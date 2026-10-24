# Trade Tracker screener plan

This is a planning note for the owner's personal paper-trading app, Trade Tracker (the local app is also branded AlpacaDesk). It explains how that app is put together, how the free Finviz screener works, and how a similar Screener page could be added later with prices that update as trades happen.

Nothing in this file changes the app. There is no new page, no new order path, and no change to REA. Building the page is a later project in the Trade Tracker folder on your computer.

This is not investment advice. A screener only lists stocks that match rules you chose.

Checked against public Finviz and Alpaca pages on October 24, 2026. Prices, plan limits, and delay wording change. The links in [Sources](#sources) are the pages that were read. This note does not call Alpaca or log in to Finviz.

## Words used below

| Word | Plain meaning |
| --- | --- |
| Snapshot | One Alpaca answer for a symbol: latest trade, latest quote, the current minute, today's bar, and yesterday's bar. |
| IEX | One US stock exchange. On Alpaca's free plan, IEX prices and IEX volume are available as they happen. |
| SIP | The combined tape of US stock exchanges. Real-time SIP is Alpaca's Algo Trader Plus plan at $99 a month. |
| Bar | Open, high, low, close, and volume for a stretch of time (a minute, a day, and so on). |
| Gap | How far today's open is from yesterday's close. |
| RVOL | Relative volume. Today's volume compared with a normal day, adjusted for how much of the session has passed. |
| Paper | A simulated account. No real money. The screener still must not send orders. |

## 1. How Trade Tracker is structured

### What is in this git repo, and what is only on your computer

This repository is a fork of [morluto/rea](https://github.com/morluto/rea). REA is a local reverse-engineering tool. It is not the trading app.

`main` has no stock market code. A search of the tree found no Finviz, screener, Alpaca, watchlist, or gap-scanner code.

The other branches are personal apps added beside REA:

| Branch | What it is |
| --- | --- |
| `main` | REA only. |
| `cursor/property-comps-records-2cd4` | An Arizona property-records app. Not related to stocks. |
| `cursor/northmark-trading-terminal-6e49` | The trading terminal branch. Current tip is `194c6fc14`. |

That trading branch has two commits:

1. `cca0862da` added a separate app called Northmark under `trading-terminal/`. Northmark is a static chart page for crypto. It reads public Binance and Coinbase data in the browser. It has no stock symbols, no Alpaca account, and no screener. Drawings and its watchlist stay in the browser's `localStorage`.
2. `194c6fc14` removed Northmark and replaced it with `alpacadesk-charts/`, a patch for the local Trade Tracker app.

The Trade Tracker program itself is not committed. The patch was built against a folder on disk called TradeTracker, the directory that contains `app.py`. What we can say about the app comes from these files on that branch:

- `alpacadesk-charts/INSTALL.md`
- `alpacadesk-charts/ui.py` (the shared sidebar and watchlist)
- `alpacadesk-charts/chart.py` (the chart page)
- `alpacadesk-charts/studies.py` (indicator math)
- `alpacadesk-charts/install.patch` (the before-and-after of the chart work)

`INSTALL.md` names the local files the patch leaves alone. Their contents were not in git, so their rules are not described here.

### The web server and the pages

Trade Tracker is a local website written in Python with Flask. Flask is the library that answers browser requests. You start it the way you already do, then open `http://127.0.0.1:8765/`. The chart patch expects the chart at `http://127.0.0.1:8765/chart`.

Pages share one sidebar, built by `shell()` in `ui.py`. The links in that sidebar are:

| Link | Address | What the branch tells us |
| --- | --- | --- |
| Trade Tracker | `/` | Home. The page file is not in git. |
| Charts | `/chart` | Candles, indicators, drawings, and a practice backtest. This page is in the branch. The nav label used to say Overview. |
| News | `/news` | Linked. The page file is not in git. |
| Strategies | `/strategies` | Linked. See [Strategies](#strategies). |
| Performance | `/performance` | Linked. The page file is not in git. |
| Gapper Toolkit | `/toolkit` | Linked. The scanner file is `sdesk/gappers.py`, which is not in git. |
| Stock Desk | `/stocks` | Linked. The page file is not in git. |
| Bots | `/bots` | Linked. The page file is not in git. |

The top of every one of these pages shows four numbers from the Alpaca paper account: equity, buying power, day P&L, and unrealized P&L. A badge reads `PAPER · READ ONLY`. A checkbox refreshes the page every 60 seconds. The chart page is explicit that it does not submit, cancel, or close an order, and it does not point at a live-trading endpoint.

`app.py` is the program that starts Flask and registers the pages. The chart page is already registered there. A future Screener page would be registered the same way. `app.py` is not in this repo.

### Where the numbers come from

There are two Alpaca doors, and the chart page already uses both through the existing `broker.Alpaca` client.

- Account, positions, and the order history shown on the chart come from the paper trading account. The keys are the environment variables `ALPACA_PAPER_KEY_ID` and `ALPACA_PAPER_SECRET_KEY`. `INSTALL.md` says the patch does not point the app at live trading.
- Stock and crypto candles come from `https://data.alpaca.markets`. Stock bars are requested with `feed=iex` and `adjustment=split`. Crypto symbols (the ones that contain `/`) use `/v1beta3/crypto/us/bars`.

The sidebar footer already says "IEX market data". The chart page prints the feed name next to the bar count (`iex` or `crypto`).

The browser never sees the keys. The page asks your Flask server, and the server asks Alpaca. A screener should keep that shape.

`ui.py` also shows `mode` from the broker client. The screener should keep showing the paper badge. If that mode is ever not paper, the page should say so in the header. Either way, the screener sends no orders.

### Watchlist

The sidebar watchlist is local. It is the `news_watchlist` list inside `sdesk/config.json`, next to the app, not in this repo.

- `GET /api/watchlist` returns the list.
- `POST /api/watchlist` with `{"symbol": "AAPL", "action": "add"}` adds a symbol.
- The same address with `"action": "remove"` removes it.

Symbols are uppercased. They can be at most 12 characters, made of letters, digits, and `/.-`. That is the same check the chart uses, so crypto pairs such as `BTC/USD` can sit on the list too.

"Send to watchlist" on a future screener is this existing add action. It does not need a second list.

### Gap scanner

The Gapper Toolkit is the `/toolkit` link. `INSTALL.md` names `sdesk/gappers.py` and says the chart patch does not change it. That file is not in git, so this note does not know the scan rules, the symbols it watches, or whether it can place a paper order.

The safe "send to gap scanner" action is a pin: write the symbol, the time, and why it matched into a new file such as `sdesk/screener_pins.json`. A person can open the toolkit and look at the pin. Wiring that pin into `gappers.py` waits until that file has been read, so a guess cannot start or change a bot.

### Strategies

Two different things share the word "strategy":

1. The chart page backtest, which is in `studies.py` on the trading branch. It can replay two long-or-flat rules: an SMA cross, and RSI leaving an oversold or overbought level. A signal uses only bars through that close and fills at the next bar's open. Fees and slippage are numbers in the replay. The file's own text says the simulation does not place orders. `studies.py` does not import Flask or the broker.
2. The app's strategy engine: `sdesk/strategies.py`, `sdesk/strategies_web.py`, and `sdesk/executor.py`. Those names are in `INSTALL.md`. Their code is not in git. The chart patch was written so it would not touch them, and so a saved drawing would not write the strategy config.

The screener is a list for a person to read. It is in the first group, with the chart: math and display. It stays out of `executor.py`.

Indicators already implemented in `studies.py`, and safe to reuse:

| Function | What it calculates |
| --- | --- |
| `sma` | Simple moving average. |
| `ema` | Exponential moving average, seeded with an SMA. |
| `rsi` | RSI with Wilder smoothing. |
| `macd` | MACD line, signal line, and histogram. |
| `bollinger` | Bollinger Bands using the population standard deviation. |
| `vwap` | VWAP. Intraday VWAP resets on the New York date. |
| `pack` | Bundles those studies for the chart response. |

ATR is not in `studies.py` yet. A later change can add it beside `rsi` as plain math.

### Config files

| File | Role | In git? |
| --- | --- | --- |
| `sdesk/config.json` | Holds `news_watchlist`. Other keys were not visible. | No. The patch must not rewrite it. |
| `sdesk/chart_drawings.json` | Lines drawn on the chart, per symbol. Created on the first save. | No. It is not strategy config. |
| Environment keys | `ALPACA_PAPER_KEY_ID`, `ALPACA_PAPER_SECRET_KEY`. | Never commit these. |

A screener should get its own files, for the same reason drawings have their own file:

- `sdesk/screener_presets.json` for saved filter setups.
- `sdesk/screener_cache.json` for the once-a-day history math.
- `sdesk/screener_pins.json` for symbols a person pinned for the gap toolkit.

Those files should not be written into `config.json` or the strategy files.

## 2. Is there already a Finviz-style screener?

No.

- `main` is REA. It has no stock screener.
- Northmark, the first trading-terminal commit, charts crypto from public exchange feeds. It does not screen stocks.
- The current trading-terminal tip charts one symbol at a time from Alpaca. You type a ticker, or you pick one from the watchlist. There is no filter list, no "stocks up 5% today," and no Finviz page.
- The chart's symbol box is a search of one symbol, not a scan of the market.

The closest pieces to reuse are the watchlist API, the IEX bar fetch in `chart.py`, and the indicator functions in `studies.py`.

## 3. How the free Finviz screener works

Finviz's screener searches US stocks listed on NASDAQ, NYSE, and AMEX and returns the ones that match the filters you set. The official help page is [finviz.com/help/screener](https://finviz.com/help/screener). The layout below is that page, plus the free-versus-Elite table on [finviz.com/elite](https://finviz.com/elite).

### Filter groups

The filters are the rules. Finviz puts them in groups. The three you asked about cover the rules on the official help page. The live screener also has tabs that gather the rest (a current walkthrough lists News, ETF, and All). This plan does not depend on those extra tabs.

**Descriptive** filters describe the listing and the trading size:

- Exchange: NASDAQ, NYSE, or AMEX.
- Index membership, such as the Dow or the S&P 500.
- Sector, industry, and country of a company listed in the US.
- Market cap, which is price times shares outstanding. Float is the shares that can actually trade.
- Dividend yield.
- Short float (shares sold short, divided by the float).
- Analyst recommendation, on a scale from 1.0 (strong buy) to 5.0 (strong sell).
- Earnings date.
- Average volume (typical daily volume over about three months), relative volume, today's volume, and price.
- Share counts: shares outstanding and float.

**Fundamental** filters come from financial statements and forecasts:

- Valuation: P/E, forward P/E, PEG, P/S, P/B, price/cash, price/free cash flow.
- Earnings: EPS for the last twelve months, and growth for this year, next year, the past five years, the next five years, and the latest quarter versus a year ago.
- Sales growth for the latest quarter and for the past five years.
- Profit and health: return on assets, return on equity, return on invested capital, current ratio, quick ratio, long-term debt/equity, debt/equity, gross margin, operating margin, net margin, payout ratio.
- Ownership: insider ownership, insider transactions, institutional ownership, institutional transactions.

**Technical** filters come from the price and volume history:

- Performance over a week, month, quarter, half year, year, and longer windows. Finviz defines a week as 5 trading days, a month as 21, a quarter as 63, a half year as 126, and a year as 252.
- Volatility, as the average daily high-to-low percent range.
- RSI(14).
- Gap: today's open versus yesterday's close.
- Change versus yesterday's close, and change versus today's open.
- Price versus the 20-day, 50-day, and 200-day simple moving averages, and those averages versus each other.
- Distance from the 20-day, 50-day, and 52-week high or low.
- Average true range (ATR).
- Beta over five years.
- Chart patterns and candlestick patterns. The help page says these two are not sortable and are not in the export.

A **signal** is separate from those filters. It is a canned event, such as "this stock is a top gainer today." You can stack a signal on top of filters. The public Finviz pages name these signals: Top Gainers, Top Losers, New High, New Low, Most Volatile, Most Active, Unusual Volume, Overbought, Oversold, Upgrades, Downgrades, Earnings Before, Earnings After, Major News, Insider Buying, and Insider Selling. The help page defines three of them by size: unusual volume is the 200 stocks with the highest relative volume, overbought is the top 200 by the RSI reading, and oversold is the top 100. Pattern names (wedges, triangles, channels, double tops, head and shoulders) also exist as signals. Treat the pattern list as something to confirm on the signal menu, because the help page describes patterns without printing every menu label.

### Views

A view is which columns you see. The stock list stays the same. The official help text names these views by where each column appears: Overview, Snapshot, Fundamental, Financial, Ownership, Performance, and Technical. Overview is the everyday table (ticker, company, sector, price, change, volume). Performance is the set of percent-change columns. Technical is RSI and the moving-average distances. There is also a charts grid: a small chart per row, which is the fast way to skip a name that "matches" but looks wrong. Snapshot is a denser card. Stock Overview in the help text is the single-stock page, not a table tab.

Free accounts see fewer rows per page, so you click through pages. The Elite comparison table says a free account shows 20 table rows, 36 charts, or 10 snapshots per page. Elite shows 100, 120, or 50.

### Sorting

You sort by clicking a column header. The address of the page remembers the sort. On Finviz the sort rides in the `o=` part of the URL, with a minus sign for high-to-low. Some fields cannot be sorted. The help page says exchange, index, chart pattern, and candlestick pattern are not sortable.

### Presets

A preset is a saved combination of filters. You pick it again from the screener menu instead of clicking every filter. A free registered account can save 50 presets. Elite can save an unlimited number. The same screen is also stored in the page address (`v=` for the view, `f=` for the filters, `o=` for the sort, `s=` for the signal), so a bookmark reopens it.

### Free-tier limits

From the Elite comparison table and the "How often is your data updated?" answer on that same page:

| | Free (registered) | Elite |
| --- | --- | --- |
| Stock quotes | Delayed. Finviz's own answer says the regular site delays NASDAQ, NYSE, and AMEX quotes by **1 minute**. | Real-time. |
| Premarket and after-hours | Not included. Elite lists premarket as 4:00–9:30 AM and after-hours as 4:00–8:00 PM Eastern. | Included. |
| Filters | Basic. | Advanced. The Elite page says this adds 20+ advanced filters. Which exact filters are paid is not spelled out on the help page. |
| Saved presets | 50 | Unlimited |
| Rows / charts / snapshots per page | 20 / 36 / 10 | 100 / 120 / 50 |
| Auto-refresh | Every 3 minutes | Every 10 seconds |
| Excel or CSV export | Not included | Included |
| Alerts | Not included | Unlimited |
| Intraday charts | Not included | Included |
| Financial statement history | 3 years | 8 years |
| Ads | Shown | Hidden |

The footer on Finviz pages also says stock quotes are delayed by 1 minute, and that futures and options are delayed by 15 minutes. The Elite FAQ sentence says futures are delayed 20 minutes. Those two futures numbers disagree on Finviz's own site. It does not matter for this plan, which is US stocks only.

Older descriptions of Finviz often said stocks were delayed 15 minutes. The pages read for this note say **1 minute** for stocks. Elite is the real-time product.

Export is an Elite feature, including the screener API. A Finviz blog post about that API says Elite is limited to 10 requests every 5 seconds, shared across export endpoints. The Trade Tracker screener should not scrape the Finviz website or call that API. Scraping would copy the delay, can break when the page changes, and uses a product whose export is paid. The goal is to compute our own rows from Alpaca and from public filings.

## 4. A real-time screener for Trade Tracker

### What "real-time" can mean on the free Alpaca plan

Alpaca's Trading API, which is the kind of account this app uses, has two market-data plans. The table is on [About Market Data API](https://docs.alpaca.markets/us/docs/about-market-data-api). The precise IEX-versus-SIP rules are in the [Market Data FAQ](https://docs.alpaca.markets/us/docs/market-data-faq).

| | Basic (free, paper or live) | Algo Trader Plus |
| --- | --- | --- |
| Price | $0 | $99 / month |
| Real-time stock coverage | IEX only | All US stock exchanges (the SIP tape) |
| Websocket symbols at once | 30 | Unlimited |
| History | From 2016 | From 2016 |
| Most recent SIP history | The latest 15 minutes are withheld | No restriction |
| Market-data calls | 200 / minute | 10,000 / minute |

The chart already asks for `feed=iex`. That matches a free account. This plan assumes Basic until a SIP request succeeds.

**IEX latest data is not on a 15-minute delay.** The FAQ says the latest endpoints, including snapshots, use IEX when you are not subscribed. Their example of "latest AAPL trade" with no subscription comes back with exchange code `V`, which is IEX, and a current timestamp. Asking that same endpoint for `feed=sip` returns `subscription does not permit querying recent SIP data`.

The "latest 15 minutes" row in the plan table is a SIP rule. On the free plan, a SIP history request must set `end` at least 15 minutes in the past. Yesterday's SIP daily bar is allowed. Today's forming SIP bar is not.

There is a third feed, `delayed_sip`: the full tape, held back 15 minutes. The stream docs list `wss://stream.data.alpaca.markets/v2/delayed_sip`. On October 8, 2025, an Alpaca technical account said the free Basic plan can connect to that delayed SIP stream and to the IEX stream, and that IEX is only open from 8:00 to 17:00 Eastern, so the IEX stream has nothing after 17:00. That reply also said IEX is mainly for debugging an algorithm because it is not the full market. Official docs remain the contract; that reply is the source for the 8:00–17:00 window. `delayed_sip` is the wrong feed for a page whose job is to avoid a delay. It can still be used, after one test request, for official volume that is already more than 15 minutes old.

### Why IEX volume breaks a Finviz-style RVOL

IEX volume counts shares that printed on IEX. SIP volume counts shares that printed anywhere. Finviz relative volume uses the full tape: current volume divided by the three-month average, adjusted for the time of day.

Alpaca's own FAQ example is Apple on September 29, 2023:

| | IEX | SIP |
| --- | --- | --- |
| Volume | 923,134 | 51,861,083 |
| Trades | 12,630 | 535,134 |

IEX was about 1.8% of Apple's consolidated volume that day. The share is different for every stock and every day. A small stock that gaps on NASDAQ may have no IEX print for a long time.

Two rules follow:

1. Divide IEX volume by IEX average volume. Dividing today's IEX volume by a SIP (or Finviz) average makes a busy stock look dead.
2. Name the column **IEX RVOL**, and show the time of the last IEX trade. If that trade is old, the row is the last IEX print, while the stock may be trading somewhere else.

A simple time-of-day adjustment, so morning RVOL is comparable to Finviz's idea of RVOL:

`IEX RVOL ≈ (IEX volume so far / fraction of the regular session elapsed) / average full-day IEX volume`

The regular session is 9:30–16:00 Eastern. This will still not match Finviz. It is an IEX estimate. Before 9:30, skip the fraction and show raw IEX volume instead, because the fraction is about the regular session.

Gap has the same feed problem. An IEX gap is the IEX open versus the prior IEX close. The official gap is the SIP open versus the prior SIP close. For a liquid stock they are close. For a thin gapper they may not be, and before 8:00 Eastern there is no IEX trade to form an open.

That is the real trade-off for this app. The Gapper Toolkit cares about names that move before and right after the open, often on light listings. Those are the names IEX covers worst. Free IEX still gives a real-time price when IEX is printing, which is fresher than Finviz's free 1-minute stock quote, and it covers a useful screen of liquid names. If the point of the page is the premarket gap scan, Algo Trader Plus is the feed that sees the whole tape from 4:00 Eastern. Build the page so the feed is one setting, default `iex`. Switching to `sip` later should not require a new page.

### Snapshots every few seconds, not a websocket of the whole market

A screener looks at thousands of symbols. The free websocket allows 30 symbols, and many Alpaca subscriptions allow only one stream connection (a second connection gets error 406, "connection limit exceeded"). Subscribing to every symbol on the free plan gets error 405, "symbol limit exceeded." The websocket is a good fit for a watchlist. It is a poor fit for the scan.

The snapshot endpoint is the scan:

`GET https://data.alpaca.markets/v2/stocks/snapshots?symbols=AAPL,MSFT&feed=iex`

Each symbol comes back with `latestTrade`, `latestQuote`, `minuteBar`, `dailyBar`, and `prevDailyBar`. From those five objects the page can compute price, change, change from the open, gap, and today's IEX volume, without downloading history again.

The published snapshot docs do not state a maximum number of symbols per call. The practical limit is the length of the URL. Pick a batch size by measuring (a few hundred symbols is a reasonable first try) and stop raising it when Alpaca returns an error.

Sketch of the call budget. These counts were not measured against the account. Replace them with the asset count from step 1 before trusting the interval.

- Budget: 200 market-data calls per minute on Basic. Plan as if snapshots use that budget. If a response says otherwise, adjust. Back off on HTTP 429.
- Suppose the universe is 6,000 symbols and a batch holds 200. One full pass is 30 calls.
- A pass every 15 seconds is about 120 calls per minute. That leaves room for the chart page, which also calls the data API.
- If batches have to be smaller, or the chart is busy, slow the screener. A 15-second table is already faster than Finviz free (3 minutes) and in the same range as Finviz Elite (10 seconds).
- Outside 9:30–16:00 Eastern, refresh once a minute, or only when the page opens. IEX itself goes quiet outside 8:00–17:00 Eastern.

The websocket can still update the rows on screen, at most 30 symbols, and only when nothing else is using the one connection. The chart today does not open a stream. It reloads bars on the 60-second timer. Leave the stream unused until the snapshot table works. One connection fighting the chart, a bot, and the screener is worse than a 15-second snapshot.

History for RSI, moving averages, and average volume is a different, slower job. Download daily IEX bars once before the open, compute the indicators, and save them in `screener_cache.json`. During the day, move those indicators with the live price (today's close in the formula becomes the latest trade). Do not re-download a year of bars every 15 seconds.

`chart.py` already shows the bar request shape: `GET /v2/stocks/bars` with `feed=iex`, `adjustment=split`, a `start`, and `limit`. Multi-symbol bars return a page token when the answer is incomplete. Follow that token, and keep the same split adjustment the chart uses so the screener and the chart agree.

### A feed setting, not a rewrite

Put the feed in the screener's own settings, default `iex`. Allowed values for the live table: `iex` and, if the account is subscribed, `sip`.

If a `sip` call returns "subscription does not permit querying recent SIP data," show that sentence and keep serving `iex`. Do not swap in `delayed_sip` and label the table real-time.

On SIP, the same math applies with one change: volume, RVOL, gap, and the last trade are the consolidated tape, and the column names drop the IEX prefix. Premarket from 4:00 Eastern becomes visible. The $99 plan also raises the call budget to 10,000 per minute and removes the 30-symbol stream cap, so a stream of the rows you care about becomes practical. The page design stays the same.

### Free fundamental data

Alpaca assets (`GET /v2/assets`) tell you the symbol, the company name, the exchange, and whether the stock is active and tradable. They do not include sector, market cap, earnings, or a P/E.

Use SEC EDGAR for the accounting numbers. It is the official filing database, it is free, and it does not depend on a vendor's free tier surviving.

- Ticker to company id: `https://www.sec.gov/files/company_tickers.json`
- Facts: `https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json` (the CIK is 10 digits)
- SEC asks for a descriptive User-Agent and no more than 10 requests per second. See [SEC developer fair access](https://www.sec.gov/os/accessing-edgar-data).

Prefer the nightly bulk file, one download for every company, instead of one request per ticker: `https://www.sec.gov/Archives/edgar/daily-index/xbrl/companyfacts.zip`. The SEC rebuilds that zip around 3:00 AM Eastern. Join it to symbols with `company_tickers.json`. Store the filing date beside every ratio. Market cap, P/E, P/S, and P/B can use the live IEX price on top of those share and earnings counts. Show the filing date so a live price is not mistaken for a fresh earnings report.

`data.sec.gov` does not allow the browser to call it directly. The Flask server downloads the file. The 15-second table never waits on the SEC.

SEC does not provide analyst forecasts. Forward P/E, PEG, target price, and upgrade/downgrade signals have no free source that matches Finviz. Leave them off the page.

Short interest is published by FINRA about twice a month. That can be a later column. It is not real-time.

Do not block the 15-second table on an SEC download. If the fundamentals file is missing, the price table still works.

### Feature mapping

"Real-time?" means the number moves during the session on the free IEX plan. "Feasible?" is about a personal page, not about matching Finviz to the penny.

| Finviz filter | Source | Real-time on free IEX? | Feasible? |
| --- | --- | --- | --- |
| Exchange | Alpaca `/v2/assets` | Listing fact | Yes |
| Index (S&P 500, Dow, …) | A local list you update | No | Yes, if you keep the list. There is no official free S&P feed. |
| Sector, industry | Not in Alpaca or a simple SEC field | No | Leave blank in the first version |
| Country | SEC business address, cleaned up | No | Later |
| Market cap | IEX price × shares from the latest 10-Q/10-K | Price yes, shares as of the filing | Yes. Show the filing date. |
| Dividend yield | Trailing dividends from SEC, divided by price | Price yes | Yes, trailing. The forward estimate is not in SEC. |
| Short float | FINRA short-interest file | No | Later. It updates about twice a month. |
| Analyst recommendation, target price | Not in Alpaca or SEC | No | No in this plan |
| Earnings date | Needs a calendar. The 8-K arrives after the report. | No | Later |
| IPO date | Not on the Alpaca asset | No | Later |
| Shares outstanding | SEC company facts | As of the filing | Yes |
| Float | Needs insider and large-holder shares | No | Later |
| Average volume | ~63 trading days of IEX daily bars, cached | Once a day | Yes, labeled IEX average volume |
| Relative volume | IEX volume so far versus that average, with the session-fraction adjustment | Today's volume yes | Yes, labeled IEX RVOL. It will not match Finviz. |
| Current volume | Snapshot `dailyBar.v` | Yes, IEX shares only | Yes, labeled IEX volume |
| Price | Snapshot `latestTrade.p` | Yes, when IEX has a fresh print | Yes. Always show the trade time. |
| P/E, P/S, P/B, price/cash | Live IEX price divided by SEC per-share facts | Price yes, fundamentals as of the filing | Yes, with the filing date |
| Price / free cash flow | SEC cash-flow facts, more assembly required | Price yes | Later |
| EPS (ttm), EPS growth past 5 years, quarter-over-quarter EPS and sales | SEC company facts | As of the filing | Yes |
| EPS growth this year, next year, next 5 years | Analyst estimates | No | No in this plan |
| Forward P/E, PEG | Analyst estimates | No | No in this plan |
| ROA, ROE, current ratio, quick ratio, debt/equity, margins, payout ratio | SEC company facts | As of the filing | Yes |
| ROIC | SEC facts plus a chosen definition | As of the filing | Yes, if the formula is written next to the column |
| Insider ownership and transactions | Form 4 and the proxy | Delayed | Later |
| Institutional ownership and transactions | 13F filings | Quarterly | Later |
| Performance (week, month, quarter, year) | Cached IEX daily closes, with today's close replaced by the latest trade | The "today" part is live | Yes, on IEX prices |
| Volatility (average daily range) | Cached IEX daily bars | Once a day | Yes, IEX ranges |
| RSI(14) | `studies.rsi` on daily closes, today's close = latest trade | Moves with the IEX price | Yes |
| Gap | Today's IEX open versus the prior IEX close | The open is fixed once it exists | Yes, labeled IEX gap. Empty before IEX has an open. |
| Change, change from open | Latest trade versus prior close, and versus today's open | Yes | Yes, IEX |
| SMA 20 / 50 / 200 | `studies.sma` on cached closes. Compare the live price with the average. | The distance moves with price. The average updates daily. | Yes |
| 20-day, 50-day, 52-week high and low | Highs and lows in the cache, compared with the live price | The distance moves with price | Yes, IEX highs and lows |
| ATR(14) | New math next to `studies.rsi`. Not in the file today. | Once a day | Yes |
| Beta | Regression of IEX daily returns against SPY | Once a day | Yes. It will differ from a full-tape beta. |
| Chart patterns, candlesticks | Not in the app | No | Later. Easy to misread, so keep them out of the first version. |
| Signals: gainers, losers, new high, new low, most active, unusual volume, overbought, oversold | A sort or a cutoff on the columns above | Yes, IEX version | Yes |
| Signals: upgrades, downgrades, earnings before/after, insider buying, major news | Analyst, calendar, and news feeds | No | Later. The News page exists, and its code was not in git. |

### The page

Add a Screener link to the existing sidebar, pointing at `/screener`. Reuse `shell()` so the watchlist, the paper badge, and the account cards stay where they are. The page is read-only in the same way the chart is: the server file must not import `executor` or call the order endpoint.

Layout, top to bottom:

1. Header: "Screener", the feed name (`IEX`), the time of the last successful snapshot pass, and how many symbols were checked. If the broker mode is not paper, say that next to the badge.
2. Preset menu: built-in presets plus any the user saved. Buttons: Save, Rename, Delete.
3. Three filter groups, Descriptive, Fundamental, and Technical, collapsed like Finviz. The first version only enables the rows marked Yes in the table. The others can be listed as "not available yet" so the page does not pretend to have a P/E it cannot compute.
4. The table. Click a column to sort. The browser keeps the scroll position and updates cells in place. A cell can flash when its value changes. Each row has three actions: **Chart** (`/chart?symbol=XYZ`), **Watchlist** (the existing `POST /api/watchlist` add), and **Pin for gap scanner**.
5. A line under the table: "IEX volume is only the IEX exchange. IEX RVOL is not the Finviz number. No orders are sent from this page."

Starter presets, all on IEX, all editable:

| Preset | Rules | Sort |
| --- | --- | --- |
| Liquid movers | Price over $5, IEX average volume over a floor you pick, change over 3% | Change, high to low |
| IEX gappers | IEX gap over 4%, price over $2, last IEX trade during today's session | Gap, high to low |
| Above the averages | Price above SMA 50 and SMA 50 above SMA 200 | Change, high to low |
| Watchlist only | Symbols already in `news_watchlist` | Change, high to low |

Watchlist only is the right first preset to build. It proves the snapshot path on a handful of symbols before anyone scans thousands.

Saved presets live in `sdesk/screener_presets.json`: a name, the filter values, the sort column, and the direction. Cap the file at 50 entries so it stays a small config. That cap is ours. It happens to match Finviz's free preset cap. Deleting a preset does not touch `config.json` or the strategy files.

**Pin for gap scanner** appends `{symbol, time, preset name, gap, change, iex_rvol}` to `sdesk/screener_pins.json`. It does not call `gappers.py`, `executor.py`, or the order API. After `gappers.py` has been read, the toolkit page can show the pin list. Until then, the pin file is only a list for a person.

The browser polls `GET /api/screener` on its own timer while the market is open. Return the matching rows for the current sort, not the whole universe. Include `feed`, `as_of`, and the last trade time on every row. The existing 60-second shell refresh can keep updating the account cards.

### Suggested build order

Do this in the Trade Tracker folder, not in REA's `src/`. This pull request does not start it.

1. Watchlist-only table from IEX snapshots. Columns: symbol, price, trade time, change, IEX volume. No new files except the page.
2. Universe from `/v2/assets`: active, US equity, not OTC. Count it. Then set the batch size and the refresh interval inside the 200-call budget.
3. Nightly or pre-open cache of daily IEX bars. Columns: IEX average volume, IEX RVOL, gap, SMA 20/50/200, RSI. Reuse `studies.py`.
4. Presets, sort, Chart, and Watchlist buttons.
5. Overnight SEC `companyfacts.zip` for the valuation and financial columns, with filing dates.
6. Pin file. Only then, read `sdesk/gappers.py` and decide whether the toolkit should display pins. Still no orders.
7. If you subscribe to Algo Trader Plus, set the feed to `sip` and rename the volume columns. Confirm a snapshot works before deleting the IEX labels.

### What this plan refuses

- No order placement, cancel, or close, on paper or live.
- No import of `sdesk/executor.py` from the screener.
- No change to strategy config, `news_watchlist` (except the existing watchlist add button), or chart drawings.
- No scraping of Finviz.
- No labeling of IEX volume, IEX RVOL, or a 15-minute SIP feed as the consolidated real-time tape.

## 5. What was not verified

- The Trade Tracker process was not run. `app.py`, `broker.py`, and the `sdesk/` strategy and gapper files were not in the checkout, so their behavior is unknown beyond the names and the routes in `ui.py`.
- Alpaca was not called. The Apple volume figures are Alpaca's published example, not a measurement from this account. The 6,000-symbol budget sketch is arithmetic, not a timed run.
- Finviz was not used while logged in. Delay, preset, page-size, refresh, and export limits are from the public Elite and help pages.
- The exact list of filters that Finviz locks behind Elite was not published on the help page.
- Whether this paper account can open `delayed_sip` was not tested. The plan does not depend on it for the live table.
- `docs:check` in this repo validates REA's generated catalogs. It was not run. This file is not one of those catalogs, and it is not linked from the REA docs sidebar.

## Sources

Trade Tracker, as stored on `cursor/northmark-trading-terminal-6e49` at `194c6fc14`:

- `alpacadesk-charts/INSTALL.md`
- `alpacadesk-charts/ui.py`
- `alpacadesk-charts/chart.py`
- `alpacadesk-charts/studies.py`

Finviz, read October 24, 2026:

- [Screener help](https://finviz.com/help/screener)
- [Elite comparison, including the 1-minute delay answer and the export row](https://finviz.com/elite)
- [Free versus Elite](https://finviz.com/knowledge-base/getting-started/plans-pricing/finviz-free-vs-elite)

Alpaca, read October 24, 2026:

- [About Market Data API](https://docs.alpaca.markets/us/docs/about-market-data-api) (Basic versus Algo Trader Plus)
- [Market Data FAQ](https://docs.alpaca.markets/us/docs/market-data-faq) (IEX versus SIP, the Apple example, the 15-minute SIP rule)
- [Real-time stock stream](https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data) (`iex`, `sip`, `delayed_sip`)
- [WebSocket stream](https://docs.alpaca.markets/us/docs/streaming-market-data) (connection and symbol-limit errors)
- [Snapshot reference](https://docs.alpaca.markets/us/reference/stocksnapshots-1)
- [Alpaca staff reply on free IEX hours and delayed SIP, October 8, 2025](https://www.reddit.com/r/alpacamarkets/comments/1o13b4m/no_minute_bars_even_delayed/)

SEC:

- [Accessing EDGAR data](https://www.sec.gov/os/accessing-edgar-data) (User-Agent and the 10-request-per-second fair-access limit)
- [EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces) (`companyfacts` and the nightly `companyfacts.zip`)
- [Company tickers](https://www.sec.gov/files/company_tickers.json)
- One company: `https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json`
- All companies: `https://www.sec.gov/Archives/edgar/daily-index/xbrl/companyfacts.zip`
