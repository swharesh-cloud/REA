# AlpacaDesk charts

Apply this from the TradeTracker root (the directory that contains `app.py`):

```sh
patch -p1 < alpacadesk-charts/install.patch
```

`install.patch` was built against the attached snapshot. `patch -p1` from that root is the install. The other files here are the same resulting copies, for review.

## Files the patch changes

- `studies.py` — added. Indicator and backtest math. No broker import.
- `chart.py` — extended. Same `/chart` page, Alpaca bar fetch, and read-only position/order markers. Adds 15m and 1W, EMA, Bollinger, drawing tools, and a backtest panel.
- `ui.py` — nav label only: Overview becomes Charts.
- `tests/test_studies.py` — added. Offline math tests with mocked bars.
- `tests/test_chart_api.py` — added. Route tests. The Flask cases skip if Flask is not installed.

No new Python dependencies. The app already uses Flask, requests, and tzdata.

## Files the patch does not change

`app.py` (the chart blueprint is already registered), `broker.py`, `sdesk/gappers.py`, `sdesk/executor.py`, `sdesk/strategies.py`, `sdesk/strategies_web.py`, `sdesk/web.py`, `sdesk/common.py`, and `sdesk/config.json`.

Nothing in the patch places, cancels, or closes an order, and nothing points the app at live trading. Keys stay `ALPACA_PAPER_KEY_ID` and `ALPACA_PAPER_SECRET_KEY` from the environment.

## Local data

The sidebar watchlist is unchanged. It is still `news_watchlist` in `sdesk/config.json`.

Drawings are saved per symbol in `sdesk/chart_drawings.json`. That file is created on the first save. It is not in the patch and it is not the strategies config.

## Check

From the TradeTracker root, with no Alpaca call:

```sh
python -m unittest tests.test_studies tests.test_chart_api
```

Then start the app the usual way and open `http://127.0.0.1:8765/chart`.
