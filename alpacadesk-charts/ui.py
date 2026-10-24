"""Shared 'AlpacaDesk' workspace shell (dark charcoal, rounded cards): sidebar with editable watchlist,
stat cards, PAPER badge, refresh toggle. Used by /chart and /news. Read-only: never places orders."""
import json
from pathlib import Path
from flask import Blueprint, jsonify, request
from broker import Alpaca

bp = Blueprint("ui", __name__)
CFG = Path(__file__).resolve().parent / "sdesk" / "config.json"

def watchlist():
    try: return json.loads(CFG.read_text()).get("news_watchlist", [])
    except Exception: return []

@bp.post("/api/watchlist")
def edit_watchlist():
    b = request.get_json(force=True); s = (b.get("symbol") or "").strip().upper()
    if not s or len(s) > 12 or not all(ch.isalnum() or ch in "/.-" for ch in s): return jsonify(ok=False, error="bad symbol"), 400
    c = json.loads(CFG.read_text()); wl = c.get("news_watchlist", [])
    if b.get("action") == "remove": wl = [x for x in wl if x != s]
    elif s not in wl: wl.append(s)
    c["news_watchlist"] = wl; CFG.write_text(json.dumps(c, indent=2)); return jsonify(ok=True, watchlist=wl)

@bp.get("/api/watchlist")
def get_watchlist(): return jsonify(ok=True, watchlist=watchlist())

@bp.get("/api/account")
def account():
    a = Alpaca()
    try: acct, ps = a.account(), a.positions()
    except Exception as e: return jsonify(ok=False, error=str(e)[:200]), 502
    eq, last = float(acct["equity"]), float(acct["last_equity"])
    return jsonify(ok=True, equity=eq, buying_power=float(acct["buying_power"]), day_pnl=eq - last,
                   unrealized=sum(float(p["unrealized_pl"]) for p in ps), mode=a.mode, positions=len(ps))

CSS = """*{box-sizing:border-box}body{margin:0;background:#1c1c1f;color:#e7e7ea;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;min-height:100vh}
a{color:#7ee2a8;text-decoration:none}#sb{width:230px;background:#141416;padding:22px 16px;display:flex;flex-direction:column;border-right:1px solid #26262a;position:sticky;top:0;height:100vh}
.brand{color:#7ee2a8;font-weight:800;font-size:20px;display:flex;gap:8px;align-items:center}.ws{font-size:11px;color:#9a9aa2;letter-spacing:.06em;margin:18px 0 10px;text-transform:uppercase}
.nav{display:block;padding:8px 10px;border-radius:10px;color:#e7e7ea;font-weight:600;margin-bottom:2px}.nav.on,.nav:hover{background:#26262b}
.wlh{display:flex;justify-content:space-between;font-size:11px;color:#9a9aa2;text-transform:uppercase;letter-spacing:.06em;margin:18px 0 6px;border-top:1px solid #2a2a2f;padding-top:16px}
.wl{display:flex;justify-content:space-between;align-items:center;padding:9px 10px;border-radius:10px;cursor:pointer;font-weight:700}.wl:hover,.wl.on{background:#232327}.wl.on span:first-child{color:#7ee2a8}
.x{background:none;border:1px solid #55555c;color:#aaa;border-radius:50%;width:20px;height:20px;line-height:16px;cursor:pointer;font-size:13px;padding:0}
.add{display:flex;gap:6px;margin-top:8px}.add input{flex:1;background:#2a2620;border:1px solid #3a352c;color:#e7e7ea;border-radius:8px;padding:7px 9px;width:100px}
.btn{background:#2c2c31;border:1px solid #3a3a40;color:#e7e7ea;border-radius:8px;padding:6px 11px;cursor:pointer;font-weight:600}.btn.on{background:#4a4a52}
.sbf{margin-top:auto;font-size:12px;color:#9a9aa2}.sbf .ok{color:#7ee2a8}main{flex:1;padding:24px 28px;min-width:0}
.top{display:flex;justify-content:space-between;align-items:flex-start}h1{margin:0;font-size:26px}.sub{color:#a9a9b0;font-size:13px;margin-top:4px}
.badge{background:#1f3a2b;color:#7ee2a8;border:1px solid #2f5a40;padding:6px 12px;border-radius:20px;font-weight:700;font-size:12px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:20px 0}.card{background:#26262a;border:1px solid #303035;border-radius:16px;padding:16px}
.stat .l{font-size:11px;color:#a9a9b0;letter-spacing:.06em;text-transform:uppercase}.stat .v{font-size:22px;font-weight:800;margin-top:10px}
.up{color:#7ee2a8}.dn{color:#ff7b7b}.grid{display:grid;grid-template-columns:1fr 300px;gap:16px}.seg{display:inline-flex;background:#3a3a40;border-radius:9px;padding:2px}
.seg button{background:none;border:0;color:#e7e7ea;padding:5px 12px;border-radius:7px;cursor:pointer;font-weight:600}.seg button.on{background:#e7e7ea;color:#1c1c1f}
.brief h4{margin:14px 0 6px}.brief p{margin:0;color:#d0d0d5;line-height:1.45}.muted{color:#9a9aa2;font-size:12px;line-height:1.45}"""

def shell(active, title, body, script, extra_head=""):
    return """<!doctype html><html><head><meta charset=utf-8><title>""" + title + """ · AlpacaDesk</title>""" + extra_head + "<style>" + CSS + """</style></head><body>
<aside id="sb"><div class="brand">📈 AlpacaDesk</div><div class="ws">Paper workspace</div>
<a class="nav """ + ("on" if active == "chart" else "") + """" href="/chart">▦ Charts</a><a class="nav """ + ("on" if active == "news" else "") + """" href="/news">📰 News</a>
<a class="nav """ + ("on" if active == "strategies" else "") + """" href="/strategies">🧩 Strategies</a><a class="nav """ + ("on" if active == "performance" else "") + """" href="/performance">📊 Performance</a><a class="nav """ + ("on" if active == "toolkit" else "") + """" href="/toolkit">🧰 Gapper Toolkit</a><a class="nav" href="/stocks">📈 Stock Desk</a><a class="nav" href="/bots">🤖 Bots</a><a class="nav" href="/">🏠 Trade Tracker</a>
<div class="wlh"><span>Watchlist</span><span>Local</span></div><div id="wl"></div>
<div class="add"><input id="addsym" placeholder="Add symbol"><button class="btn" onclick="wlEdit(document.getElementById('addsym').value,'add')">+</button></div>
<div class="sbf">US stocks &amp; ETFs<br>IEX market data<br><br><span id="conn">Paper · connecting…</span><br><span>Read-only · No orders</span></div></aside>
<main><div class="top"><div><h1>""" + title + """</h1><div class="sub" id="sub">Loading…</div></div>
<div style="display:flex;gap:10px;align-items:center"><span class="badge">PAPER · READ ONLY</span><label style="font-size:13px"><input type="checkbox" id="auto" checked> Refresh every minute</label><button class="btn" onclick="refreshAll()">⟳</button></div></div>
<div class="stats"><div class="card stat"><div class="l">Account equity</div><div class="v" id="s_eq">—</div></div><div class="card stat"><div class="l">Buying power</div><div class="v" id="s_bp">—</div></div>
<div class="card stat"><div class="l">Day P&amp;L</div><div class="v" id="s_day">—</div></div><div class="card stat"><div class="l">Unrealized P&amp;L</div><div class="v" id="s_upl">—</div></div></div>
""" + body + """</main><script>
const money=(x,s)=>(s&&x>=0?'+':x<0?'-':'')+'$'+Math.abs(x).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));let WL=[],CUR=null;
async function acct(){try{const r=await (await fetch('/api/account')).json();if(!r.ok)throw 0;
 document.getElementById('s_eq').textContent=money(r.equity);document.getElementById('s_bp').textContent=money(r.buying_power);
 const d=document.getElementById('s_day');d.textContent=money(r.day_pnl,1);d.className='v '+(r.day_pnl>=0?'up':'dn');
 const u=document.getElementById('s_upl');u.textContent=money(r.unrealized,1);u.className='v '+(r.unrealized>=0?'up':'dn');
 document.getElementById('conn').innerHTML='<span class="ok">● Paper connected</span>';
 document.getElementById('sub').textContent='Account updated '+new Date().toLocaleTimeString('en-US',{timeZone:'America/Chicago'})+' CT'}catch(e){document.getElementById('conn').textContent='● Connection error'}}
function wlRender(){document.getElementById('wl').innerHTML=WL.map(s=>`<div class="wl ${s==CUR?'on':''}" onclick="selectSym('${esc(s)}')"><span>${esc(s)}</span><span>› <button class="x" onclick="event.stopPropagation();wlEdit('${esc(s)}','remove')">−</button></span></div>`).join('')}
async function wlLoad(){WL=(await (await fetch('/api/watchlist')).json()).watchlist;wlRender()}
async function wlEdit(s,action){s=(s||'').trim().toUpperCase();if(!s)return;const r=await (await fetch('/api/watchlist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:s,action})})).json();if(r.ok){WL=r.watchlist;document.getElementById('addsym').value='';wlRender();if(window.onWatchlist)onWatchlist()}}
document.getElementById('addsym').addEventListener('keydown',e=>{if(e.key=='Enter')wlEdit(e.target.value,'add')});
function refreshAll(){acct();if(window.pageRefresh)pageRefresh()}setInterval(()=>{if(document.getElementById('auto').checked)refreshAll()},60000);
""" + script + """
wlLoad().then(()=>{acct();if(window.pageInit)pageInit()});</script></body></html>"""
