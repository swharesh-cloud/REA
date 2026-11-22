"""Strategy Builder page and JSON API.

Register the blueprint from app.py. The page matches Trade Tracker's dark
cards. It does not submit orders; paper trading is a separate switch handled
by builder_live.py inside the existing scheduler.
"""
from __future__ import annotations

import os
import threading
import uuid
from datetime import datetime
from pathlib import Path

from flask import Blueprint, jsonify, request, send_from_directory

import builder
from builder import (
    EXAMPLES, SYMBOL_CAP, SYM_RE, ParseError, SYNTAX, app_root, compile_script,
    delete_strategy, list_strategies, load_strategy, normalize_bars, parse_script,
    parse_symbols, run_backtest, save_strategy, set_paper, spec_public,
)
from builder_data import FIXTURE_END, FIXTURE_START, load_bars
from builder_live import describe

ASSETS = Path(__file__).resolve().parent / "static"
_JOBS = {}
_JOB_LOCK = threading.Lock()

bp = Blueprint("builder", __name__)


def _mood_history():
    path = app_root() / "data" / "mood_log.json"
    try:
        data = __import__("json").loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    out = {}
    if isinstance(data, dict):
        for day, row in data.items():
            if isinstance(row, dict) and row.get("call"):
                out[str(day)] = row["call"]
    return out or None


def _unix(value) -> int:
    if isinstance(value, datetime):
        return int(value.timestamp())
    text = str(value).replace("Z", "+00:00")
    return int(datetime.fromisoformat(text).timestamp())


def _equity_points(curve):
    points = []
    last = None
    for point in curve:
        stamp = _unix(point["time"])
        if last is not None and stamp <= last:
            stamp = last + 1
        last = stamp
        points.append({"time": stamp, "value": point["equity"]})
    return points


def _charts(trades, bars_by_symbol):
    counts = {}
    for trade in trades:
        counts[trade["symbol"]] = counts.get(trade["symbol"], 0) + 1
    chosen = sorted(counts, key=lambda sym: (-counts[sym], sym))[:6]
    if not chosen:
        chosen = sorted(bars_by_symbol)[:1]
    charts = {}
    for symbol in chosen:
        rows = normalize_bars(bars_by_symbol.get(symbol) or [])[-4000:]
        markers = []
        for trade in trades:
            if trade["symbol"] != symbol:
                continue
            entry_t, exit_t = _unix(trade["entry_time"]), _unix(trade["exit_time"])
            long = trade["side"] == "long"
            win = trade["pnl"] >= 0
            markers.append({
                "time": entry_t,
                "position": "belowBar" if long else "aboveBar",
                "color": "#34d399" if long else "#f87171",
                "shape": "arrowUp" if long else "arrowDown",
                "text": "L" if long else "S",
            })
            markers.append({
                "time": exit_t if exit_t != entry_t else exit_t + 60,
                "position": "aboveBar" if long else "belowBar",
                "color": "#34d399" if win else "#f87171",
                "shape": "circle",
                "text": trade["reason"],
            })
        markers.sort(key=lambda item: (item["time"], item["text"]))
        charts[symbol] = {
            "bars": [{
                "time": int(bar.time.timestamp()), "open": bar.open, "high": bar.high,
                "low": bar.low, "close": bar.close,
            } for bar in rows],
            "markers": markers,
        }
    return chosen, charts


def _by_symbol(trades):
    acc = {}
    for trade in trades:
        row = acc.setdefault(trade["symbol"], {"symbol": trade["symbol"], "trades": 0, "wins": 0, "pnl": 0.0})
        row["trades"] += 1
        row["pnl"] += trade["pnl"]
        if trade["pnl"] > 0:
            row["wins"] += 1
    out = []
    for row in acc.values():
        row["pnl"] = round(row["pnl"], 2)
        row["win_rate"] = round(100.0 * row["wins"] / row["trades"], 1) if row["trades"] else 0
        out.append(row)
    out.sort(key=lambda row: (-row["pnl"], row["symbol"]))
    return out


def _histogram(trades, buckets=8):
    if not trades:
        return []
    values = [float(trade["pnl"]) for trade in trades]
    lo, hi = min(values), max(values)
    if lo == hi:
        return [{"label": f"{lo:.0f}", "count": len(values), "side": "up" if lo >= 0 else "dn"}]
    width = (hi - lo) / buckets
    counts = [0] * buckets
    for value in values:
        slot = min(buckets - 1, int((value - lo) / width)) if width else 0
        counts[slot] += 1
    out = []
    for index, count in enumerate(counts):
        start = lo + index * width
        mid = start + width / 2
        out.append({
            "label": f"{start:.0f}",
            "count": count,
            "side": "up" if mid >= 0 else "dn",
        })
    return out


def _present(result, bars_by_symbol, compare=None):
    symbols, charts = _charts(result["trades"], bars_by_symbol)
    shown = result["trades"][:500]
    payload = {
        "ok": True,
        "stats": result["stats"],
        "trades": shown,
        "trades_truncated": len(result["trades"]) > len(shown),
        "equity": _equity_points(result["equity"]),
        "charts": charts,
        "chart_symbols": symbols,
        "notes": result["notes"],
        "skipped": result["skipped"],
        "assumptions": result["assumptions"],
        "spec": result["spec"],
        "by_symbol": _by_symbol(result["trades"]),
        "histogram": _histogram(result["trades"]),
    }
    if compare:
        payload["compare"] = compare
    return payload


def _body():
    return request.get_json(force=True, silent=True) or {}


def _demo():
    return os.environ.get("BUILDER_DEMO") == "1"


@bp.get("/builder")
def page():
    side = SIDEBAR if _demo() else ""
    html = PAGE.replace("<!--SIDE-->", side).replace("BODYCLASS", "demo" if side else "app")
    return html


@bp.get("/api/builder/meta")
def meta():
    return jsonify(
        demo=_demo(),
        fixtures=os.environ.get("BUILDER_FIXTURE_BARS") == "1",
        fixture_start=FIXTURE_START,
        fixture_end=FIXTURE_END,
        syntax=SYNTAX,
        cap=SYMBOL_CAP,
    )


@bp.get("/api/builder/examples")
def examples():
    return jsonify(ok=True, examples=[{k: ex[k] for k in ("id", "name", "blurb", "script")} for ex in EXAMPLES])


@bp.get("/api/builder/strategies")
def strategies():
    rows = []
    for row in list_strategies():
        rows.append({
            "id": row.get("id"), "name": row.get("name"), "paper": bool(row.get("paper")),
            "symbols": row.get("symbols") or [], "prefix": row.get("prefix"),
            "updated": row.get("updated"), "error": row.get("error"),
        })
    return jsonify(ok=True, strategies=rows)


@bp.get("/api/builder/strategies/<strategy_id>")
def strategy_one(strategy_id):
    try:
        row = load_strategy(strategy_id)
    except ValueError as exc:
        return jsonify(ok=False, error=str(exc)), 404
    row["live"] = describe(strategy_id)
    return jsonify(ok=True, strategy=row)


@bp.post("/api/builder/parse")
def parse():
    try:
        spec = parse_script((_body().get("script") or ""))
    except ParseError as exc:
        return jsonify(ok=False, error=str(exc), line=exc.line), 400
    return jsonify(ok=True, spec=spec_public(spec))


@bp.post("/api/builder/compile")
def compile_form():
    try:
        script = compile_script(_body())
        spec = parse_script(script)
    except ParseError as exc:
        return jsonify(ok=False, error=str(exc), line=exc.line), 400
    except ValueError as exc:
        return jsonify(ok=False, error=str(exc)), 400
    return jsonify(ok=True, script=script, spec=spec_public(spec))


@bp.post("/api/builder/strategies")
def save():
    body = _body()
    try:
        payload = {
            "id": body.get("id") or None,
            "script": body.get("script") or "",
            "symbols": body.get("symbols") or [],
        }
        # Saving edits must not flip the paper switch. The paper route is the only switch.
        if _demo():
            payload["paper"] = False
        row = save_strategy(payload)
    except ParseError as exc:
        return jsonify(ok=False, error=str(exc), line=exc.line), 400
    except ValueError as exc:
        return jsonify(ok=False, error=str(exc)), 400
    return jsonify(ok=True, strategy=row)


@bp.delete("/api/builder/strategies/<strategy_id>")
def remove(strategy_id):
    try:
        return jsonify(ok=True, **delete_strategy(strategy_id))
    except ValueError as exc:
        return jsonify(ok=False, error=str(exc)), 400


@bp.post("/api/builder/strategies/<strategy_id>/paper")
def paper(strategy_id):
    if _demo():
        return jsonify(ok=False, error="This preview cannot place orders"), 400
    try:
        row = set_paper(strategy_id, bool(_body().get("paper")))
    except ValueError as exc:
        return jsonify(ok=False, error=str(exc)), 400
    return jsonify(ok=True, strategy=row, live=describe(strategy_id))


def _watchlist():
    path = app_root() / "sdesk" / "config.json"
    try:
        data = __import__("json").loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    names = data.get("news_watchlist") if isinstance(data, dict) else None
    return [sym for sym in (names or []) if isinstance(sym, str) and SYM_RE.fullmatch(sym.upper())]


def universe_catalog():
    rows = [
        {"id": "indexes", "name": "Index ETFs", "symbols": ["SPY", "QQQ", "IWM", "DIA"], "live": False,
         "blurb": "SPY, QQQ, IWM, DIA"},
        {"id": "mag7", "name": "Mag 7", "symbols": ["AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA"],
         "live": False, "blurb": "The seven largest US names"},
    ]
    watched = _watchlist()
    if watched:
        rows.append({"id": "watchlist", "name": "Desk watchlist", "symbols": watched, "live": False,
                     "blurb": "news_watchlist from sdesk/config.json"})
    rows.append({"id": "orb", "name": "ORB live universe", "symbols": None, "live": True,
                 "blurb": "gapfade._universe — the same candidate list ORB scans. Needs Alpaca paper keys."})
    return rows


def execute_backtest(body, progress=None):
    """Shared by the sync route and the progress job. Does not place orders."""
    if body.get("id") and not body.get("script"):
        saved = load_strategy(body["id"])
        script = saved.get("script") or ""
        symbols = body.get("symbols") or saved.get("symbols") or []
    else:
        script = body.get("script") or ""
        symbols = body.get("symbols") or []
    spec = parse_script(script)
    if isinstance(symbols, str):
        symbols = parse_symbols(symbols)
    else:
        symbols = parse_symbols(" ".join(symbols or spec.symbols))
    equity = float(body.get("initial_equity") or 100_000)
    start = body.get("start") or FIXTURE_START
    end = body.get("end") or FIXTURE_END
    raw, notes = load_bars(spec, symbols, start, end, progress=progress)
    if progress:
        progress(1, 1, "Simulating trades")
    mood = _mood_history() if spec.respect_mood else None
    result = run_backtest(spec, raw, initial_equity=equity, mood=mood)
    result["notes"] = notes + result["notes"]
    compare = []
    for item in (body.get("compare") or [])[:3]:
        if not isinstance(item, dict):
            continue
        variant = parse_script(script)
        if item.get("take_profit_pct") not in (None, ""):
            variant.take_profit_pct = float(item["take_profit_pct"])
        if item.get("stop_pct") not in (None, ""):
            variant.stop_pct = float(item["stop_pct"])
        other = run_backtest(variant, raw, initial_equity=equity, mood=mood)
        compare.append({
            "label": str(item.get("label") or "Variant")[:40],
            "take_profit_pct": variant.take_profit_pct,
            "stop_pct": variant.stop_pct,
            "stats": other["stats"],
            "equity": _equity_points(other["equity"]),
        })
    return _present(result, raw, compare or None)


def _job_update(job, **fields):
    with _JOB_LOCK:
        row = _JOBS.get(job) or {}
        row.update(fields)
        _JOBS[job] = row


def _run_job(job, body):
    try:
        def progress(done, total, message):
            _job_update(job, status="running", done=done, total=max(total, 1), message=message)
        result = execute_backtest(body, progress)
        _job_update(job, status="done", done=1, total=1, message="Done", result=result)
    except ParseError as exc:
        _job_update(job, status="error", error=str(exc), line=exc.line)
    except Exception as exc:
        _job_update(job, status="error", error=str(exc)[:300])


@bp.get("/builder-static/<path:name>")
def builder_static(name):
    if name not in ("builder.css", "builder.js"):
        return ("Not found", 404)
    return send_from_directory(ASSETS, name)


@bp.get("/api/builder/universes")
def universes():
    return jsonify(ok=True, cap=SYMBOL_CAP, universes=universe_catalog())


@bp.post("/api/builder/universes/orb")
def orb_universe():
    """Read-only call to gapfade._universe. Does not place or cancel orders."""
    try:
        from broker import Alpaca
        from sdesk.gapfade import _universe
        names = _universe(Alpaca())
    except Exception as exc:
        return jsonify(ok=False, error="ORB universe needs this Trade Tracker install (sdesk.gapfade and Alpaca paper keys).",
                       detail=str(exc)[:180])
    symbols = []
    for name in names or []:
        sym = str(name).upper()
        if SYM_RE.fullmatch(sym) and sym not in symbols:
            symbols.append(sym)
    note = None
    if len(symbols) > SYMBOL_CAP:
        note = f"Capped at {SYMBOL_CAP} of {len(symbols)} names."
        symbols = symbols[:SYMBOL_CAP]
    return jsonify(ok=True, symbols=symbols, note=note)


@bp.post("/api/builder/backtest")
def backtest():
    try:
        return jsonify(execute_backtest(_body()))
    except ParseError as exc:
        return jsonify(ok=False, error=str(exc), line=exc.line), 400
    except ValueError as exc:
        return jsonify(ok=False, error=str(exc)), 400
    except Exception as exc:
        return jsonify(ok=False, error=str(exc)[:300]), 400


@bp.post("/api/builder/backtest/jobs")
def start_backtest_job():
    body = _body()
    job = uuid.uuid4().hex[:12]
    _job_update(job, status="running", done=0, total=1, message="Starting")
    threading.Thread(target=_run_job, args=(job, body), daemon=True, name=f"builder-bt-{job}").start()
    with _JOB_LOCK:
        if len(_JOBS) > 8:
            for key in list(_JOBS)[:-6]:
                _JOBS.pop(key, None)
    return jsonify(ok=True, job=job)


@bp.get("/api/builder/backtest/jobs/<job>")
def backtest_job(job):
    with _JOB_LOCK:
        row = _JOBS.get(job)
    if not row:
        return jsonify(ok=False, error="unknown backtest"), 404
    payload = {k: v for k, v in row.items() if k != "result"}
    payload["ok"] = row.get("status") != "error"
    if row.get("status") == "done":
        payload["result"] = row.get("result")
    return jsonify(payload)



SIDEBAR = """
<aside id="builder-nav">
  <div class="brand">AlpacaDesk</div>
  <div class="ws">Paper workspace</div>
  <a href="/chart">Charts</a>
  <a href="/news">News</a>
  <a href="/strategies">Strategies</a>
  <a class="on" href="/builder">Strategy Builder</a>
  <a href="/performance">Performance</a>
  <a href="/orb">ORB</a>
  <a href="/stocks">Stock Desk</a>
  <a href="/">Trade Tracker</a>
  <div class="foot">US stocks &amp; ETFs<br>Alpaca PAPER<br>Builder orders use their own bld- prefix</div>
</aside>
"""

PAGE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Strategy Builder</title>
<link rel="stylesheet" href="/builder-static/builder.css"/>
<script src="/static/lightweight-charts.standalone.production.js"></script>
</head>
<body class="BODYCLASS">
<!--SIDE-->
<div id="builder-app">
  <header class="bar">
    <input id="name" class="name" value="Strategy" aria-label="Strategy name"/>
    <span id="pill" class="pill draft">Draft</span>
    <span class="badge">PAPER ONLY · NOT REAL MONEY</span>
    <div class="actions">
      <button class="primary" id="run" type="button" onclick="runBacktest()">Backtest</button>
      <button type="button" onclick="saveStrategy()">Save</button>
      <button class="warn" id="paper" type="button" onclick="togglePaper()">Enable paper</button>
      <button class="danger" type="button" onclick="removeStrategy()">Delete</button>
    </div>
  </header>
  <div id="banner" class="banner" hidden>Fixture bars are loaded so this preview can run with no Alpaca keys. Nothing here can send an order.</div>
  <div id="progress" class="progress" hidden>
    <div class="track"><span id="progress-bar"></span></div>
    <div id="progress-msg" class="oknote"></div>
  </div>
  <div class="workspace">
    <aside class="rail">
      <h2>Examples</h2>
      <div id="examples"></div>
      <h2>Saved</h2>
      <div id="saved" class="saved">None saved yet</div>
      <label>Universe <span class="tip" title="ORB live universe calls gapfade._universe and does not change that strategy.">preset</span></label>
      <select id="universe" onchange="loadUniverse()"></select>
      <label>Symbols <span class="tip" title="Up to the cap shown below. Large lists download in batches and are cached.">list</span></label>
      <textarea id="symbols" rows="3">SPY, QQQ</textarea>
      <p class="oknote">Cap <span id="cap">200</span> symbols. Prefix <span id="prefix">bld-…-</span></p>
      <div class="grid2">
        <div><label>From</label><input id="start" type="date"/></div>
        <div><label>To</label><input id="end" type="date"/></div>
      </div>
      <label>Starting equity</label><input id="equity" type="number" value="100000"/>
    </aside>
    <div>
      <section class="card">
        <div class="tabs">
          <button type="button" class="on" data-tab="entry">Entry</button>
          <button type="button" data-tab="exit">Exit</button>
          <button type="button" data-tab="filters">Filters</button>
          <button type="button" data-tab="session">Session</button>
          <button type="button" data-tab="size">Sizing</button>
          <button type="button" data-tab="script">Script</button>
        </div>
        <div class="panel" data-panel="entry">
          <p class="help">A signal uses the bar close. The fill is the next bar's open. <span class="tip" title="and binds tighter than or. crosses_above(close, ema(20)) is the same as close crosses_above ema(20).">Syntax</span></p>
          <label>Side</label>
          <select id="side"><option value="both">long and short</option><option value="long">long only</option><option value="short">short only</option></select>
          <label>Long when</label><input id="long_when" placeholder="close crosses_above or_high and rvol5 > 5"/>
          <label>Short when</label><input id="short_when" placeholder="close crosses_below or_low"/>
        </div>
        <div class="panel" data-panel="exit" hidden>
          <p class="help">Take-profit and stop are percentages of the actual fill. Flat-by exits at the open of the first bar at or after that Chicago time.</p>
          <div class="grid2">
            <div><label>Take profit %</label><input id="take_profit_pct" type="number" step="0.1" value="0.5"/></div>
            <div><label>Stop %</label><input id="stop_pct" type="number" step="0.1" value="2"/></div>
            <div><label>Flat by CT</label><input id="flat_by" placeholder="14:50"/></div>
            <div><label>Exit when</label><input id="exit_when" placeholder="rsi(14) crosses_above 50"/></div>
          </div>
          <label>Compare a second exit</label>
          <div class="rowbtns">
            <select id="compare"></select>
            <button type="button" onclick="runBacktest()">Run comparison</button>
          </div>
        </div>
        <div class="panel" data-panel="filters" hidden>
          <p class="help">Energy and utilities are always excluded. Market Mood applies only when this box is checked, and only to this strategy.</p>
          <div class="grid2">
            <div><label>Price min</label><input id="price_min" type="number" step="0.01" placeholder="20"/></div>
            <div><label>First-5m RVOL min</label><input id="rvol5_min" type="number" step="0.1" placeholder="5"/></div>
            <div><label>Daily RVOL min</label><input id="rvol_min" type="number" step="0.1"/></div>
          </div>
          <label class="checks"><input id="respect_mood" type="checkbox"/> Respect Market Mood</label>
        </div>
        <div class="panel" data-panel="session" hidden>
          <p class="help">Intraday default session is 08:30–15:00 CT. Daily bars ignore the clock.</p>
          <div class="grid2">
            <div><label>Timeframe</label><select id="timeframe"><option>5m</option><option>15m</option><option>1h</option><option>4h</option><option>daily</option></select></div>
            <div><label>Max trades / day</label><input id="max_trades" type="number" min="1" max="50" value="1"/></div>
            <div><label>Session start CT</label><input id="session_start" placeholder="08:36"/></div>
            <div><label>Session end CT</label><input id="session_end" placeholder="10:00"/></div>
          </div>
        </div>
        <div class="panel" data-panel="size" hidden>
          <p class="help">Backtests size off current equity. Paper orders size off Alpaca buying power. Both use this percent.</p>
          <label>Size % of equity</label><input id="size_pct" type="number" step="1" value="10"/>
        </div>
        <div class="panel" data-panel="script" hidden>
          <p class="help">The script is what Backtest and Save use. Apply section copies the open tab into it.</p>
        </div>
        <div class="chips" id="chips"></div>
        <div class="editor">
          <pre id="hl" aria-hidden="true"></pre>
          <textarea id="script" spellcheck="false" aria-label="Strategy script"></textarea>
          <div id="ac" class="ac"></div>
        </div>
        <div id="valid" class="oknote"></div>
        <div class="rowbtns" style="margin-top:8px">
          <button type="button" onclick="formToScript()">Apply section to script</button>
          <button type="button" onclick="scriptToForm()">Read script into form</button>
        </div>
        <div id="msg"></div>
      </section>
      <section class="card" style="margin-top:12px">
        <h2 id="result-title" style="text-transform:none;letter-spacing:-.02em;font-size:16px;color:var(--text)">Results</h2>
        <div id="empty" class="empty"><b>Run a backtest</b>Pick an example or write a rule, then Backtest. The equity curve, price markers, and trade list show up here.</div>
        <div id="dash" hidden>
          <div class="kpis" id="kpis"></div>
          <div id="compare-out" class="compare" hidden></div>
          <div class="charts">
            <div class="chartbox"><h3>Equity</h3><div id="eq" class="chart"></div></div>
            <div class="chartbox"><h3 id="px-title">Price</h3><div id="px" class="chart"></div><div id="px-switch" class="chips"></div></div>
          </div>
          <div class="split">
            <div class="chartbox"><h3>P&amp;L distribution</h3><div id="hist" class="hist"></div></div>
            <div class="chartbox"><h3>By symbol</h3>
              <table><thead><tr><th>Symbol</th><th>Trades</th><th>Win %</th><th>P&amp;L</th></tr></thead><tbody id="bysym"></tbody></table>
            </div>
          </div>
          <div style="overflow:auto;max-height:280px;margin-top:10px">
            <table>
              <thead id="trades-head"><tr>
                <th data-key="symbol">Symbol</th><th data-key="side">Side</th><th data-key="qty">Qty</th>
                <th data-key="entry">Entry</th><th data-key="exit">Exit</th><th data-key="reason">Reason</th>
                <th data-key="pnl">P&amp;L</th><th data-key="pnl_pct">P&amp;L %</th>
              </tr></thead>
              <tbody id="trades"></tbody>
            </table>
          </div>
          <div id="notes" class="oknote"></div>
        </div>
      </section>
    </div>
  </div>
</div>
<script src="/builder-static/builder.js"></script>
</body>
</html>
"""
