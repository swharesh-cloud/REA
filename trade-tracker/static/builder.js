/* Strategy Builder page. No network except this app's own API. */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const $ = id => document.getElementById(id);
const SERIES = ["close","open","high","low","volume","ema","sma","rsi","atr","vwap","macd","macd_signal","macd_hist","bb_upper","bb_lower","bb_mid","rvol","rvol5","or_high","or_low","prior_high","prior_low","pdh","pdl","crosses_above","crosses_below"];
const WORDS = ["name","timeframe","session","flat","by","side","long","short","when","and","or","not","max","trades","price","min","respect","market","mood","ignore","take","profit","stop","size","exit","symbols","daily","only","both","tf","sl","tp"];
const EXITS = [
  {id:"written", label:"As written", tp:null, sl:null},
  {id:"scalp", label:"Scalp 0.35% / 0.5%", tp:0.35, sl:0.5},
  {id:"tight", label:"Tight 0.5% / 1%", tp:0.5, sl:1},
  {id:"standard", label:"Standard 0.5% / 2%", tp:0.5, sl:2},
  {id:"wide", label:"Wide 1% / 3%", tp:1, sl:3},
];
let CURRENT = null, PAPER = false, LAST = null, EQ, PX, SORT = {key:"pnl", dir:-1}, VALIDATE;
const money = (n, signed) => {
  if (n == null || Number.isNaN(+n)) return "—";
  const v = +n;
  const sign = v < 0 ? "-" : (signed && v > 0 ? "+" : "");
  return sign + "$" + Math.abs(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
};
const cls = n => n > 0 ? "up" : n < 0 ? "dn" : "";

function fields(){
  const num = id => { const v = $(id).value.trim(); return v === "" ? null : v; };
  return {
    name:$("name").value, timeframe:$("timeframe").value, side:$("side").value,
    session_start:$("session_start").value, session_end:$("session_end").value,
    flat_by:$("flat_by").value, max_trades:$("max_trades").value,
    take_profit_pct:$("take_profit_pct").value, stop_pct:$("stop_pct").value, size_pct:$("size_pct").value,
    price_min:num("price_min"), rvol5_min:num("rvol5_min"), rvol_min:num("rvol_min"),
    respect_mood:$("respect_mood").checked, long_when:$("long_when").value,
    short_when:$("short_when").value, exit_when:$("exit_when").value, symbols:$("symbols").value
  };
}
function fillSpec(spec){
  $("name").value = spec.name || "";
  $("timeframe").value = spec.timeframe === "1d" ? "daily" : (spec.timeframe || "5m");
  $("side").value = spec.side || "both";
  $("session_start").value = spec.session_start || "";
  $("session_end").value = spec.session_end || "";
  $("flat_by").value = spec.flat_by || "";
  $("max_trades").value = spec.max_trades ?? 1;
  $("take_profit_pct").value = spec.take_profit_pct;
  $("stop_pct").value = spec.stop_pct;
  $("size_pct").value = spec.size_pct;
  $("price_min").value = spec.price_min ?? "";
  $("rvol5_min").value = spec.rvol5_min ?? "";
  $("rvol_min").value = spec.rvol_min ?? "";
  $("respect_mood").checked = !!spec.respect_mood;
  $("long_when").value = spec.long_when || "";
  $("short_when").value = spec.short_when || "";
  $("exit_when").value = spec.exit_when || "";
  if (spec.symbols && spec.symbols.length) $("symbols").value = spec.symbols.join(", ");
  paint();
}
function setPill(){
  const el = $("pill");
  if (!CURRENT){ el.textContent = "Draft"; el.className = "pill draft"; }
  else if (PAPER){ el.textContent = "Paper ON"; el.className = "pill on"; }
  else { el.textContent = "Saved"; el.className = "pill saved"; }
  $("paper").textContent = PAPER ? "Turn paper off" : "Enable paper";
}
function say(text, bad){
  $("msg").innerHTML = text ? `<div class="${bad?"err":"oknote"}">${esc(text)}</div>` : "";
}
function paint(){
  const src = $("script").value;
  $("hl").innerHTML = highlight(src) + "\n";
  suggest();
}
function highlight(src){
  let i = 0, out = "";
  while (i < src.length){
    const ch = src[i];
    if (ch === "#"){
      let j = src.indexOf("\n", i); if (j < 0) j = src.length;
      out += `<span class="c">${esc(src.slice(i, j))}</span>`;
      i = j; continue;
    }
    if (/\d/.test(ch) || (ch === "." && /\d/.test(src[i+1] || ""))){
      let j = i + 1; while (j < src.length && /[\d.%]/.test(src[j])) j++;
      out += `<span class="n">${esc(src.slice(i, j))}</span>`;
      i = j; continue;
    }
    if (/[A-Za-z_]/.test(ch)){
      let j = i + 1; while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j), low = word.toLowerCase();
      const kind = SERIES.includes(low) ? "s" : WORDS.includes(low) ? "k" : "";
      out += kind ? `<span class="${kind}">${esc(word)}</span>` : esc(word);
      i = j; continue;
    }
    out += esc(ch); i++;
  }
  return out;
}
function wordAtCursor(){
  const el = $("script"), pos = el.selectionStart || 0, src = el.value;
  let i = pos;
  while (i > 0 && /[A-Za-z0-9_]/.test(src[i-1])) i--;
  return src.slice(i, pos).toLowerCase();
}
function suggest(){
  const prefix = wordAtCursor();
  const box = $("ac");
  if (!prefix || prefix.length < 1){ box.innerHTML = ""; return; }
  const hits = SERIES.filter(name => name.startsWith(prefix) && name !== prefix).slice(0, 6);
  box.innerHTML = hits.map(name => `<button type="button" onclick="insertChip('${name}')">${name}</button>`).join("");
}
function insertChip(token){
  const el = $("script");
  const pos = el.selectionStart || el.value.length;
  let i = pos;
  while (i > 0 && /[A-Za-z0-9_]/.test(el.value[i-1])) i--;
  const needsParen = ["ema","sma","rsi","atr"].includes(token);
  const text = token.includes("(") ? token : (needsParen ? token + "(" : token);
  el.value = el.value.slice(0, i) + text + el.value.slice(pos);
  const caret = i + text.length;
  el.focus(); el.setSelectionRange(caret, caret);
  paint(); scheduleValidate();
}
function scheduleValidate(){
  clearTimeout(VALIDATE);
  VALIDATE = setTimeout(validate, 280);
}
async function validate(){
  const r = await post("/api/builder/parse", {script:$("script").value});
  const line = $("valid");
  if (!r.ok){ line.className = "err"; line.textContent = r.error || "Script did not parse"; return; }
  line.className = "oknote";
  line.textContent = "Script is valid · " + (r.spec.side || "long") + " · " + (r.spec.timeframe === "1d" ? "daily" : r.spec.timeframe);
}
async function post(url, body){
  const r = await fetch(url, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body || {})});
  return r.json();
}
async function formToScript(){
  const r = await post("/api/builder/compile", fields());
  if (!r.ok){ say(r.error || "Could not build the script", true); return; }
  $("script").value = r.script; fillSpec(r.spec); say("Script updated from this section."); scheduleValidate();
}
async function scriptToForm(){
  const r = await post("/api/builder/parse", {script:$("script").value});
  if (!r.ok){ say(r.error || "Script did not parse", true); return; }
  fillSpec(r.spec); say("Form matches the script.");
}
function showTab(name){
  document.querySelectorAll("#builder-app .tabs button").forEach(btn => btn.classList.toggle("on", btn.dataset.tab === name));
  document.querySelectorAll("#builder-app .panel").forEach(panel => panel.hidden = panel.dataset.panel !== name);
}
async function applyExample(ex){
  CURRENT = null; PAPER = false; $("script").value = ex.script; setPill();
  await scriptToForm();
}
async function refreshList(){
  const r = await (await fetch("/api/builder/strategies")).json();
  const box = $("saved");
  if (!r.strategies.length){ box.innerHTML = '<div class="empty">No saved strategies yet.</div>'; return; }
  box.innerHTML = r.strategies.map(s => `<button type="button" class="${s.id===CURRENT?"on":""}" onclick="openSaved('${esc(s.id)}')">${esc(s.name)} ${s.paper?'<span class="up">PAPER</span>':''}</button>`).join("");
}
async function openSaved(id){
  const r = await (await fetch("/api/builder/strategies/"+id)).json();
  if (!r.ok){ say(r.error, true); return; }
  CURRENT = id; PAPER = !!r.strategy.paper;
  $("script").value = r.strategy.script || "";
  if (r.strategy.symbols) $("symbols").value = r.strategy.symbols.join(", ");
  $("prefix").textContent = r.strategy.prefix || "bld-…-";
  setPill(); await scriptToForm(); refreshList();
}
async function saveStrategy(){
  const r = await post("/api/builder/strategies", {id:CURRENT, script:$("script").value, symbols:$("symbols").value});
  if (!r.ok){ say(r.error || "Not saved", true); return; }
  CURRENT = r.strategy.id; $("prefix").textContent = r.strategy.prefix;
  say("Saved. Paper trading is still off until you enable it."); setPill(); refreshList();
}
async function togglePaper(){
  if (!CURRENT){ say("Save the strategy first.", true); return; }
  const turningOn = !PAPER;
  if (turningOn && !confirm("Enable paper trading for this strategy only? It sends Alpaca PAPER bracket orders with its own bld- prefix. Real money stays off. Other strategies are not changed.")) return;
  const r = await post("/api/builder/strategies/"+CURRENT+"/paper", {paper:turningOn});
  if (!r.ok){ say(r.error || "Could not change paper trading", true); return; }
  PAPER = !!r.strategy.paper; setPill();
  say(PAPER ? "Paper trading is on for this strategy only." : "Paper trading is off. Open paper orders are left in place.");
  refreshList();
}
async function removeStrategy(){
  if (!CURRENT){ say("Nothing saved is selected.", true); return; }
  if (!confirm("Delete this saved strategy? Turn paper off first. Delete does not cancel open orders.")) return;
  const r = await (await fetch("/api/builder/strategies/"+CURRENT, {method:"DELETE"})).json();
  if (!r.ok){ say(r.error || "Not deleted", true); return; }
  CURRENT = null; PAPER = false; setPill(); say("Deleted."); refreshList();
}
function setBusy(on, message, pct){
  $("run").disabled = on;
  $("progress").hidden = !on;
  $("progress-msg").textContent = message || "";
  $("progress-bar").style.width = Math.max(4, Math.min(100, pct || 0)) + "%";
}
function payload(extra){
  return Object.assign({
    script:$("script").value, symbols:$("symbols").value, start:$("start").value, end:$("end").value,
    initial_equity:+$("equity").value || 100000
  }, extra || {});
}
async function runBacktest(){
  say(""); setBusy(true, "Starting…", 8);
  try {
    const compareId = $("compare").value;
    const extra = {};
    const preset = EXITS.find(item => item.id === compareId);
    if (preset && preset.tp != null) extra.compare = [{label:preset.label, take_profit_pct:preset.tp, stop_pct:preset.sl}];
    const start = await post("/api/builder/backtest/jobs", payload(extra));
    if (!start.ok || !start.job){ say(start.error || "Backtest failed", true); return; }
    for (let n = 0; n < 600; n++){
      const job = await (await fetch("/api/builder/backtest/jobs/"+start.job)).json();
      const pct = job.total ? (100 * (job.done || 0) / job.total) : 12;
      setBusy(true, job.message || "Working…", job.status === "done" ? 100 : pct);
      if (job.status === "done"){ showResult(job.result); say(""); return; }
      if (job.status === "error"){ say(job.error || "Backtest failed", true); return; }
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    say("Backtest is still running. Try a shorter date range.", true);
  } finally { setBusy(false); }
}
function drawCharts(data, symbol){
  if (EQ){ EQ.remove(); EQ = null; }
  if (PX){ PX.remove(); PX = null; }
  const lib = window.LightweightCharts;
  const opt = {autoSize:true, layout:{background:{type:"solid", color:"#12161a"}, textColor:"#9aa4ad"},
    grid:{vertLines:{color:"#262c34"}, horzLines:{color:"#262c34"}}, rightPriceScale:{borderColor:"#262c34"},
    timeScale:{borderColor:"#262c34", timeVisible:true, secondsVisible:false},
    localization:{timeFormatter:t => new Date(t*1000).toLocaleString("en-US",{timeZone:"America/Chicago", month:"short", day:"numeric", hour:"2-digit", minute:"2-digit"})}};
  if (!lib){ $("eq").innerHTML = '<div class="empty">Chart library did not load from /static.</div>'; return; }
  EQ = lib.createChart($("eq"), opt);
  EQ.addAreaSeries({lineColor:"#34d399", topColor:"rgba(52,211,153,.35)", bottomColor:"rgba(52,211,153,.02)", priceLineVisible:false, title:"Strategy"}).setData(data.equity || []);
  const alt = (data.compare || [])[0];
  if (alt && alt.equity){
    EQ.addAreaSeries({lineColor:"#fcd34d", topColor:"rgba(252,211,77,.25)", bottomColor:"rgba(252,211,77,.02)", priceLineVisible:false, title:alt.label}).setData(alt.equity);
  }
  EQ.timeScale().fitContent();
  const chart = (data.charts || {})[symbol];
  $("px-title").textContent = symbol ? symbol + " entries and exits" : "Price";
  if (!chart || !chart.bars.length){ $("px").innerHTML = '<div class="empty">No bars for this symbol.</div>'; return; }
  PX = lib.createChart($("px"), opt);
  const candles = PX.addCandlestickSeries({upColor:"#34d399", downColor:"#f87171", borderVisible:false, wickUpColor:"#34d399", wickDownColor:"#f87171"});
  candles.setData(chart.bars);
  candles.setMarkers(chart.markers || []);
  PX.timeScale().fitContent();
}
function kpi(label, value, kind){
  return `<div class="kpi"><div class="l">${label}</div><div class="v ${kind||""}">${value}</div></div>`;
}
function showCompare(data){
  const box = $("compare-out");
  const alt = (data.compare || [])[0];
  if (!alt){ box.hidden = true; box.innerHTML = ""; return; }
  const a = data.stats, b = alt.stats;
  box.hidden = false;
  box.innerHTML = `<div class="cmp"><h3>Script exits</h3>
      <div>P&L <b class="${cls(a.total_pnl)}">${money(a.total_pnl, true)}</b> · win ${a.win_rate}% · PF ${a.profit_factor ?? "—"} · DD ${money(a.max_drawdown)}</div></div>
    <div class="cmp"><h3>${esc(alt.label)} <span class="oknote">TP ${alt.take_profit_pct}% · stop ${alt.stop_pct}%</span></h3>
      <div>P&L <b class="${cls(b.total_pnl)}">${money(b.total_pnl, true)}</b> · win ${b.win_rate}% · PF ${b.profit_factor ?? "—"} · DD ${money(b.max_drawdown)}</div></div>`;
}
function showHistogram(bins){
  const max = Math.max(1, ...bins.map(bin => bin.count));
  $("hist").innerHTML = bins.map(bin => `<div><i class="${bin.side}" style="height:${Math.round(100*bin.count/max)}%"></i><b>${esc(bin.label)}</b></div>`).join("")
    || '<div class="empty">No closed trades.</div>';
}
function renderTrades(){
  const rows = (LAST && LAST.trades || []).slice();
  const key = SORT.key, dir = SORT.dir;
  rows.sort((a, b) => {
    const av = a[key], bv = b[key];
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
  $("trades").innerHTML = rows.map(t => `<tr><td>${esc(t.symbol)}</td><td>${esc(t.side)}</td><td>${t.qty}</td><td>${(+t.entry).toFixed(2)}</td><td>${(+t.exit).toFixed(2)}</td><td>${esc(t.reason)}</td><td class="${cls(t.pnl)}">${money(t.pnl, true)}</td><td class="${cls(t.pnl)}">${t.pnl_pct}%</td></tr>`).join("")
    || '<tr><td class="empty" colspan="8">No trades</td></tr>';
}
function sortBy(key){
  if (SORT.key === key) SORT.dir *= -1; else { SORT.key = key; SORT.dir = key === "symbol" ? 1 : -1; }
  renderTrades();
}
function showResult(data){
  LAST = data;
  const s = data.stats || {};
  const pf = s.profit_factor == null ? (s.wins ? "∞" : "—") : s.profit_factor;
  $("empty").hidden = true;
  $("dash").hidden = false;
  $("kpis").innerHTML = [
    kpi("Total P&L", money(s.total_pnl, true), cls(s.total_pnl)),
    kpi("Win rate", (s.win_rate ?? 0) + "%"),
    kpi("Profit factor", pf),
    kpi("Max drawdown", money(s.max_drawdown), "dn"),
    kpi("Trades", s.trades),
    kpi("Avg win / loss", money(s.avg_win, true) + " / " + money(s.avg_loss, true))
  ].join("");
  $("result-title").textContent = (data.spec && data.spec.name) || "Backtest";
  const syms = data.chart_symbols || [];
  $("px-switch").innerHTML = syms.map(sym => `<button type="button" onclick="drawCharts(LAST,'${esc(sym)}')">${esc(sym)}</button>`).join("");
  showHistogram(data.histogram || []);
  $("bysym").innerHTML = (data.by_symbol || []).map(row => `<tr><td>${esc(row.symbol)}</td><td>${row.trades}</td><td>${row.win_rate}%</td><td class="${cls(row.pnl)}">${money(row.pnl, true)}</td></tr>`).join("")
    || '<tr><td class="empty" colspan="4">No symbol breakdown</td></tr>';
  const skipped = (data.skipped || []).map(row => esc(row.symbol) + " (" + esc(row.reason) + ")").join(", ");
  $("notes").innerHTML = (data.notes || []).map(esc).join("<br>") + (skipped ? "<br>Skipped: " + skipped : "");
  showCompare(data);
  renderTrades();
  drawCharts(data, syms[0]);
}
async function loadUniverse(){
  const id = $("universe").value;
  if (!id) return;
  if (id === "orb"){
    say("Loading the ORB universe…");
    const r = await post("/api/builder/universes/orb", {});
    if (!r.ok){ say(r.error || "ORB universe is not available here", true); return; }
    $("symbols").value = (r.symbols || []).join(", ");
    say((r.note ? r.note + " " : "") + (r.symbols || []).length + " symbols from gapfade._universe.");
    return;
  }
  const preset = (window._universes || []).find(item => item.id === id);
  if (preset && preset.symbols){
    $("symbols").value = preset.symbols.join(", ");
    say(preset.name + " · " + preset.symbols.length + " symbols.");
  }
}
async function init(){
  const meta = await (await fetch("/api/builder/meta")).json();
  if (meta.fixtures) $("banner").hidden = false;
  $("start").value = meta.fixture_start; $("end").value = meta.fixture_end;
  $("cap").textContent = meta.cap || 200;
  const [examples, universes] = await Promise.all([
    fetch("/api/builder/examples").then(r => r.json()),
    fetch("/api/builder/universes").then(r => r.json())
  ]);
  window._ex = examples.examples;
  window._universes = universes.universes || [];
  $("examples").innerHTML = examples.examples.map((ex, i) => `<button type="button" class="ex" onclick="applyExample(window._ex[${i}])"><b>${esc(ex.name)}</b><span>${esc(ex.blurb)}</span></button>`).join("");
  $("universe").innerHTML = '<option value="">Type symbols</option>' + window._universes.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("");
  $("compare").innerHTML = '<option value="">No comparison</option>' + EXITS.filter(item => item.id !== "written").map(item => `<option value="${item.id}">${esc(item.label)}</option>`).join("");
  document.querySelectorAll("#builder-app .tabs button").forEach(btn => btn.addEventListener("click", () => showTab(btn.dataset.tab)));
  document.querySelectorAll("#trades-head th").forEach(th => th.addEventListener("click", () => sortBy(th.dataset.key)));
  $("script").addEventListener("input", () => { paint(); scheduleValidate(); });
  $("script").addEventListener("scroll", () => { $("hl").scrollTop = $("script").scrollTop; $("hl").scrollLeft = $("script").scrollLeft; });
  $("script").addEventListener("keyup", suggest);
  $("script").addEventListener("click", suggest);
  $("chips").innerHTML = ["ema(20)","sma(50)","rsi(14)","vwap","or_high","or_low","rvol5","prior_high","crosses_above"]
    .map(label => `<button type="button" onclick="insertChip('${label}')">${label}</button>`).join("");
  await refreshList();
  setPill();
  if (meta.demo && examples.examples[0]){
    await applyExample(examples.examples[0]);
    $("compare").value = "tight";
    await runBacktest();
  } else if (examples.examples[0]) {
    $("script").value = examples.examples[0].script;
    await scriptToForm();
  }
  paint();
}
init();
