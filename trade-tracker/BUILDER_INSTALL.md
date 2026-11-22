# Strategy Builder — install into Trade Tracker

This folder is the Strategy Builder for the local Trade Tracker app (`~/TradeTracker`, <http://127.0.0.1:8765>). It is not wired into REA. Copy the files below into the app and apply the small hook patch. Nothing here changes ORB, Gap Fade, 4H Swing, EMA Pullback, Momentum, Premarket Gappers, GFS, or CBC unless you opt in, and even then only by appending a scheduler cycle when a saved builder strategy has paper trading turned on.

Paper trading stays **off** until you enable one saved strategy. Orders go to Alpaca's paper API only, with their own `bld-<id>-` client-order prefix. Take-profit and stop are reset from the actual fill via `brackets.py`.

## 1. Copy the files

From a checkout of this repo, with Trade Tracker at `~/TradeTracker`:

```bash
SRC=/path/to/REA/trade-tracker
cd ~/TradeTracker
cp "$SRC/builder.py" "$SRC/builder_data.py" "$SRC/builder_live.py" \
   "$SRC/builder_web.py" "$SRC/builder_demo.py" .
mkdir -p tests
cp "$SRC"/tests/test_builder_*.py tests/
```

Do not copy `data/`, `.env`, account numbers, or trade history. Strategies you save later are JSON files under `~/TradeTracker/data/builder/`. The paper-trading log is `data/builder/_live.json`. Neither file is created until you save or run a paper strategy.

## 2. Apply the hooks

The patch edits only `app.py` (blueprint + sidebar link), `ui.py` (sidebar link on the AlpacaDesk shell), and `sdesk/run.py` (one extra cycle). It does not change any existing cycle, order prefix, or strategy function.

```bash
cd ~/TradeTracker
patch -p1 < "$SRC/hooks/tradetracker.patch"
```

If `patch` reports a reject because those files have drifted, add the same three edits by hand:

**`app.py`**, immediately after `app.register_blueprint(mood_bp)`:

```python
from builder_web import bp as builder_bp  # Strategy Builder. Paper orders only after a saved strategy is enabled.
app.register_blueprint(builder_bp)
```

In `_NAV`, add `("/builder", "🧩 Strategy Builder")` next to Strategies.

**`ui.py`**, in `shell()`, add a nav anchor next to Strategies:

```python
<a class="nav " ... href="/builder">🧩 Strategy Builder</a>
```

Use the same `"on" if active == "builder"` pattern as the other links. The exact line is in the patch.

**`sdesk/run.py`**:

```python
def _builder_cycle():
    """Strategy Builder paper pass. No-op unless a saved strategy has paper enabled."""
    from builder_live import cycle
    cycle()
```

Add `"builder": [("builder_paper", _builder_cycle)]` to `CYCLES`, and at the end of `due()` (after the existing `exits` line, before `return out`):

```python
try:
    from builder_live import wants_cycle
    if wants_cycle(t):
        out.append("builder")
except Exception:
    pass
```

`wants_cycle` is false on weekends, outside 08:30–15:00 CT, and whenever every saved strategy has `"paper": false` (the default). In that state `due()` returns the same cycle list as before.

Do not also start a second builder thread from `app.py`. One scheduler pass is enough. Do not set `BUILDER_FIXTURE_BARS` or `BUILDER_DEMO` in the environment that runs `app.py`; those are only for the preview server below.

Restart Trade Tracker and open <http://127.0.0.1:8765/builder>.

## 3. Requirements

Runtime packages are already in Trade Tracker's `requirements.txt`: Flask, requests, and tzdata (for `zoneinfo` on platforms that need it). No new package is required.

Tests:

```bash
cd ~/TradeTracker
python3 -m pip install pytest   # only for the tests
python3 -m pytest tests/test_builder_parser.py tests/test_builder_indicators.py \
  tests/test_builder_backtest.py tests/test_builder_live.py tests/test_builder_web.py -q
```

The tests use fixture bars and never call Alpaca. `ALPACA_PAPER_KEY_ID` / `ALPACA_PAPER_SECRET_KEY` are not read.

## 4. What the page does

- **Script or form.** The script is what gets saved. "Update script" writes the form into the rule language; "Read script" fills the form from it.
- **Backtest** loads Alpaca stock bars from `https://data.alpaca.markets/v2/stocks/bars` (SIP, then IEX), the same host the other backtests use. It does not send orders.
- **Save / delete** writes `data/builder/<id>.json`. Delete is refused while paper trading is on. Deleting does not cancel open orders; turn paper off first, and flatten from Alpaca if a bracket is still working.
- **Enable paper** is off by default. Turning it on lets the scheduler place Alpaca **paper** bracket orders for that strategy only. The Stock Desk kill switch and daily-loss halt are read, not changed: while either is set, the builder skips new entries. It never cancels an order whose client id does not start with its own prefix, and a flat-by exit sells only the share count that strategy opened.

Energy and utilities are rejected up front through `excluded.blocked` (a short built-in list is used only if that module cannot be imported). "Respect Market Mood" calls `mood.blocked(side, "builder", force=True)` for that strategy alone. It does not turn on the global mood enforce switch, and strategies that say `ignore mood` do not consult it.

## 5. Rule language

One statement per line. `#` starts a comment. Blank lines are ignored.

| Statement | Meaning |
| --- | --- |
| `name …` | Display name |
| `timeframe 5m` | `5m`, `15m`, `1h`, `4h`, or `daily` |
| `session 08:36-10:00` | Entry window in Chicago time. Intraday default is 08:30–15:00. Daily bars ignore the clock. |
| `flat by 14:50` | Exit at the open of the first bar that starts at or after this Chicago time |
| `side long` / `short` / `both` | Which entry rules may fire. Inferred from the rules you wrote when omitted. |
| `max trades 1` | Cap across the whole symbol list, per Chicago session |
| `price min 20` | Close must be at least this |
| `rvol5 min 5` | First-5-minute volume ÷ the average of that same 08:30–08:35 CT window over up to 14 prior days |
| `rvol min 1.2` | Today's volume so far ÷ the average full-session volume of up to 20 prior days |
| `size 10%` | Percent of current equity (backtest) or buying power (paper) per trade |
| `take profit 0.5%` / `stop 2%` | Distances from the **fill**, long or short. Defaults 0.5% and 2%. |
| `respect market mood` / `ignore mood` | Default is ignore |
| `symbols SPY QQQ` | Optional. The page's symbol box is what a backtest and paper run use. |
| `long when …` / `short when …` | Entry on that bar's close. Fill is the next bar's open. |
| `exit when …` | Optional signal exit, filled at the next open |

Series: `open` `high` `low` `close` `volume` `sma(n)` `ema(n)` `rsi(n)` `atr(n)` `vwap` `macd` `macd_signal` `macd_hist` `bb_upper` `bb_lower` `bb_mid` `rvol` `rvol5` `or_high` `or_low` `prior_high` `prior_low` (also `pdh` / `pdl`).

Comparisons: `>` `>=` `<` `<=` `==` `!=`, plus `crosses_above` and `crosses_below` (infix or `crosses_above(close, ema(20))`). Combine with `and`, `or`, `not`, and parentheses. `and` binds tighter than `or`. A missing value (not enough bars, no opening range yet) does not fire.

On 15-minute and slower charts, `or_high`, `or_low`, and `rvol5` are taken from 5-minute bars for the same dates. Until that window exists they stay unknown and the condition does not pass.

Backtest assumptions (also listed on the page): stop is filled before take-profit when one bar touches both; a gap through a level fills at the open; one position per symbol; shares are `floor(equity × size% / fill)`.

## 6. Three examples

These are the chips on the page (`builder.EXAMPLES`).

**ORB-style breakout**

```
name ORB-style breakout
timeframe 5m
session 08:36-10:00
flat by 14:50
side both
max trades 1
price min 20
rvol5 min 5
respect market mood
take profit 0.5%
stop 2%
long when close crosses_above or_high and rvol5 > 5 and close > 20
short when close crosses_below or_low and rvol5 > 5 and close > 20
```

**EMA pullback**

```
name EMA pullback
timeframe daily
side long
max trades 1
price min 5
respect market mood
take profit 1%
stop 2%
long when ema(20) > ema(50) and rsi(14) > 50 and low <= ema(20) * 1.01 and close >= ema(20) * 0.98 and close > ema(50)
```

**RSI mean reversion**

```
name RSI mean reversion
timeframe 15m
session 08:45-14:30
flat by 14:50
side both
max trades 3
price min 20
ignore mood
take profit 0.5%
stop 1.5%
long when rsi(14) crosses_below 30 and close > vwap
short when rsi(14) crosses_above 70 and close < vwap
```

A one-line rule also parses. Omitted knobs use the defaults above:

```
long when close crosses_above ema(20) and rvol5 > 5 and close > 20
```

## 7. Preview without keys

`builder_demo.py` serves the page on port 8766 with built-in bars and refuses the paper switch. Point it at Trade Tracker's chart bundle:

```bash
cd ~/TradeTracker
BUILDER_STATIC="$HOME/TradeTracker/static" python3 builder_demo.py
```

Open <http://127.0.0.1:8766/builder>. The banner on that preview means no Alpaca request was made. Quit it before starting `app.py` if you do not want port 8766 left open. The preview uses a temporary directory, not `~/TradeTracker/data`.
