"""Strategy Builder page and JSON API.

Register the blueprint from app.py. The page matches Trade Tracker's dark
cards. It does not submit orders; paper trading is a separate switch handled
by builder_live.py inside the existing scheduler.
"""
from __future__ import annotations

import os
from datetime import datetime

from flask import Blueprint, jsonify, request

import builder
from builder import (
    EXAMPLES, ParseError, SYNTAX, app_root, compile_script, delete_strategy,
    list_strategies, load_strategy, normalize_bars, parse_script, parse_symbols,
    run_backtest, save_strategy, set_paper, spec_public,
)
from builder_data import FIXTURE_END, FIXTURE_START, load_bars
from builder_live import describe

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


def _present(result, bars_by_symbol):
    symbols, charts = _charts(result["trades"], bars_by_symbol)
    shown = result["trades"][:500]
    return {
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
    }


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


@bp.post("/api/builder/backtest")
def backtest():
    body = _body()
    try:
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
        raw, notes = load_bars(spec, symbols, body.get("start") or FIXTURE_START, body.get("end") or FIXTURE_END)
        mood = _mood_history() if spec.respect_mood else None
        result = run_backtest(spec, raw, initial_equity=equity, mood=mood)
        result["notes"] = notes + result["notes"]
        return jsonify(_present(result, raw))
    except ParseError as exc:
        return jsonify(ok=False, error=str(exc), line=exc.line), 400
    except ValueError as exc:
        return jsonify(ok=False, error=str(exc)), 400
    except Exception as exc:
        return jsonify(ok=False, error=str(exc)[:300]), 400


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
<script src="/static/lightweight-charts.standalone.production.js"></script>
<style>
:root{--bg:#0e1114;--s1:#161a1f;--s2:#1c2127;--line:#262c34;--text:#e8eaed;--muted:#9aa4ad;--acc:#34d399;--red:#f87171;--gold:#fcd34d}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1100px 500px at 90% -10%,rgba(52,211,153,.08),transparent 55%),var(--bg);color:var(--text);
 font:14px -apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,system-ui,sans-serif}
body.demo{display:flex;min-height:100vh}
#builder-nav{width:228px;flex:0 0 228px;background:linear-gradient(180deg,#0f1317,#0b0e11);border-right:1px solid var(--line);
 padding:22px 14px;display:flex;flex-direction:column;position:sticky;top:0;height:100vh}
#builder-nav .brand{font-weight:800;font-size:18px;letter-spacing:-.02em}
#builder-nav .brand:after{content:"PAPER";font-size:9px;font-weight:800;color:#0e1114;background:var(--acc);border-radius:5px;padding:2px 5px;margin-left:8px}
#builder-nav .ws{font-size:11px;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;margin:16px 0 8px}
#builder-nav a{display:block;padding:8px 10px;border-radius:9px;color:#c9cfd6;text-decoration:none;font-weight:650;margin-bottom:2px;border-left:3px solid transparent}
#builder-nav a.on{background:linear-gradient(90deg,rgba(52,211,153,.16),rgba(52,211,153,.04));color:#fff;border-left-color:var(--acc)}
#builder-nav .foot{margin-top:auto;color:var(--muted);font-size:12px;line-height:1.45}
main{flex:1;min-width:0;padding:22px 26px 48px}
h1{margin:0;font-size:26px;letter-spacing:-.03em}
.sub{color:var(--muted);margin-top:4px;max-width:78ch;line-height:1.45}
.row{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap}
.badge{background:rgba(52,211,153,.12);color:var(--acc);border:1px solid rgba(52,211,153,.35);border-radius:999px;padding:6px 12px;font-size:12px;font-weight:700}
.banner{background:#3a2e12;border:1px solid #6b5420;color:#fde68a;border-radius:12px;padding:10px 12px;margin:14px 0}
.layout{display:grid;grid-template-columns:minmax(320px,400px) minmax(0,1fr);gap:16px;margin-top:14px}
.card{background:linear-gradient(180deg,var(--s2),var(--s1));border:1px solid var(--line);border-radius:14px;padding:14px 14px 16px;
 box-shadow:0 1px 0 rgba(255,255,255,.03) inset,0 8px 24px rgba(0,0,0,.25)}
label{display:block;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:8px 0 4px}
input,select,textarea{width:100%;background:#12161a;border:1px solid #2b323b;color:var(--text);border-radius:8px;padding:7px 8px;font:inherit}
textarea{min-height:180px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;line-height:1.45;resize:vertical}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.checks{display:flex;align-items:center;gap:8px;margin-top:8px;color:var(--text);font-size:13px;text-transform:none;letter-spacing:0}
.checks input{width:auto}
.btns{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
button,.btn{background:#1c2127;border:1px solid #303740;color:var(--text);border-radius:9px;padding:7px 10px;font-weight:650;cursor:pointer}
button.primary{background:#14684a;border-color:#1f8a62;color:#fff}
button.warn{background:#3a2a12;border-color:#6b5420;color:var(--gold)}
button.danger{background:#3a1f1f;border-color:#6b2a2a;color:#ffb4b4}
button:disabled{opacity:.55;cursor:wait}
.examples{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
.examples button{font-size:12px}
.saved{display:flex;flex-direction:column;gap:6px;margin-top:8px}
.saved button{text-align:left}
.saved .on{border-color:var(--acc)}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.kpi{background:#12161a;border:1px solid var(--line);border-radius:12px;padding:8px 10px}
.kpi .l{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.kpi .v{font-size:18px;font-weight:750;margin-top:4px;font-variant-numeric:tabular-nums}
.up{color:var(--acc)}.dn{color:var(--red)}.muted{color:var(--muted)}
.charts{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}
.chartbox{background:#12161a;border:1px solid var(--line);border-radius:12px;padding:8px}
.chartbox h3{margin:0 0 6px;font-size:13px;font-weight:650}
.chart{height:230px}
table{width:100%;border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums;margin-top:8px}
th,td{padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.06);text-align:right;white-space:nowrap}
th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em;text-align:right}
td:first-child,th:first-child{text-align:left}
.err{color:#fecaca;background:#3a1f1f;border-radius:8px;padding:8px;margin-top:8px}
.note{color:var(--muted);font-size:12px;line-height:1.45;margin-top:8px}
details{margin-top:8px}
@media(max-width:980px){.layout,.charts,.kpis{grid-template-columns:1fr}#builder-nav{display:none}}
</style>
</head>
<body class="BODYCLASS">
<!--SIDE-->
<main>
  <div class="row">
    <div>
      <h1>Strategy Builder</h1>
      <div class="sub">Write a readable rule, backtest it on Alpaca bars, and — only if you turn it on — paper-trade it with its own <b>bld-</b> order prefix. Existing strategies are left alone. Energy and utilities stay excluded.</div>
    </div>
    <div class="badge">PAPER ONLY · NOT REAL MONEY</div>
  </div>
  <div id="banner" class="banner" hidden>Fixture bars are loaded so this preview can run with no Alpaca keys. Nothing here can send an order.</div>
  <div class="layout">
    <section class="card">
      <b>Rules</b>
      <div class="examples" id="examples"></div>
      <label>Saved</label>
      <div class="saved" id="saved">None yet</div>
      <label>Name</label><input id="name" value="ORB-style breakout"/>
      <label>Symbols</label><input id="symbols" value="SPY, QQQ" placeholder="SPY, QQQ, AAPL"/>
      <div class="grid2">
        <div><label>Timeframe</label><select id="timeframe"><option>5m</option><option>15m</option><option>1h</option><option>4h</option><option>daily</option></select></div>
        <div><label>Side</label><select id="side"><option value="both">long and short</option><option value="long">long only</option><option value="short">short only</option></select></div>
        <div><label>Session start CT</label><input id="session_start" placeholder="08:36"/></div>
        <div><label>Session end CT</label><input id="session_end" placeholder="10:00"/></div>
        <div><label>Flat by CT</label><input id="flat_by" placeholder="14:50"/></div>
        <div><label>Max trades / day</label><input id="max_trades" type="number" min="1" max="50" value="1"/></div>
        <div><label>Take profit %</label><input id="take_profit_pct" type="number" step="0.1" value="0.5"/></div>
        <div><label>Stop %</label><input id="stop_pct" type="number" step="0.1" value="2"/></div>
        <div><label>Size % of equity</label><input id="size_pct" type="number" step="1" value="10"/></div>
        <div><label>Price min</label><input id="price_min" type="number" step="0.01" placeholder="20"/></div>
        <div><label>First-5m RVOL min</label><input id="rvol5_min" type="number" step="0.1" placeholder="5"/></div>
        <div><label>Daily RVOL min</label><input id="rvol_min" type="number" step="0.1" placeholder=""/></div>
      </div>
      <label class="checks"><input id="respect_mood" type="checkbox"/> Respect Market Mood</label>
      <label>Long when</label><input id="long_when" placeholder="close crosses_above ema(20) and rvol5 > 5"/>
      <label>Short when</label><input id="short_when" placeholder="close crosses_below or_low"/>
      <label>Exit when (optional)</label><input id="exit_when" placeholder="rsi(14) crosses_above 50"/>
      <div class="btns">
        <button type="button" onclick="formToScript()">Update script</button>
        <button type="button" onclick="scriptToForm()">Read script</button>
      </div>
      <label>Script</label>
      <textarea id="script" spellcheck="false"></textarea>
      <div class="grid2" style="margin-top:8px">
        <div><label>From</label><input id="start" type="date"/></div>
        <div><label>To</label><input id="end" type="date"/></div>
      </div>
      <label>Starting equity</label><input id="equity" type="number" value="100000"/>
      <div class="btns">
        <button class="primary" id="run" type="button" onclick="runBacktest()">Backtest</button>
        <button type="button" onclick="saveStrategy()">Save</button>
        <button class="warn" id="paper" type="button" onclick="togglePaper()">Enable paper</button>
        <button class="danger" type="button" onclick="removeStrategy()">Delete</button>
      </div>
      <div id="msg"></div>
      <p class="note">The script is what gets saved. Filters in the form are also written into it. Paper trading stays off until you enable a saved strategy. Orders are Alpaca paper brackets, prefixed <span id="prefix">bld-…-</span>, with the take-profit and stop reset from the actual fill.</p>
    </section>
    <section>
      <div class="card">
        <b id="result-title">Backtest</b>
        <div class="kpis" id="kpis" style="margin-top:10px"></div>
        <div class="charts">
          <div class="chartbox"><h3>Equity</h3><div id="eq" class="chart"></div></div>
          <div class="chartbox"><h3 id="px-title">Price</h3><div id="px" class="chart"></div><div id="px-switch" class="examples"></div></div>
        </div>
        <div style="overflow:auto;max-height:280px"><table><thead><tr>
          <th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Reason</th><th>P&amp;L</th><th>P&amp;L %</th>
        </tr></thead><tbody id="trades"></tbody></table></div>
        <div id="notes" class="note"></div>
        <details><summary class="note">How the backtest fills</summary><div id="assume" class="note"></div></details>
      </div>
    </section>
  </div>
</main>
<script>
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $ = id => document.getElementById(id);
let CURRENT = null, LAST = null, EQ, PX, META = {};
function money(n, signed){
  if(n == null || Number.isNaN(+n)) return '—';
  const v = +n, sign = signed ? (v < 0 ? '-' : v > 0 ? '+' : '') : (v < 0 ? '-' : '');
  return sign + '$' + Math.abs(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
}
function fields(){
  const num = id => { const v = $(id).value.trim(); return v === '' ? null : v; };
  return {
    name: $('name').value, timeframe: $('timeframe').value, side: $('side').value,
    session_start: $('session_start').value, session_end: $('session_end').value,
    flat_by: $('flat_by').value, max_trades: $('max_trades').value,
    take_profit_pct: $('take_profit_pct').value, stop_pct: $('stop_pct').value, size_pct: $('size_pct').value,
    price_min: num('price_min'), rvol5_min: num('rvol5_min'), rvol_min: num('rvol_min'),
    respect_mood: $('respect_mood').checked, long_when: $('long_when').value,
    short_when: $('short_when').value, exit_when: $('exit_when').value, symbols: $('symbols').value
  };
}
function fillSpec(spec){
  $('name').value = spec.name || '';
  $('timeframe').value = spec.timeframe === '1d' ? 'daily' : (spec.timeframe || '5m');
  $('side').value = spec.side || 'both';
  $('session_start').value = spec.session_start || '';
  $('session_end').value = spec.session_end || '';
  $('flat_by').value = spec.flat_by || '';
  $('max_trades').value = spec.max_trades ?? 1;
  $('take_profit_pct').value = spec.take_profit_pct;
  $('stop_pct').value = spec.stop_pct;
  $('size_pct').value = spec.size_pct;
  $('price_min').value = spec.price_min ?? '';
  $('rvol5_min').value = spec.rvol5_min ?? '';
  $('rvol_min').value = spec.rvol_min ?? '';
  $('respect_mood').checked = !!spec.respect_mood;
  $('long_when').value = spec.long_when || '';
  $('short_when').value = spec.short_when || '';
  $('exit_when').value = spec.exit_when || '';
  if(spec.symbols && spec.symbols.length) $('symbols').value = spec.symbols.join(', ');
}
function say(text, bad){
  $('msg').innerHTML = text ? `<div class="${bad?'err':'note'}">${esc(text)}</div>` : '';
}
async function formToScript(){
  const r = await (await fetch('/api/builder/compile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(fields())})).json();
  if(!r.ok){ say(r.error || 'Could not build the script', true); return; }
  $('script').value = r.script; fillSpec(r.spec); say('Script updated from the form.');
}
async function scriptToForm(){
  const r = await (await fetch('/api/builder/parse',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({script:$('script').value})})).json();
  if(!r.ok){ say(r.error || 'Script did not parse', true); return; }
  fillSpec(r.spec); say('Form matches the script. Session blank means 08:30–15:00 CT on intraday charts.');
}
async function applyExample(ex){
  CURRENT = null; $('script').value = ex.script; $('paper').textContent = 'Enable paper';
  await scriptToForm();
}
async function refreshList(){
  const r = await (await fetch('/api/builder/strategies')).json();
  const box = $('saved');
  if(!r.strategies.length){ box.innerHTML = '<span class="muted">None saved yet</span>'; return; }
  box.innerHTML = r.strategies.map(s => `<button type="button" class="${s.id===CURRENT?'on':''}" onclick="openSaved('${esc(s.id)}')">${esc(s.name)} ${s.paper?'<span class="up">PAPER</span>':''}</button>`).join('');
}
async function openSaved(id){
  const r = await (await fetch('/api/builder/strategies/'+id)).json();
  if(!r.ok){ say(r.error, true); return; }
  CURRENT = id; $('script').value = r.strategy.script || '';
  if(r.strategy.symbols) $('symbols').value = r.strategy.symbols.join(', ');
  $('prefix').textContent = r.strategy.prefix || 'bld-…-';
  $('paper').textContent = r.strategy.paper ? 'Turn paper off' : 'Enable paper';
  scriptToForm(); refreshList();
}
async function saveStrategy(){
  const r = await (await fetch('/api/builder/strategies',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:CURRENT, script:$('script').value, symbols:$('symbols').value, paper:false})})).json();
  if(!r.ok){ say(r.error || 'Not saved', true); return; }
  CURRENT = r.strategy.id; $('prefix').textContent = r.strategy.prefix; say('Saved. Paper trading is still off.'); refreshList();
}
async function togglePaper(){
  if(!CURRENT){ say('Save the strategy first.', true); return; }
  const on = $('paper').textContent.indexOf('off') === -1;
  if(on && !confirm('Enable paper trading for this strategy? It will send Alpaca PAPER bracket orders only, with its own bld- prefix. Real money is not available. Other strategies are not changed.')) return;
  const r = await (await fetch('/api/builder/strategies/'+CURRENT+'/paper',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({paper:on})})).json();
  if(!r.ok){ say(r.error || 'Could not change paper trading', true); return; }
  $('paper').textContent = r.strategy.paper ? 'Turn paper off' : 'Enable paper';
  say(r.strategy.paper ? 'Paper trading is on for this strategy only.' : 'Paper trading is off. Open paper orders are left in place.');
  refreshList();
}
async function removeStrategy(){
  if(!CURRENT){ say('Nothing saved is selected.', true); return; }
  if(!confirm('Delete this saved strategy? Turn paper off first. Open paper orders are not cancelled by delete.')) return;
  const r = await (await fetch('/api/builder/strategies/'+CURRENT,{method:'DELETE'})).json();
  if(!r.ok){ say(r.error || 'Not deleted', true); return; }
  CURRENT = null; say('Deleted.'); refreshList();
}
function drawCharts(data, symbol){
  if(EQ){ EQ.remove(); EQ = null; }
  if(PX){ PX.remove(); PX = null; }
  const lib = window.LightweightCharts;
  if(!lib){ $('eq').innerHTML = '<div class="note">Chart library did not load.</div>'; return; }
  const opt = {autoSize:true, layout:{background:{type:'solid', color:'#12161a'}, textColor:'#9aa4ad'}, grid:{vertLines:{color:'#262c34'}, horzLines:{color:'#262c34'}},
    rightPriceScale:{borderColor:'#262c34'}, timeScale:{borderColor:'#262c34', timeVisible:true, secondsVisible:false},
    localization:{timeFormatter:t => new Date(t*1000).toLocaleString('en-US',{timeZone:'America/Chicago', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'})}};
  EQ = lib.createChart($('eq'), opt);
  EQ.addAreaSeries({lineColor:'#34d399', topColor:'rgba(52,211,153,.35)', bottomColor:'rgba(52,211,153,.02)', priceLineVisible:false}).setData(data.equity || []);
  EQ.timeScale().fitContent();
  const chart = data.charts[symbol];
  $('px-title').textContent = symbol ? symbol + ' with trade markers' : 'Price';
  if(!chart || !chart.bars.length){ $('px').innerHTML = '<div class="note">No bars for this symbol.</div>'; return; }
  PX = lib.createChart($('px'), opt);
  const candles = PX.addCandlestickSeries({upColor:'#34d399', downColor:'#f87171', borderVisible:false, wickUpColor:'#34d399', wickDownColor:'#f87171'});
  candles.setData(chart.bars);
  candles.setMarkers(chart.markers || []);
  PX.timeScale().fitContent();
}
function showResult(data){
  LAST = data;
  const s = data.stats || {};
  const pf = s.profit_factor == null ? (s.wins ? '∞' : '—') : s.profit_factor;
  const cells = [
    ['Trades', s.trades], ['Win rate', (s.win_rate ?? 0) + '%'],
    ['Total P&L', money(s.total_pnl, true)], ['Avg win', money(s.avg_win, true)],
    ['Avg loss', money(s.avg_loss, true)], ['Profit factor', pf],
    ['Max drawdown', money(s.max_drawdown) + ' · ' + (s.max_drawdown_pct ?? 0) + '%'],
    ['Ending equity', money(s.final_equity)]
  ];
  $('kpis').innerHTML = cells.map(([l,v]) => `<div class="kpi"><div class="l">${l}</div><div class="v ${typeof v==='string' && v[0]==='-'?'dn':typeof v==='string' && v[0]==='+'?'up':''}">${v}</div></div>`).join('');
  $('result-title').textContent = (data.spec && data.spec.name) ? data.spec.name : 'Backtest';
  const syms = data.chart_symbols || [];
  $('px-switch').innerHTML = syms.map(sym => `<button type="button" onclick="drawCharts(LAST,'${esc(sym)}')">${esc(sym)}</button>`).join('');
  $('trades').innerHTML = (data.trades || []).map(t => `<tr><td>${esc(t.symbol)}</td><td>${esc(t.side)}</td><td>${t.qty}</td><td>${(+t.entry).toFixed(2)}</td><td>${(+t.exit).toFixed(2)}</td><td>${esc(t.reason)}</td><td class="${t.pnl>=0?'up':'dn'}">${money(t.pnl, true)}</td><td class="${t.pnl>=0?'up':'dn'}">${t.pnl_pct}%</td></tr>`).join('') || '<tr><td class="muted" colspan="8">No trades</td></tr>';
  const skipped = (data.skipped || []).map(s => esc(s.symbol) + ' (' + esc(s.reason) + ')').join(', ');
  $('notes').innerHTML = (data.notes || []).map(esc).join('<br>') + (skipped ? '<br>Skipped: ' + skipped : '');
  $('assume').innerHTML = (data.assumptions || []).map(a => '· ' + esc(a)).join('<br>');
  drawCharts(data, syms[0]);
}
async function runBacktest(){
  $('run').disabled = true; say('Running…');
  try{
    const r = await (await fetch('/api/builder/backtest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      script:$('script').value, symbols:$('symbols').value, start:$('start').value, end:$('end').value, initial_equity:+$('equity').value || 100000
    })})).json();
    if(!r.ok){ say(r.error || 'Backtest failed', true); return; }
    say(''); showResult(r);
  } finally { $('run').disabled = false; }
}
async function init(){
  META = await (await fetch('/api/builder/meta')).json();
  if(META.fixtures) $('banner').hidden = false;
  $('start').value = META.fixture_start; $('end').value = META.fixture_end;
  const ex = await (await fetch('/api/builder/examples')).json();
  $('examples').innerHTML = ex.examples.map((e,i) => `<button type="button" title="${esc(e.blurb)}" onclick="applyExample(window._ex[${i}])">${esc(e.name)}</button>`).join('');
  window._ex = ex.examples;
  await refreshList();
  if(META.demo && ex.examples[0]){ await applyExample(ex.examples[0]); await runBacktest(); }
}
init();
</script>
</body>
</html>
"""
