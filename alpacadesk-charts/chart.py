"""/chart — AlpacaDesk charts (Alpaca PAPER, read-only).

Candles, studies, drawings, and the backtest all stay on this page.
Bars still come from the Alpaca market-data API. Nothing here submits,
cancels, or closes an order, and nothing selects a live trading endpoint.
Uses TradingView Lightweight Charts (Apache-2.0), vendored in static/.
"""
import datetime as dt
import json
import math
from pathlib import Path

import requests
from flask import Blueprint, jsonify, request

import studies
from broker import Alpaca

bp = Blueprint("chart", __name__)
DATA = "https://data.alpaca.markets"
TFS = {"5m": ("5Min", 5), "15m": ("15Min", 15), "1H": ("1Hour", 60), "1D": ("1Day", 400), "1W": ("1Week", 1500)}
DAYS = {"5m": 5, "15m": 15, "1H": 60, "1D": 400, "1W": 1500}
DRAWINGS = Path(__file__).resolve().parent / "sdesk" / "chart_drawings.json"
MAX_DRAWINGS = 200


def _sym(s):
    return (s or "").strip().upper()


def _is_crypto(s):
    return "/" in s


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _load_bars(sym, tf):
    """Same Alpaca data request the chart already used. Market data only."""
    a = Alpaca()
    start = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=DAYS[tf])).strftime("%Y-%m-%dT%H:%M:%SZ")
    if _is_crypto(sym):
        url, params = f"{DATA}/v1beta3/crypto/us/bars", dict(symbols=sym, timeframe=TFS[tf][0], start=start, limit=10000)
    else:
        url, params = f"{DATA}/v2/stocks/bars", dict(
            symbols=sym, timeframe=TFS[tf][0], start=start, limit=10000, feed="iex", adjustment="split")
    out, token = [], None
    for _ in range(10):
        if token:
            params["page_token"] = token
        response = requests.get(url, headers=a.headers, params=params, timeout=20)
        response.raise_for_status()
        payload = response.json()
        out += (payload.get("bars") or {}).get(sym, [])
        token = payload.get("next_page_token")
        if not token:
            break
    rows = [dict(
        time=int(dt.datetime.fromisoformat(bar["t"].replace("Z", "+00:00")).timestamp()),
        open=bar["o"], high=bar["h"], low=bar["l"], close=bar["c"], volume=bar.get("v", 0),
    ) for bar in out]
    return rows[-5000:], ("crypto" if _is_crypto(sym) else "iex")


@bp.get("/api/chart/bars")
def bars():
    sym, tf = _sym(request.args.get("symbol")), request.args.get("tf", "1D")
    if not sym or tf not in TFS:
        return jsonify(ok=False, error="symbol and tf required"), 400
    try:
        rows, feed = _load_bars(sym, tf)
    except Exception as exc:
        return jsonify(ok=False, error=str(exc)[:200]), 502
    return jsonify(ok=True, symbol=sym, tf=tf, bars=rows, feed=feed, studies=studies.pack(rows, tf))


@bp.post("/api/chart/backtest")
def backtest():
    """Replay a long/flat rule on freshly loaded bars. Does not place an order."""
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify(ok=False, error="json object required"), 400
    sym, tf = _sym(body.get("symbol")), body.get("tf") or "1D"
    if not sym or tf not in TFS:
        return jsonify(ok=False, error="symbol and tf required"), 400
    try:
        rows, feed = _load_bars(sym, tf)
    except Exception as exc:
        return jsonify(ok=False, error=str(exc)[:200]), 502
    try:
        result = studies.run_backtest(rows, body)
    except (TypeError, ValueError) as exc:
        return jsonify(ok=False, error=str(exc)[:200]), 400
    result.update(ok=True, symbol=sym, tf=tf, feed=feed)
    return jsonify(result)


def _symbol_ok(sym):
    return bool(sym) and len(sym) <= 12 and all(ch.isalnum() or ch in "/.-" for ch in sym)


def _read_drawings():
    try:
        data = json.loads(DRAWINGS.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _write_drawings(data):
    DRAWINGS.parent.mkdir(parents=True, exist_ok=True)
    temporary = DRAWINGS.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(data, indent=2), encoding="utf-8")
    temporary.replace(DRAWINGS)


def _clean_drawing(item):
    if not isinstance(item, dict):
        return None
    if item.get("kind") == "hline":
        if not _finite(item.get("price")):
            return None
        return {"kind": "hline", "price": float(item["price"])}
    if item.get("kind") != "trend":
        return None

    def point(value):
        if not isinstance(value, dict) or not _finite(value.get("time")) or not _finite(value.get("price")):
            return None
        return {"time": int(round(value["time"])), "price": float(value["price"])}

    first, second = point(item.get("a")), point(item.get("b"))
    if first is None or second is None or first["time"] == second["time"]:
        return None
    if first["time"] > second["time"]:
        first, second = second, first
    return {"kind": "trend", "a": first, "b": second}


@bp.get("/api/chart/drawings")
def get_drawings():
    sym = _sym(request.args.get("symbol"))
    if not _symbol_ok(sym):
        return jsonify(ok=False, error="bad symbol"), 400
    stored = _read_drawings().get(sym, [])
    return jsonify(ok=True, symbol=sym, drawings=stored if isinstance(stored, list) else [])


@bp.post("/api/chart/drawings")
def save_drawings():
    """Replace one symbol's drawings in sdesk/chart_drawings.json. Does not touch strategy config."""
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify(ok=False, error="json object required"), 400
    sym = _sym(body.get("symbol"))
    if not _symbol_ok(sym):
        return jsonify(ok=False, error="bad symbol"), 400
    raw = body.get("drawings")
    if not isinstance(raw, list) or len(raw) > MAX_DRAWINGS:
        return jsonify(ok=False, error="drawings must be a list of at most %s" % MAX_DRAWINGS), 400
    cleaned = []
    for item in raw:
        drawing = _clean_drawing(item)
        if drawing is None:
            return jsonify(ok=False, error="invalid drawing"), 400
        cleaned.append(drawing)
    data = _read_drawings()
    if cleaned:
        data[sym] = cleaned
    else:
        data.pop(sym, None)
    _write_drawings(data)
    return jsonify(ok=True, symbol=sym, drawings=cleaned)


@bp.get("/api/chart/positions")
def positions():
    a = Alpaca()
    try:
        acct, ps = a.account(), a.positions()
    except Exception as e:
        return jsonify(ok=False, error=str(e)[:200]), 502
    eq, last = float(acct["equity"]), float(acct["last_equity"])
    return jsonify(ok=True, equity=eq, day_pnl=eq - last, day_pnl_pct=(eq - last) / last * 100 if last else 0, positions=[dict(
        symbol=p["symbol"], qty=float(p["qty"]), side=p["side"], avg_entry=float(p["avg_entry_price"]), last=float(p["current_price"]),
        upl=float(p["unrealized_pl"]), uplpc=float(p["unrealized_plpc"]) * 100) for p in ps])


@bp.get("/api/chart/orders")
def orders():
    sym = _sym(request.args.get("symbol")); a = Alpaca()
    try:
        os_ = a._req("GET", "/v2/orders", params={"status": "all", "limit": 500, "nested": "true", "symbols": sym, "direction": "desc"})
    except Exception as e:
        return jsonify(ok=False, error=str(e)[:200]), 502
    fills, lines = [], []
    def walk(o):
        if o.get("filled_at") and float(o.get("filled_qty") or 0) > 0:
            fills.append(dict(time=int(dt.datetime.fromisoformat(o["filled_at"][:19] + "+00:00").timestamp()), side=o["side"],
                              qty=float(o["filled_qty"]), price=float(o["filled_avg_price"])))
        if o["status"] in ("new", "accepted", "held", "partially_filled", "pending_new"):
            if o.get("stop_price"): lines.append(dict(kind="stop", price=float(o["stop_price"]), side=o["side"]))
            if o["type"] == "limit" and o.get("limit_price"): lines.append(dict(kind="target", price=float(o["limit_price"]), side=o["side"]))
        for l in o.get("legs") or []: walk(l)
    for o in os_: walk(o)
    norm = sym.replace("/", "")
    return jsonify(ok=True, fills=sorted(fills, key=lambda f: f["time"]), lines=lines,
                   symbol_match=[o["symbol"] for o in os_ if o["symbol"].replace("/", "") != norm][:0])


BODY = """<style>
#bt input{background:#1c1c1f;border:1px solid #3a3a40;color:#e7e7ea;border-radius:6px;padding:4px 6px;width:64px}
#tfs{flex-wrap:wrap}
</style>
<div class="grid"><div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
<div><span id="sym" style="font-size:20px;font-weight:800">—</span> <span id="px" style="font-size:20px;font-weight:800" class="up"></span></div>
<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><input id="q" placeholder="Search symbol" style="background:#1c1c1f;border:1px solid #3a3a40;color:#e7e7ea;border-radius:8px;padding:6px 9px;width:130px">
<span class="muted">Interval</span><div class="seg" id="tfs"><button type="button" data-tf="5m">5 min</button><button type="button" data-tf="15m">15 min</button><button type="button" data-tf="1H">1 hour</button><button type="button" data-tf="1D">1 day</button><button type="button" data-tf="1W">1 week</button></div></div></div>
<div style="display:flex;justify-content:space-between;gap:8px;margin:10px 0 4px;flex-wrap:wrap"><span>
<label><input type="checkbox" id="sma" checked> SMA 20/50/200</label>
<label><input type="checkbox" id="ema"> EMA 20</label>
<label><input type="checkbox" id="bb"> Bollinger 20,2</label>
<label><input type="checkbox" id="vwap" checked> <span id="vwaplab">VWAP</span></label>
</span><span class="muted" id="nb"></span></div>
<div class="muted" id="ohlc" style="margin-bottom:4px"></div><div id="c_main" style="height:380px"></div>
<div class="muted" style="margin:6px 0"><span style="color:#f5a623">● SMA 20</span> &nbsp;<span style="color:#5aa9ff">● SMA 50</span> &nbsp;<span style="color:#e15bff">● SMA 200</span> &nbsp;<span style="color:#2ec4b6">● EMA 20</span> &nbsp;<span style="color:#9aa0a6">● Bollinger</span> &nbsp;<span style="color:#ffd84d">● VWAP</span><br><span style="color:#7ee2a8">▲ buy</span> <span style="color:#ff7b7b">▼ sell</span> fills · dashed = open stop/target · blue = avg entry · white = drawings</div>
<div style="display:flex;gap:12px;align-items:center;margin:8px 0;flex-wrap:wrap"><span class="muted">Zoom</span><input type="range" id="zoom" min="10" max="100" value="100" style="flex:1;min-width:80px"><span class="muted">Earlier</span><input type="range" id="pan" min="0" max="100" value="0" style="flex:1;min-width:80px"><button class="btn" type="button" id="latest">Latest</button>
<span class="muted">Draw</span><div class="seg" id="tools"><button type="button" data-tool="pan" class="on">Pan</button><button type="button" data-tool="trend">Trend</button><button type="button" data-tool="level">Level</button><button type="button" data-tool="delete">Delete</button></div></div>
<div class="muted" id="toolhint">Scroll and zoom the chart. Drawings are saved for this symbol on this computer.</div>
<div class="muted">VOLUME</div><div id="c_vol" style="height:90px"></div><div class="muted" id="rsil">RSI (14)</div><div id="c_rsi" style="height:100px"></div>
<div class="muted" id="macdl">MACD (12,26,9) · blue MACD / orange signal</div><div id="c_macd" style="height:110px"></div></div>
<div><div class="card brief"><div style="color:#7ee2a8;font-weight:800">Technical brief</div><div class="muted" style="margin-top:8px">LOCAL RULE-BASED ANALYSIS · NOT GENERATIVE AI</div>
<div id="brief"></div><hr style="border-color:#3a3a40"><div class="muted">Indicators describe the loaded bars; they do not predict returns. Periods refer to the selected interval.<br><br>IEX covers one exchange. Volume and VWAP do not represent the consolidated market.<br><br>Day P&amp;L = equity − prior closing equity.</div></div>
<div class="card" style="margin-top:16px"><div style="font-weight:800;margin-bottom:8px">Open positions</div><div id="pos" class="muted">Loading…</div></div>
<div class="card" id="bt" style="margin-top:16px"><div style="font-weight:800">Backtest</div>
<div class="muted" style="margin:6px 0">Same Alpaca bars as the chart, up to 5000. Fees, slippage, and the equity curve are a simulation. No order is sent.</div>
<div class="seg" id="strat" style="margin-bottom:8px"><button type="button" data-s="sma" class="on">SMA cross</button><button type="button" data-s="rsi">RSI</button></div>
<div id="sma_opts" class="muted">Fast <input id="bt_fast" value="10"> Slow <input id="bt_slow" value="30"></div>
<div id="rsi_opts" class="muted" style="display:none">Period <input id="bt_period" value="14"> Below <input id="bt_os" value="30"> Above <input id="bt_ob" value="70"></div>
<div class="muted" style="margin-top:6px">Fee bps <input id="bt_fee" value="0"> Slip bps <input id="bt_slip" value="0"></div>
<div class="muted" style="margin-top:6px">Capital <input id="bt_cap" value="10000" style="width:90px"></div>
<button class="btn" type="button" id="bt_run" style="margin-top:8px">Run backtest</button>
<div id="bt_out" style="margin-top:8px"></div><div id="c_eq" style="height:120px;margin-top:8px"></div></div>
<div class="muted" style="margin-top:10px">Charts by <a href="https://www.tradingview.com/" target="_blank">TradingView</a> Lightweight Charts (Apache-2.0, static/lightweight-charts.LICENSE.txt)</div></div></div>"""

SCRIPT = r"""
let TF=new URLSearchParams(location.search).get('tf')||'1D';CUR=new URLSearchParams(location.search).get('symbol')||null;
let B=[],S={},POS=[],plines=[],DRAWS=[],TOOL='pan',pending=null,drawSym=null,drawSeries=[],drawLines=[];
const base={layout:{background:{color:'#26262a'},textColor:'#b9b9c0'},grid:{vertLines:{color:'#303035'},horzLines:{color:'#303035'}},rightPriceScale:{borderColor:'#3a3a40',minimumWidth:70},timeScale:{borderColor:'#3a3a40',timeVisible:true},crosshair:{mode:0}};
const mk=(id,o={})=>LightweightCharts.createChart(document.getElementById(id),Object.assign({autoSize:true},base,o));
const cm=mk('c_main'),cv=mk('c_vol',{timeScale:{visible:false}}),cr=mk('c_rsi',{timeScale:{visible:false}}),cx=mk('c_macd'),ce=mk('c_eq');
const cs=cm.addCandlestickSeries({upColor:'#7ee2a8',downColor:'#ff6b6b',borderVisible:false,wickUpColor:'#7ee2a8',wickDownColor:'#ff6b6b'});
const L=(c,col,w=2)=>c.addLineSeries({color:col,lineWidth:w,priceLineVisible:false,lastValueVisible:false});
const m20=L(cm,'#f5a623'),m50=L(cm,'#5aa9ff'),m200=L(cm,'#e15bff'),ema20=L(cm,'#2ec4b6'),vw=L(cm,'#ffd84d',1);
const bbU=L(cm,'#9aa0a6',1),bbL=L(cm,'#9aa0a6',1),bbM=L(cm,'#9aa0a6',1);bbM.applyOptions({lineStyle:2});
const vs=cv.addHistogramSeries({priceFormat:{type:'volume'},priceLineVisible:false});const rs=L(cr,'#e15bff');
[70,50,30].forEach(v=>rs.createPriceLine({price:v,color:'#55555c',lineStyle:2,lineWidth:1,axisLabelVisible:false}));
const mh=cx.addHistogramSeries({priceLineVisible:false}),ml=L(cx,'#5aa9ff'),msg=L(cx,'#f5a623');
const eq=ce.addLineSeries({color:'#7ee2a8',lineWidth:2,priceLineVisible:false,lastValueVisible:true});
const charts=[cm,cv,cr,cx];let syncing=false;charts.forEach(c=>c.timeScale().subscribeVisibleLogicalRangeChange(r=>{if(syncing||!r)return;syncing=true;charts.forEach(o=>o!==c&&o.timeScale().setVisibleLogicalRange(r));syncing=false}));
const f2=x=>x==null?'—':Number(x).toFixed(2);
const ser=v=>!v?[]:v.flatMap((x,i)=>x==null?[]:[{time:B[i].time,value:x}]);
function lastOf(v){if(!v)return null;for(let i=v.length-1;i>=0;i--)if(v[i]!=null)return v[i];return null}
function paintStudies(){
 if(!B.length)return;const on=id=>document.getElementById(id).checked;
 m20.setData(on('sma')?ser(S.sma20):[]);m50.setData(on('sma')?ser(S.sma50):[]);m200.setData(on('sma')?ser(S.sma200):[]);
 ema20.setData(on('ema')?ser(S.ema20):[]);bbU.setData(on('bb')?ser(S.bb_upper):[]);bbL.setData(on('bb')?ser(S.bb_lower):[]);bbM.setData(on('bb')?ser(S.bb_middle):[]);
 vw.setData(on('vwap')?ser(S.vwap):[]);rs.setData(ser(S.rsi));ml.setData(ser(S.macd));msg.setData(ser(S.macd_signal));
 const h=S.macd_histogram||[];mh.setData(h.flatMap((x,i)=>x==null?[]:[{time:B[i].time,value:x,color:x>=0?'#7ee2a8aa':'#ff6b6baa'}]));
 document.getElementById('rsil').textContent='RSI (14) · '+f2(lastOf(S.rsi));
 document.getElementById('vwaplab').textContent=S.vwap_label||'VWAP';
}
function clearSeries(){[cs,vs,m20,m50,m200,ema20,bbU,bbL,bbM,vw,rs,mh,ml,msg].forEach(x=>x.setData([]));plines.forEach(p=>cs.removePriceLine(p));plines=[]}
document.querySelectorAll('#tfs button').forEach(b=>b.onclick=()=>{TF=b.dataset.tf;load(true)});
['sma','ema','bb','vwap'].forEach(id=>document.getElementById(id).onchange=paintStudies);
document.getElementById('q').addEventListener('keydown',e=>{if(e.key=='Enter'&&e.target.value.trim()){selectSym(e.target.value.trim().toUpperCase());e.target.value=''}});
const zoom=document.getElementById('zoom'),pan=document.getElementById('pan');zoom.oninput=pan.oninput=applyRange;
document.getElementById('latest').onclick=()=>{pan.value=0;applyRange()};
function applyRange(){if(!B.length)return;const n=B.length,w=Math.max(10,Math.round(n*zoom.value/100)),off=Math.round((n-w)*pan.value/100);cm.timeScale().setVisibleLogicalRange({from:n-w-off-0.5,to:n-1-off+2})}
function selectSym(s){CUR=s;wlRender();load(true)}window.onWatchlist=()=>{};
function setTool(t){
 TOOL=t;pending=null;document.querySelectorAll('#tools button').forEach(b=>b.classList.toggle('on',b.dataset.tool===t));
 const allow=t==='pan';cm.applyOptions({handleScroll:allow,handleScale:allow});
 const hints={pan:'Scroll and zoom the chart.',trend:'Click the start, then the end.',level:'Click to place a horizontal level.',delete:'Click a line to remove it.'};
 document.getElementById('toolhint').textContent=hints[t]+' Saved for this symbol on this computer.';
}
document.querySelectorAll('#tools button').forEach(b=>b.onclick=()=>setTool(b.dataset.tool));
function asTime(t){if(typeof t==='number'&&isFinite(t))return Math.round(t);if(t&&typeof t==='object'&&t.year)return Math.floor(Date.UTC(t.year,t.month-1,t.day)/1000);return null}
function distToSeg(p,a,b){const abx=b.x-a.x,aby=b.y-a.y,den=abx*abx+aby*aby;const u=den?Math.max(0,Math.min(1,((p.x-a.x)*abx+(p.y-a.y)*aby)/den)):0;return Math.hypot(p.x-(a.x+abx*u),p.y-(a.y+aby*u))}
function nearestDraw(point){
 let best=-1,bd=14;DRAWS.forEach((d,i)=>{let dist=1e9;if(d.kind==='hline'){const y=cs.priceToCoordinate(d.price);if(y!=null)dist=Math.abs(point.y-y)}else{const a={x:cm.timeScale().timeToCoordinate(d.a.time),y:cs.priceToCoordinate(d.a.price)},b={x:cm.timeScale().timeToCoordinate(d.b.time),y:cs.priceToCoordinate(d.b.price)};if(a.x==null||b.x==null||a.y==null||b.y==null)return;dist=distToSeg(point,a,b)}if(dist<bd){bd=dist;best=i}});return best}
function paintDraws(){
 drawSeries.forEach(s=>{try{cm.removeSeries(s)}catch(e){}});drawSeries=[];
 drawLines.forEach(p=>{try{cs.removePriceLine(p)}catch(e){}});drawLines=[];
 DRAWS.forEach(d=>{
  if(d.kind==='hline')drawLines.push(cs.createPriceLine({price:d.price,color:'#e7e7ea',lineWidth:1,lineStyle:2,title:'LEVEL'}));
  else if(d.kind==='trend'){const a=d.a.time<=d.b.time?d.a:d.b,b=d.a.time<=d.b.time?d.b:d.a;const s=cm.addLineSeries({color:'#e7e7ea',lineWidth:2,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false});s.setData([{time:a.time,value:a.price},{time:b.time,value:b.price}]);drawSeries.push(s)}
 });
}
async function loadDraws(){
 if(!CUR)return;if(drawSym!==CUR){pending=null;drawSym=CUR}
 try{const r=await (await fetch('/api/chart/drawings?symbol='+encodeURIComponent(CUR))).json();DRAWS=(r.ok&&Array.isArray(r.drawings))?r.drawings:[]}catch(e){DRAWS=[]}
 paintDraws();
}
async function saveDraws(){
 if(!CUR)return;
 try{const r=await (await fetch('/api/chart/drawings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:CUR,drawings:DRAWS})})).json();if(!r.ok)document.getElementById('toolhint').textContent=r.error||'Could not save drawings'}
 catch(e){document.getElementById('toolhint').textContent='Could not save drawings'}
}
cm.subscribeClick(param=>{
 if(TOOL==='pan'||!param||!param.point||!B.length)return;
 const price=cs.coordinateToPrice(param.point.y);if(price==null||!isFinite(price))return;
 if(TOOL==='delete'){const i=nearestDraw(param.point);if(i<0)return;DRAWS.splice(i,1);paintDraws();saveDraws();return}
 if(TOOL==='level'){DRAWS.push({kind:'hline',price:price});if(DRAWS.length>200)DRAWS=DRAWS.slice(-200);paintDraws();saveDraws();return}
 if(TOOL!=='trend')return;
 const time=asTime(param.time!=null?param.time:cm.timeScale().coordinateToTime(param.point.x));if(time==null)return;
 if(!pending){pending={time:time,price:price};document.getElementById('toolhint').textContent='Click the end of the trend line.';return}
 if(pending.time===time)return;
 DRAWS.push({kind:'trend',a:pending,b:{time:time,price:price}});pending=null;if(DRAWS.length>200)DRAWS=DRAWS.slice(-200);paintDraws();saveDraws();
});
function brief(){
 const Lb=B[B.length-1],prev=B[Math.max(0,B.length-2)],ch=B.length>1?(Lb.close/prev.close-1)*100:0;
 const px=document.getElementById('px');px.textContent=f2(Lb.close);px.className=Lb.close>=prev.close?'up':'dn';
 document.getElementById('ohlc').textContent=`${TF=='1D'||TF=='1W'?new Date(Lb.time*1000).toLocaleDateString('en-US',{timeZone:'UTC'}):new Date(Lb.time*1000).toLocaleString('en-US',{timeZone:'America/Chicago'})+' CT'}  O ${f2(Lb.open)}  H ${f2(Lb.high)}  L ${f2(Lb.low)}  C ${f2(Lb.close)}  V ${Number(Lb.volume||0).toLocaleString()}`;
 const s50=lastOf(S.sma50),s200=lastOf(S.sma200),R=lastOf(S.rsi),mac=lastOf(S.macd),sig=lastOf(S.macd_signal);
 const hist=(S.macd_histogram||[]).filter(x=>x!=null),h=hist.length?hist[hist.length-1]:null,hp=hist.length>1?hist[hist.length-2]:null;
 let tr=s50==null?'Not enough bars for a 50-bar average.':`Price is ${Lb.close>=s50?'above':'below'} the 50-bar moving average (${f2(s50)}).`;
 if(s200!=null)tr+=` The 50-bar average is ${s50>=s200?'above':'below'} the 200-bar average (${f2(s200)}).`;
 const e20=lastOf(S.ema20);if(e20!=null)tr+=` EMA 20 is ${f2(e20)}.`;
 const mo=R==null?'Not enough bars.':`RSI(14) is ${f2(R)}. `+(R>70?'Above the conventional 70 (overbought) threshold.':R<30?'Below the conventional 30 (oversold) threshold.':'Between the conventional 30 and 70 thresholds.');
 const md=mac==null||sig==null?'Not enough bars for MACD.':`MACD is ${mac>=sig?'above':'below'} its signal line. Histogram: ${f2(h)}.`+(hp!=null&&Math.sign(h)!=Math.sign(hp)?' It just crossed on the latest bar.':'');
 const bb=lastOf(S.bb_middle),vwap=lastOf(S.vwap);
 document.getElementById('brief').innerHTML=`<h4>Trend</h4><p>${tr}</p><h4>Momentum</h4><p>${mo}</p><h4>MACD</h4><p>${md}</p><h4>Bands and VWAP</h4><p>Bollinger midline ${f2(bb)}. ${esc(S.vwap_label||'VWAP')} ${f2(vwap)}.</p><h4>Last bar</h4><p>${ch>=0?'+':''}${f2(ch)}% vs prior bar.</p>`;
}
async function load(fit){
 if(!CUR)return;document.querySelectorAll('#tfs button').forEach(b=>b.classList.toggle('on',b.dataset.tf==TF));
 history.replaceState(null,'',`/chart?symbol=${encodeURIComponent(CUR)}&tf=${TF}`);document.getElementById('sym').textContent=CUR;
 const r=await (await fetch(`/api/chart/bars?symbol=${encodeURIComponent(CUR)}&tf=${TF}`)).json();
 if(!r.ok||!r.bars.length){document.getElementById('nb').textContent=r.error||'No bars';B=[];S={};clearSeries();document.getElementById('brief').innerHTML='<p>No data.</p>';await loadDraws();return}
 B=r.bars;S=r.studies||{};document.getElementById('nb').textContent=B.length+' bars · '+r.feed;cs.setData(B);
 vs.setData(B.map(b=>({time:b.time,value:b.volume,color:b.close>=b.open?'#7ee2a8aa':'#ff6b6baa'})));paintStudies();brief();
 try{const o=await (await fetch(`/api/chart/orders?symbol=${encodeURIComponent(CUR)}`)).json();plines.forEach(p=>cs.removePriceLine(p));plines=[];
  if(o.ok){const snap=t=>{if(t<B[0].time)return null;let lo=0,hi=B.length-1;while(lo<hi){const m=(lo+hi+1)>>1;B[m].time<=t?lo=m:hi=m-1}return B[lo].time};
   cs.setMarkers(o.fills.map(x=>({t:snap(x.time),x})).filter(z=>z.t).map(({t,x})=>({time:t,position:x.side=='buy'?'belowBar':'aboveBar',color:x.side=='buy'?'#7ee2a8':'#ff6b6b',shape:x.side=='buy'?'arrowUp':'arrowDown',text:`${x.side=='buy'?'B':'S'} ${+x.qty.toFixed(4)} @ ${f2(x.price)}`})).sort((a,b)=>a.time-b.time));
   o.lines.forEach(l=>plines.push(cs.createPriceLine({price:l.price,color:l.kind=='stop'?'#ff6b6b':'#7ee2a8',lineWidth:1,lineStyle:2,title:l.kind.toUpperCase()})))}
  const p=POS.find(p=>p.symbol.replace('/','')==CUR.replace('/',''));if(p)plines.push(cs.createPriceLine({price:p.avg_entry,color:'#5aa9ff',lineWidth:1,title:'AVG'}));
 }catch(e){}
 await loadDraws();if(fit){zoom.value=(TF=='1D'||TF=='1W')?40:100;pan.value=0;applyRange()}
}
let STRAT='sma';
document.querySelectorAll('#strat button').forEach(b=>b.onclick=()=>{STRAT=b.dataset.s;document.querySelectorAll('#strat button').forEach(x=>x.classList.toggle('on',x===b));document.getElementById('sma_opts').style.display=STRAT==='sma'?'':'none';document.getElementById('rsi_opts').style.display=STRAT==='rsi'?'':'none'});
document.getElementById('bt_run').onclick=runBt;
async function runBt(){
 if(!CUR){document.getElementById('bt_out').textContent='Choose a symbol first.';return}
 document.getElementById('bt_out').textContent='Running…';
 const num=id=>Number(document.getElementById(id).value);
 const body={symbol:CUR,tf:TF,strategy:STRAT,fast:num('bt_fast'),slow:num('bt_slow'),period:num('bt_period'),oversold:num('bt_os'),overbought:num('bt_ob'),fee_bps:num('bt_fee'),slippage_bps:num('bt_slip'),initial_capital:num('bt_cap')};
 let r;try{r=await (await fetch('/api/chart/backtest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json()}catch(e){document.getElementById('bt_out').textContent='Backtest request failed.';return}
 if(!r.ok){document.getElementById('bt_out').textContent=r.error||'Backtest failed.';eq.setData([]);return}
 const pct=x=>x==null?'—':(x*100).toFixed(2)+'%';
 document.getElementById('bt_out').innerHTML=`<div>Return <b class="${r.return>=0?'up':'dn'}">${pct(r.return)}</b></div><div>Max drawdown ${pct(r.max_drawdown)}</div><div>Win rate ${r.win_rate==null?'—':pct(r.win_rate)} · ${r.trade_count} closed trades${r.open_position?' · position still open':''}</div><div>Final equity ${money(r.final_equity)} · ${r.bar_count} bars</div><div class="muted" style="margin-top:6px">${esc(r.assumptions||'')}</div>`;
 const pts=[];let lastT=-Infinity;for(const p of (r.equity||[])){if(!p||!isFinite(p.equity)||!isFinite(p.time)||p.time<=lastT)continue;lastT=p.time;pts.push({time:p.time,value:p.equity})}
 eq.setData(pts);if(pts.length)ce.timeScale().fitContent();
}
async function positions(){const r=await (await fetch('/api/chart/positions')).json();if(!r.ok)return;POS=r.positions;
 document.getElementById('pos').innerHTML=POS.map(p=>`<div class="wl" onclick="selectSym('${esc(p.symbol)}')"><span>${esc(p.symbol)}</span><span class="${p.upl>=0?'up':'dn'}">${money(p.upl,1)} (${p.uplpc.toFixed(2)}%)</span></div>`).join('')||'No open positions.';
 if(!CUR)CUR=WL[0]||(POS[0]||{}).symbol||'SPY';wlRender()}
setTool('pan');
window.pageInit=async()=>{await positions();load(true)};window.pageRefresh=async()=>{await positions();load(false)};
"""


@bp.get("/chart")
def page():
    from ui import shell
    return shell("chart", "Charts", BODY, SCRIPT, '<script src="/static/lightweight-charts.standalone.production.js"></script>')
