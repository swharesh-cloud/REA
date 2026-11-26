/* Liquid Trader — dashboard logic */
(() => {
"use strict";
const { CandleChart, LineChart, sparkline, fmtPrice, fmtFull } = window.Charts;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem("lt." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("lt." + k, JSON.stringify(v)); } catch {} },
};

// ---------------------------------------------------------------- formatting
const usd = (v, d = 2) => v == null || !isFinite(v) ? "–" : (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const compact = (v) => v == null ? "–" : "$" + Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(v);
const pct = (v, d = 2) => v == null || !isFinite(v) ? "–" : (v > 0 ? "+" : "") + v.toFixed(d) + "%";
const cls = (v) => v > 0 ? "up" : v < 0 ? "down" : "";
const signed = (v) => `<span class="${cls(v)}">${usd(v)}</span>`;
const time = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// ---------------------------------------------------------------- api
async function api(method, path, body) {
  const res = await fetch("/api/" + path, {
    method, headers: { "X-Token": window.TOKEN, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data; try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const GET = (p) => api("GET", p), POST = (p, b) => api("POST", p, b || {}), DEL = (p) => api("DELETE", p);

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind; el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), kind === "error" ? 7000 : 4000);
}
async function guard(fn) { try { return await fn(); } catch (e) { toast(e.message, "error"); throw e; } }

// ---------------------------------------------------------------- modal
function modal(html, { small = false } = {}) {
  const m = $("#modal"); m.className = "modal" + (small ? " small" : ""); m.innerHTML = html;
  $("#modalbg").classList.add("open");
  return m;
}
function closeModal() { $("#modalbg").classList.remove("open"); }
$("#modalbg").addEventListener("mousedown", (e) => { if (e.target.id === "modalbg") closeModal(); });
function confirmBox(title, body, { danger = false, ok = "Confirm", typed = null } = {}) {
  return new Promise((resolve) => {
    const m = modal(`<div class="mh"><h2>${esc(title)}</h2></div><div class="mb">${body}
      ${typed ? `<div class="field" style="margin-top:12px"><label>Type <b>${typed}</b> to confirm</label><input class="input" id="cf-typed" autocomplete="off"></div>` : ""}</div>
      <div class="mf"><button class="btn" id="cf-no">Cancel</button><button class="btn ${danger ? "sell" : "primary"}" id="cf-yes" ${typed ? "disabled" : ""}>${esc(ok)}</button></div>`, { small: true });
    if (typed) $("#cf-typed", m).addEventListener("input", (e) => { $("#cf-yes", m).disabled = e.target.value.trim().toUpperCase() !== typed; });
    $("#cf-no", m).onclick = () => { closeModal(); resolve(false); };
    $("#cf-yes", m).onclick = () => { closeModal(); resolve(true); };
  });
}

// ---------------------------------------------------------------- indicators (client-side)
const I = {
  sma(v, n) { const o = Array(v.length).fill(null); let s = 0; for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= n) s -= v[i - n]; if (i >= n - 1) o[i] = s / n; } return o; },
  ema(v, n) { const o = Array(v.length).fill(null); if (v.length < n) return o; const k = 2 / (n + 1); let p = v.slice(0, n).reduce((a, b) => a + b, 0) / n; o[n - 1] = p; for (let i = n; i < v.length; i++) { p = v[i] * k + p * (1 - k); o[i] = p; } return o; },
  rsi(v, n = 14) { const o = Array(v.length).fill(null); if (v.length <= n) return o; let g = 0, l = 0; for (let i = 1; i <= n; i++) { const d = v[i] - v[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); } let ag = g / n, al = l / n; o[n] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); for (let i = n + 1; i < v.length; i++) { const d = v[i] - v[i - 1]; ag = (ag * (n - 1) + Math.max(d, 0)) / n; al = (al * (n - 1) + Math.max(-d, 0)) / n; o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } return o; },
  boll(v, n = 20, k = 2) { const m = I.sma(v, n), u = Array(v.length).fill(null), l = Array(v.length).fill(null); for (let i = n - 1; i < v.length; i++) { let s = 0; for (let j = i - n + 1; j <= i; j++) s += (v[j] - m[i]) ** 2; const sd = Math.sqrt(s / n); u[i] = m[i] + k * sd; l[i] = m[i] - k * sd; } return { m, u, l }; },
  macd(v) { const f = I.ema(v, 12), s = I.ema(v, 26); const line = f.map((x, i) => x != null && s[i] != null ? x - s[i] : null); const st = line.findIndex((x) => x != null); const sig = Array(v.length).fill(null); if (st >= 0) { const e = I.ema(line.slice(st), 9); e.forEach((x, i) => sig[st + i] = x); } return { line, sig, hist: line.map((x, i) => x != null && sig[i] != null ? x - sig[i] : null) }; },
  vwap(bars) { let pv = 0, vv = 0, day = null; return bars.map((b) => { const d = new Date(b.t).toDateString(); if (d !== day) { day = d; pv = 0; vv = 0; } const tp = (b.h + b.l + b.c) / 3; pv += tp * b.v; vv += b.v; return vv ? pv / vv : null; }); },
};
const IND = [
  { k: "ema9", label: "EMA 9", color: "#f5b041" }, { k: "ema21", label: "EMA 21", color: "#a77bff" },
  { k: "sma50", label: "SMA 50", color: "#4fc3f7" }, { k: "sma200", label: "SMA 200", color: "#ff7eb6" },
  { k: "bb", label: "Bollinger", color: "#8090ff" }, { k: "vwap", label: "VWAP", color: "#e0e0e0" },
  { k: "vol", label: "Volume", color: "#22c38e" }, { k: "rsi", label: "RSI", color: "#f5b041" }, { k: "macd", label: "MACD", color: "#6384ff" },
];

// ---------------------------------------------------------------- state
const S = {
  symbol: store.get("symbol", "BTC-PERP"), interval: store.get("interval", "5m"),
  ind: new Set(store.get("ind", ["ema9", "ema21", "vol"])), mode: store.get("ctype", "candle"),
  favs: store.get("favs", null), markets: [], status: null, bots: [], account: null, strategies: [],
  side: "buy", otype: "market", ticker: null, view: "trade", tab: "positions", drawerBot: null, bars: [],
};
const INTERVALS = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"];

// ---------------------------------------------------------------- navigation
function show(view) {
  S.view = view;
  $$(".navbtn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + view));
  if (view === "bots") renderBots();
  if (view === "settings") renderSettings();
  if (view === "backtest") renderBacktestForm();
  if (view === "tools") renderTools();
  window.dispatchEvent(new Event("resize"));
}
$$(".navbtn").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, select, textarea") || e.metaKey || e.ctrlKey) return;
  const v = ["trade", "bots", "backtest", "tools", "settings"][+e.key - 1];
  if (v) show(v);
  if (e.key === "Escape") { closeModal(); closeDrawer(); }
});

// ---------------------------------------------------------------- status / top bar
async function refreshStatus() {
  try { S.status = await GET("status"); } catch (e) { return; }
  const st = S.status;
  const live = st.live;
  $("#src-dot").className = "dot " + (live ? (st.error ? "" : "live") : "sim");
  $("#src-name").textContent = live ? (st.error ? "Liquid — reconnecting" : "Liquid · live data") : "Simulated market";
  $("#ticket-mode").textContent = live ? "LIVE" : "paper";
  $("#ticket-mode").className = "tag " + (live ? "live" : "paper");
  const kb = $("#killbtn");
  kb.classList.toggle("on", st.kill_switch);
  kb.textContent = st.kill_switch ? "KILL SWITCH ON — reset" : "KILL SWITCH";
  const svc = st.service || {};
  $("#always-pill").style.display = st.headless || svc.running ? "" : "none";
  renderEvents();
}
$("#src-pill").onclick = () => show("settings");
$("#always-pill").onclick = () => show("settings");
$("#killbtn").onclick = async () => {
  if (S.status?.kill_switch) {
    if (await confirmBox("Reset kill switch?", "<p>Bots stay stopped. You can start them again afterwards.</p>")) { await guard(() => POST("killswitch/reset")); refreshStatus(); }
    return;
  }
  const ok = await confirmBox("Engage kill switch", `<p>This immediately <b>stops every bot</b> and <b>market-closes every bot position</b>${S.status?.live ? " on Liquid (real orders)" : ""}.</p><p class="muted">Manual positions you opened yourself are not touched — close those from the Positions tab.</p>`, { danger: true, ok: "Stop everything" });
  if (!ok) return;
  await guard(() => POST("killswitch", { flatten: true }));
  toast("Kill switch engaged — all bots stopped", "warn");
  refreshStatus(); refreshBots();
};

// ---------------------------------------------------------------- markets / symbol picker
async function loadMarkets() {
  try { S.markets = await GET("markets"); } catch (e) { toast("Could not load markets: " + e.message, "error"); return; }
  const syms = S.markets.map((m) => m.symbol);
  if (!syms.includes(S.symbol)) setSymbol(syms[0]);
  if (!S.favs || !S.favs.some((f) => syms.includes(f))) {
    const pref = ["BTC-PERP", "ETH-PERP", "SOL-PERP", "HYPE-PERP", "XRP-PERP", "DOGE-PERP", "NVDA-PERP", "TSLA-PERP", "GOLD-PERP"];
    S.favs = pref.filter((p) => syms.includes(p)); if (S.favs.length < 4) S.favs = syms.slice(0, 10);
  }
  S.favs = S.favs.filter((f) => syms.includes(f));
  renderSymList(); renderWatchlist();
}
function renderSymList() {
  const q = $("#symsearch").value.trim().toUpperCase();
  const list = S.markets.filter((m) => !q || m.symbol.toUpperCase().includes(q)).slice(0, 300);
  $("#symlist").innerHTML = list.map((m) => `<div class="item" data-s="${esc(m.symbol)}"><span><b>${esc(m.symbol)}</b> <span class="dim">${esc(m.exchange || "")}</span></span>
    <span><span class="dim">${m.max_leverage}x</span> <span class="fav" data-f="${esc(m.symbol)}" title="Add to watchlist" style="margin-left:8px;color:${S.favs.includes(m.symbol) ? "#f5b041" : "#5d6679"}">★</span></span></div>`).join("");
}
$("#symsel").addEventListener("click", (e) => {
  const fav = e.target.closest(".fav");
  if (fav) { const s = fav.dataset.f; S.favs = S.favs.includes(s) ? S.favs.filter((x) => x !== s) : [...S.favs, s]; store.set("favs", S.favs); renderSymList(); renderWatchlist(); e.stopPropagation(); return; }
  const item = e.target.closest(".item");
  if (item) { setSymbol(item.dataset.s); $("#symdrop").classList.remove("open"); e.stopPropagation(); return; }
  if (e.target.id === "symsearch") return;
  $("#symdrop").classList.toggle("open"); if ($("#symdrop").classList.contains("open")) { $("#symsearch").value = ""; renderSymList(); $("#symsearch").focus(); }
});
$("#symsearch").addEventListener("input", renderSymList);
document.addEventListener("mousedown", (e) => { if (!e.target.closest("#symsel")) $("#symdrop").classList.remove("open"); });

function setSymbol(s) {
  if (!s) return;
  S.symbol = s; store.set("symbol", s);
  $("#sym-name").textContent = s; $("#ob-sym").textContent = s;
  S.bars = []; chart.setData([], false); chart.emptyText = "Loading " + s + "…";
  renderWatchlist(); refreshChart(true); refreshTicker(); refreshBook(); updateTicket(); renderBottom();
}

// ---------------------------------------------------------------- watchlist
const wlSpark = {};
function renderWatchlist() {
  const q = $("#wlsearch").value.trim().toUpperCase();
  const favs = S.favs.filter((s) => !q || s.includes(q));
  $("#wl-count").textContent = S.markets.length ? `${S.markets.length} markets` : "";
  $("#watchlist").innerHTML = favs.map((s) => {
    const t = wlSpark[s] || {};
    return `<div class="wrow ${s === S.symbol ? "sel" : ""}" data-s="${esc(s)}"><span class="s">${esc(s.replace("-PERP", ""))}<span class="dim" style="font-weight:400">-PERP</span></span>
      <span class="p">${t.price ? fmtPrice(t.price) : "–"}</span><span class="ex">${esc((S.markets.find((m) => m.symbol === s) || {}).exchange || "")}</span><span class="c ${cls(t.change_24h)}">${pct(t.change_24h)}</span></div>`;
  }).join("") || `<div class="empty">No markets. Use ★ in the symbol picker to add some.</div>`;
}
$("#wlsearch").addEventListener("input", renderWatchlist);
$("#watchlist").addEventListener("click", (e) => { const r = e.target.closest(".wrow"); if (r) setSymbol(r.dataset.s); });
async function refreshWatch() {
  if (!S.favs?.length) return;
  try {
    const ts = await GET("tickers?symbols=" + encodeURIComponent(S.favs.join(",")));
    ts.forEach((t) => { if (!t.error) wlSpark[t.symbol] = t; });
    renderWatchlist();
  } catch {}
}

// ---------------------------------------------------------------- ticker
async function refreshTicker() {
  try {
    const t = await GET("ticker?symbol=" + encodeURIComponent(S.symbol));
    const prev = S.ticker?.price;
    S.ticker = t;
    const el = $("#t-price");
    el.textContent = fmtPrice(t.price);
    if (prev && t.price !== prev) { el.className = "v " + (t.price > prev ? "up" : "down"); }
    $("#t-chg").innerHTML = `<span class="${cls(t.change_24h)}">${pct(t.change_24h)}</span>`;
    $("#t-vol").textContent = compact(t.volume_24h);
    $("#t-fund").innerHTML = `<span class="${cls(t.funding_rate)}">${(t.funding_rate * 100).toFixed(4)}%</span>`;
    document.title = `${fmtPrice(t.price)} ${S.symbol} · Liquid Trader`;
    updateTicket();
  } catch (e) { /* transient */ }
}

// ---------------------------------------------------------------- chart
const chart = new CandleChart($("#chart"), { mode: S.mode });
$("#intervals").innerHTML = INTERVALS.map((i) => `<button data-i="${i}" class="${i === S.interval ? "on" : ""}">${i}</button>`).join("");
$("#intervals").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; S.interval = b.dataset.i; store.set("interval", S.interval); $$("#intervals button").forEach((x) => x.classList.toggle("on", x === b)); S.bars = []; chart.setData([], false); refreshChart(true); };
$("#ctype").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; S.mode = b.dataset.m; store.set("ctype", S.mode); $$("#ctype button").forEach((x) => x.classList.toggle("on", x === b)); chart.set({ mode: S.mode }); };
$$("#ctype button").forEach((x) => x.classList.toggle("on", x.dataset.m === S.mode));
$("#indchips").innerHTML = IND.map((d) => `<button class="chip ${S.ind.has(d.k) ? "on" : ""}" data-k="${d.k}"><i style="background:${d.color}"></i>${d.label}</button>`).join("");
$("#indchips").onclick = (e) => { const b = e.target.closest(".chip"); if (!b) return; const k = b.dataset.k; S.ind.has(k) ? S.ind.delete(k) : S.ind.add(k); b.classList.toggle("on"); store.set("ind", [...S.ind]); applyIndicators(); };

chart.onHover = (b) => {
  if (!b) return;
  const chg = (b.c / b.o - 1) * 100;
  $("#legend").innerHTML = `<span><b>${esc(S.symbol)}</b> · ${S.interval}</span><span>O <b>${fmtPrice(b.o)}</b></span><span>H <b>${fmtPrice(b.h)}</b></span><span>L <b>${fmtPrice(b.l)}</b></span><span>C <b class="${cls(chg)}">${fmtPrice(b.c)}</b></span><span class="${cls(chg)}">${pct(chg)}</span>`;
};

function applyIndicators() {
  const bars = S.bars, c = bars.map((b) => b.c);
  const ov = [], bands = [], panes = [];
  const def = (k) => IND.find((d) => d.k === k);
  if (S.ind.has("ema9")) ov.push({ values: I.ema(c, 9), color: def("ema9").color });
  if (S.ind.has("ema21")) ov.push({ values: I.ema(c, 21), color: def("ema21").color });
  if (S.ind.has("sma50")) ov.push({ values: I.sma(c, 50), color: def("sma50").color });
  if (S.ind.has("sma200")) ov.push({ values: I.sma(c, 200), color: def("sma200").color });
  if (S.ind.has("vwap")) ov.push({ values: I.vwap(bars), color: def("vwap").color, dash: [4, 3], width: 1 });
  if (S.ind.has("bb")) { const b = I.boll(c); bands.push({ upper: b.u, lower: b.l }); ov.push({ values: b.m, color: "rgba(128,144,255,.6)", width: 1 }, { values: b.u, color: "rgba(128,144,255,.5)", width: 1 }, { values: b.l, color: "rgba(128,144,255,.5)", width: 1 }); }
  if (S.ind.has("rsi")) panes.push({ name: "RSI 14", range: [0, 100], levels: [30, 70], series: [{ values: I.rsi(c), color: "#f5b041" }] });
  if (S.ind.has("macd")) { const m = I.macd(c); panes.push({ name: "MACD 12 26 9", levels: [0], series: [{ values: m.hist, type: "hist" }, { values: m.line, color: "#6384ff" }, { values: m.sig, color: "#f5b041" }] }); }
  // bot overlays for this symbol: entries, grid levels, trade markers
  const hl = [], markers = [];
  for (const b of S.bots.filter((x) => x.symbol === S.symbol)) {
    if (b.position) hl.push({ price: b.entry, color: b.position > 0 ? "#22c38e" : "#f0506e", label: `${b.name} ${b.position > 0 ? "long" : "short"}` });
  }
  for (const p of (S.account?.positions || []).filter((p) => p.symbol === S.symbol)) {
    const e = +p.entry_price; if (e) hl.push({ price: e, color: "#6384ff", label: "Your " + p.side });
    const lq = +p.liquidation_price; if (lq) hl.push({ price: lq, color: "#f5b041", label: "Liq." });
  }
  for (const t of S.symFills || []) markers.push({ t: t.t, side: t.side });
  chart.set({ overlays: ov, bands, panes, showVolume: S.ind.has("vol"), hlines: hl, markers });
}

let chartBusy = false;
async function refreshChart(reset = false) {
  if (chartBusy && !reset) return; chartBusy = true;
  const sym = S.symbol, iv = S.interval;
  try {
    const r = await GET(`candles?symbol=${encodeURIComponent(sym)}&interval=${iv}&limit=300`);
    if (sym !== S.symbol || iv !== S.interval) return;
    S.bars = r.candles;
    if (S.ticker && S.bars.length && S.ticker.symbol === sym) { // live-update the last candle
      const last = S.bars[S.bars.length - 1]; last.c = S.ticker.price; last.h = Math.max(last.h, last.c); last.l = Math.min(last.l, last.c);
    }
    chart.emptyText = S.bars.length ? "" : "No candles for this market";
    applyIndicators();
    chart.setData(S.bars, !reset);
  } catch (e) { chart.emptyText = "Chart error: " + e.message; chart.draw(); }
  finally { chartBusy = false; }
}

// ---------------------------------------------------------------- order book
async function refreshBook() {
  try {
    const ob = await GET(`orderbook?symbol=${encodeURIComponent(S.symbol)}&depth=14`);
    const asks = ob.asks.slice(0, 12), bids = ob.bids.slice(0, 12);
    let cum = 0; const ac = asks.map((a) => (cum += a.price * a.size)); cum = 0; const bc = bids.map((b) => (cum += b.price * b.size));
    const max = Math.max(ac[ac.length - 1] || 1, bc[bc.length - 1] || 1);
    const row = (l, tot, side) => `<div class="brow ${side}"><div class="bar" style="width:${(tot / max * 100).toFixed(1)}%"></div><span class="${side === "ask" ? "down" : "up"}">${fmtPrice(l.price)}</span><span>${l.size.toFixed(l.size < 10 ? 4 : 2)}</span><span>${compact(tot)}</span></div>`;
    const spread = asks[0] && bids[0] ? asks[0].price - bids[0].price : 0;
    $("#book").innerHTML = asks.map((a, i) => row(a, ac[i], "ask")).reverse().join("") +
      `<div class="spread"><span class="num">${S.ticker ? fmtPrice(S.ticker.price) : ""}</span><span class="muted">spread ${fmtPrice(spread)} (${asks[0] ? (spread / asks[0].price * 10000).toFixed(1) : "–"} bps)</span></div>` +
      bids.map((b, i) => row(b, bc[i], "bid")).join("");
  } catch (e) { $("#book").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
$("#book").addEventListener("click", (e) => { const r = e.target.closest(".brow"); if (r && S.otype === "limit") { $("#o-price").value = r.querySelector("span").textContent.replace(/,/g, ""); updateTicket(); } });

// ---------------------------------------------------------------- order ticket
$$(".sidebtn").forEach((b) => b.onclick = () => { S.side = b.dataset.s; $$(".sidebtn").forEach((x) => x.classList.toggle("on", x === b)); updateTicket(); });
$("#otype").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; S.otype = b.dataset.o; $$("#otype button").forEach((x) => x.classList.toggle("on", x === b)); $("#limitfield").style.display = S.otype === "limit" ? "" : "none"; if (S.otype === "limit" && !$("#o-price").value && S.ticker) $("#o-price").value = S.ticker.price; updateTicket(); };
$$(".quick button").forEach((b) => b.onclick = () => { $("#o-usd").value = b.dataset.q; updateTicket(); });
["o-usd", "o-lev", "o-price", "o-tp", "o-sl"].forEach((id) => $("#" + id).addEventListener("input", updateTicket));
function maxLev() { return (S.markets.find((m) => m.symbol === S.symbol) || {}).max_leverage || 50; }
function liqPrice(entry, lev, side, mLev) {
  const mmr = 1 / (2 * (mLev || 50)); // Hyperliquid-style maintenance margin ≈ half the initial margin at max leverage
  return side === "buy" ? entry * (1 - 1 / lev + mmr) : entry * (1 + 1 / lev - mmr);
}
function updateTicket() {
  const ml = maxLev(); const lev = $("#o-lev"); lev.max = ml; if (+lev.value > ml) lev.value = ml;
  $("#o-levv").textContent = lev.value + "x";
  const u = +$("#o-usd").value || 0, L = +lev.value;
  const px = S.otype === "limit" ? +$("#o-price").value || S.ticker?.price : S.ticker?.price;
  $("#o-coin").textContent = px ? `≈ ${(u / px).toPrecision(4)} ${S.symbol.split("-")[0]}` : "";
  $("#o-margin").textContent = usd(u / L);
  $("#o-liq").textContent = px ? fmtPrice(liqPrice(px, L, S.side, ml)) : "–";
  $("#o-fee").textContent = usd(u * 0.00045, 3);
  const b = $("#o-submit"); const base = S.symbol.split("-")[0];
  b.className = "btn block " + S.side; b.textContent = `${S.side === "buy" ? "Buy / Long" : "Sell / Short"} ${base}${S.status?.live ? "" : " (paper)"}`;
}
$("#o-submit").onclick = async () => {
  const body = { symbol: S.symbol, side: S.side, usd: +$("#o-usd").value, type: S.otype, leverage: +$("#o-lev").value,
    price: S.otype === "limit" ? +$("#o-price").value : null, tp: +$("#o-tp").value || null, sl: +$("#o-sl").value || null };
  if (!(body.usd >= 10)) return toast("Minimum order is $10", "error");
  if (S.status?.live) {
    const ok = await confirmBox("Place LIVE order", `<p><b class="${body.side === "buy" ? "up" : "down"}">${body.side.toUpperCase()}</b> ${usd(body.usd)} of <b>${esc(S.symbol)}</b> at ${body.leverage}x (${body.type}${body.price ? " @ " + fmtPrice(body.price) : ""}).</p><p class="muted">This sends a real order to Liquid.</p>`, { danger: body.side === "sell", ok: "Place order" });
    if (!ok) return; body.confirm = true;
  }
  await guard(() => POST("order", body));
  toast(`${body.side === "buy" ? "Bought" : "Sold"} ${usd(body.usd)} ${S.symbol}${S.status?.live ? "" : " (paper)"}`, "ok");
  refreshAccount();
};

// ---------------------------------------------------------------- account / bottom panel
async function refreshAccount() {
  try { S.account = await GET("account"); } catch (e) { S.account = { error: e.message, positions: [] }; }
  const a = S.account.account || {};
  const botEq = S.bots.reduce((s, b) => s + (b.mode === "paper" ? b.equity - b.budget : 0), 0);
  $("#t-eq").textContent = a.equity != null ? usd(+a.equity) : "–";
  $("#t-eq").title = S.status?.live ? "Liquid account equity" : "Simulated manual account (paper bots tracked separately: " + usd(botEq) + " P&L)";
  $("#b-pos").textContent = (S.account.positions || []).length;
  if (S.tab === "positions") renderBottom();
}
$("#btabs").onclick = (e) => { const b = e.target.closest(".tab"); if (!b) return; S.tab = b.dataset.t; $$("#btabs .tab").forEach((x) => x.classList.toggle("on", x === b)); renderBottom(); };
function renderBottom() {
  const el = $("#bpane");
  if (S.tab === "positions") {
    const ps = S.account?.positions || [];
    if (S.account?.error) { el.innerHTML = `<div class="empty">${esc(S.account.error)}</div>`; return; }
    el.innerHTML = ps.length ? `<table class="t"><tr><th>Market</th><th>Side</th><th class="n">Size</th><th class="n">Entry</th><th class="n">Mark</th><th class="n">uPnL</th><th class="n">Liq.</th><th></th></tr>${ps.map((p) => `
      <tr><td><a href="#" data-s="${esc(p.symbol)}" class="symlink" style="color:inherit">${esc(p.symbol)}</a></td><td class="${p.side === "long" ? "up" : "down"}">${esc(p.side)}</td><td class="n">${(+p.size).toPrecision(5)}</td><td class="n">${fmtPrice(+p.entry_price)}</td>
      <td class="n">${fmtPrice(+p.mark_price)}</td><td class="n">${signed(+p.unrealized_pnl)}</td><td class="n">${p.liquidation_price ? fmtPrice(+p.liquidation_price) : "–"}</td>
      <td class="n"><button class="btn sm danger" data-close="${esc(p.symbol)}">Close</button></td></tr>`).join("")}</table>`
      : `<div class="empty">No open positions${S.status?.live ? "" : " in your simulated manual account"}. Bot positions are on the Bots tab.</div>`;
  } else if (S.tab === "symbots") {
    const bs = S.bots;
    el.innerHTML = bs.length ? `<table class="t"><tr><th>Bot</th><th>Market</th><th>Mode</th><th>Status</th><th class="n">Position</th><th class="n">Equity</th><th class="n">Return</th><th></th></tr>${bs.map((b) => `
      <tr><td><a href="#" data-bot="${b.id}" style="color:inherit">${esc(b.name)}</a></td><td>${esc(b.symbol)}</td><td><span class="tag ${b.mode}">${b.mode}</span></td><td><span class="tag ${b.status}">${b.status}</span></td>
      <td class="n">${b.position ? usd(b.notional) : "flat"}</td><td class="n">${usd(b.equity)}</td><td class="n ${cls(b.return_pct)}">${pct(b.return_pct)}</td>
      <td class="n"><button class="btn sm" data-toggle="${b.id}">${b.status === "running" ? "Stop" : "Start"}</button></td></tr>`).join("")}</table>`
      : `<div class="empty">No bots yet. <a href="#" id="mkbot">Create one</a>.</div>`;
  } else if (S.tab === "fills") {
    const fills = [];
    S.bots.forEach((b) => (b._trades || []).forEach((t) => fills.push({ ...t, who: b.name, symbol: b.symbol })));
    (S.account?.trades || []).forEach((t) => fills.push({ ...t, who: "Manual", coin: t.usd / t.price }));
    fills.sort((a, b) => b.t - a.t);
    el.innerHTML = fills.length ? `<table class="t"><tr><th>Time</th><th>Source</th><th>Market</th><th>Side</th><th class="n">Price</th><th class="n">Value</th><th class="n">Realized</th><th>Reason</th></tr>${fills.slice(0, 100).map((t) => `
      <tr><td class="dim">${fmtFull(t.t)}</td><td>${esc(t.who)}</td><td>${esc(t.symbol)}</td><td class="${t.side === "buy" ? "up" : "down"}">${t.side}</td><td class="n">${fmtPrice(t.price)}</td><td class="n">${usd(t.usd)}</td><td class="n">${t.pnl ? signed(t.pnl) : "–"}</td><td class="dim">${esc(t.reason || "")}</td></tr>`).join("")}</table>`
      : `<div class="empty">No fills yet.</div>`;
  } else {
    renderEvents();
  }
}
function renderEvents() {
  if (S.tab !== "activity" || S.view !== "trade") return;
  const ev = (S.status?.events || []).slice().reverse();
  $("#bpane").innerHTML = ev.length ? `<div class="logbox" style="border:0;max-height:none">${ev.map((e) => `<div class="${e.level === "error" ? "down" : e.level === "warn" ? "warn" : ""}"><b>${time(e.t)}</b>${esc(e.msg)}</div>`).join("")}</div>` : `<div class="empty">No activity yet.</div>`;
}
$("#bpane").addEventListener("click", async (e) => {
  const t = e.target;
  if (t.dataset.close) {
    const sym = t.dataset.close;
    if (S.status?.live && !(await confirmBox("Close position", `<p>Market-close your entire <b>${esc(sym)}</b> position on Liquid?</p>`, { danger: true, ok: "Close position" }))) return;
    await guard(() => POST("close_position", { symbol: sym })); toast("Closed " + sym, "ok"); refreshAccount();
  } else if (t.dataset.bot) { e.preventDefault(); openBot(t.dataset.bot); }
  else if (t.dataset.toggle) { const b = S.bots.find((x) => x.id === t.dataset.toggle); await toggleBot(b); }
  else if (t.dataset.s) { e.preventDefault(); setSymbol(t.dataset.s); }
  else if (t.id === "mkbot") { e.preventDefault(); newBotModal(); }
});

// ---------------------------------------------------------------- bots
async function refreshBots() {
  try { S.bots = await GET("bots"); } catch { return; }
  $("#b-bots").textContent = S.bots.length;
  // pull recent trades of bots on the current symbol for chart markers
  const onSym = S.bots.filter((b) => b.symbol === S.symbol && b.trades);
  const fills = [];
  await Promise.all(S.bots.filter((b) => b.trades).slice(0, 12).map(async (b) => {
    try { const d = await GET("bots/" + b.id); b._trades = d.trades; b._curve = d.equity_curve; if (onSym.includes(b)) fills.push(...d.trades); } catch {}
  }));
  S.symFills = fills;
  if (S.view === "bots") renderBots();
  if (S.view === "trade" && (S.tab === "symbots" || S.tab === "fills")) renderBottom();
  if (S.drawerBot) refreshDrawer();
}
async function toggleBot(b) {
  if (b.status === "running") { await guard(() => POST(`bots/${b.id}/stop`)); toast(`Stopped ${b.name}`); }
  else {
    let confirm_live = false;
    if (b.mode === "live") {
      confirm_live = await confirmBox("Start LIVE bot", `<p><b>${esc(b.name)}</b> will place <b>real orders</b> on Liquid with up to <b>${usd(b.budget * b.leverage, 0)}</b> notional (${usd(b.budget, 0)} × ${b.leverage}x) on ${esc(b.symbol)}.</p><p class="muted">Past performance and backtests don't guarantee results. You can stop it or hit the kill switch at any time.</p>`, { danger: true, ok: "Start live bot", typed: "LIVE" });
      if (!confirm_live) return;
    }
    await guard(() => POST(`bots/${b.id}/start`, { confirm_live })); toast(`Started ${b.name}`, "ok");
  }
  refreshBots();
}
function renderBots() {
  const bs = S.bots;
  const running = bs.filter((b) => b.status === "running").length;
  const tot = bs.reduce((a, b) => a + b.budget, 0), eq = bs.reduce((a, b) => a + b.equity, 0);
  const real = bs.reduce((a, b) => a + b.realized - b.fees, 0), unr = bs.reduce((a, b) => a + b.unrealized, 0);
  $("#bots-sub").textContent = `${running} running · ${bs.length} total`;
  $("#botstats").innerHTML = [
    ["Allocated", usd(tot, 0), `${bs.filter((b) => b.mode === "live").length} live · ${bs.filter((b) => b.mode === "paper").length} paper`],
    ["Bot equity", usd(eq), `<span class="${cls(eq - tot)}">${pct(tot ? (eq / tot - 1) * 100 : 0)}</span> overall`],
    ["Realized P&L", signed(real), "after fees"], ["Unrealized P&L", signed(unr), "open positions"],
    ["Engine", S.status?.headless ? "24/7 service" : "In-app", S.status ? "up " + dur(S.status.uptime_s) : ""],
  ].map(([k, v, s]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join("");
  $("#botgrid").innerHTML = bs.map((b) => `
    <div class="botcard" data-id="${b.id}">
      <div class="h"><div style="min-width:0"><div class="name">${esc(b.name)}</div><div class="meta">${esc(b.strategy_label)} · ${esc(b.symbol)} · ${b.interval} · ${b.leverage}x</div></div>
        <div style="margin-left:auto;display:flex;gap:4px;flex-direction:column;align-items:flex-end"><span class="tag ${b.mode}">${b.mode.toUpperCase()}</span><span class="tag ${b.status}">${b.status}</span></div></div>
      <canvas data-spark="${b.id}"></canvas>
      <div class="nums"><div><small>Equity</small><b>${usd(b.equity)}</b></div><div><small>Return</small><b class="${cls(b.return_pct)}">${pct(b.return_pct)}</b></div><div><small>Position</small><b>${b.position ? usd(b.notional, 0) : "flat"}</b></div></div>
      ${b.error ? `<div class="note warn" style="padding:5px 8px">${esc(b.error)}</div>` : ""}
      <div style="display:flex;gap:6px"><button class="btn sm ${b.status === "running" ? "" : "primary"}" data-act="toggle">${b.status === "running" ? "Stop" : "Start"}</button>
        <button class="btn sm" data-act="open">Details</button><span class="dim" style="margin-left:auto;font-size:11px;align-self:center">${b.trades} trades${b.win_rate != null ? " · " + b.win_rate.toFixed(0) + "% win" : ""}</span></div>
    </div>`).join("") + `<button class="botcard newcard" id="newbot2">+ New bot<br><span class="dim" style="font-size:12px">Grid, trend, mean-reversion, breakout, DCA</span></button>`;
  $$("canvas[data-spark]").forEach((c) => { const b = bs.find((x) => x.id === c.dataset.spark); const v = (b._curve || []).map((p) => p[1]); sparkline(c, v.length > 1 ? v : [b.budget, b.equity], b.equity >= b.budget ? "#22c38e" : "#f0506e"); });
}
function dur(s) { s = Math.floor(s || 0); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`; }
$("#botgrid").addEventListener("click", async (e) => {
  if (e.target.closest("#newbot2")) return newBotModal();
  const card = e.target.closest(".botcard"); if (!card) return;
  const b = S.bots.find((x) => x.id === card.dataset.id);
  const act = e.target.dataset.act;
  if (act === "toggle") { e.stopPropagation(); return toggleBot(b); }
  openBot(b.id);
});
$("#newbot").onclick = () => newBotModal();
$("#stopall").onclick = async () => {
  const run = S.bots.filter((b) => b.status === "running"); if (!run.length) return toast("No running bots");
  if (!(await confirmBox("Stop all bots?", `<p>${run.length} bot(s) will stop. Their positions stay open.</p>`))) return;
  for (const b of run) await POST(`bots/${b.id}/stop`).catch(() => {});
  refreshBots();
};

// ---------------------------------------------------------------- bot drawer
let drawerCharts = [];
function closeDrawer() { $("#drawer").classList.remove("open"); S.drawerBot = null; drawerCharts.forEach((c) => c.destroy()); drawerCharts = []; }
async function openBot(id) {
  S.drawerBot = id;
  const d = $("#drawer");
  d.innerHTML = `<div class="dh"><h2 id="dw-title">…</h2><span id="dw-tags"></span><button class="x" id="dw-x">×</button></div>
    <div class="db"><div class="stats" id="dw-stats"></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap" id="dw-actions"></div>
      <div class="section-t" style="margin:4px 0 0">Equity</div><div class="minichart" id="dw-eq"></div>
      <div class="section-t" style="margin:4px 0 0">Trades on chart</div><div class="minichart" id="dw-px" style="height:260px"></div>
      <div class="section-t" style="margin:4px 0 0">Settings</div><div id="dw-params" class="note"></div>
      <div class="section-t" style="margin:4px 0 0">Trades</div><div class="scroll" style="max-height:260px;border:1px solid var(--line);border-radius:8px" id="dw-trades"></div>
      <div class="section-t" style="margin:4px 0 0">Log</div><div class="logbox" id="dw-log"></div></div>`;
  d.classList.add("open");
  $("#dw-x").onclick = closeDrawer;
  drawerCharts.forEach((c) => c.destroy());
  drawerCharts = [new LineChart($("#dw-eq"), { empty: "Equity appears once the bot runs" }), new CandleChart($("#dw-px"), { count: 90 })];
  refreshDrawer(true);
}
async function refreshDrawer(first) {
  const id = S.drawerBot; if (!id) return;
  let b; try { b = await GET("bots/" + id); } catch { return closeDrawer(); }
  $("#dw-title").textContent = b.name;
  $("#dw-tags").innerHTML = `<span class="tag ${b.mode}">${b.mode.toUpperCase()}</span> <span class="tag ${b.status}">${b.status}</span>`;
  $("#dw-stats").innerHTML = [["Equity", usd(b.equity)], ["Return", `<span class="${cls(b.return_pct)}">${pct(b.return_pct)}</span>`], ["Realized", signed(b.realized)], ["Unrealized", signed(b.unrealized)],
    ["Position", b.position ? `${b.position > 0 ? "Long" : "Short"} ${usd(Math.abs(b.notional), 0)}` : "Flat"], ["Entry", b.entry ? fmtPrice(b.entry) : "–"], ["Fees", usd(b.fees)], ["Win rate", b.win_rate != null ? b.win_rate.toFixed(0) + "%" : "–"]]
    .map(([k, v]) => `<div class="stat" style="padding:9px 12px"><div class="k">${k}</div><div class="v" style="font-size:15px">${v}</div></div>`).join("");
  $("#dw-actions").innerHTML = `<button class="btn ${b.status === "running" ? "" : "primary"}" data-a="toggle">${b.status === "running" ? "Stop bot" : "Start bot"}</button>
    <button class="btn" data-a="close" ${b.position ? "" : "disabled"}>Close position</button><button class="btn" data-a="clone">Duplicate</button><button class="btn" data-a="bt">Backtest these settings</button>
    ${b.mode === "paper" ? `<button class="btn" data-a="reset">Reset stats</button>` : ""}<button class="btn danger" data-a="del" style="margin-left:auto">Delete</button>`;
  $("#dw-actions").onclick = async (e) => {
    const a = e.target.dataset.a; if (!a) return;
    if (a === "toggle") await toggleBot(b);
    if (a === "close") { if (b.mode === "live" && !(await confirmBox("Close live position", `<p>Market-close ${esc(b.name)}'s ${usd(Math.abs(b.notional))} position?</p>`, { danger: true, ok: "Close" }))) return; await guard(() => POST(`bots/${b.id}/close`)); toast("Position closed", "ok"); }
    if (a === "reset") { await guard(() => POST(`bots/${b.id}/reset`)); }
    if (a === "del") { if (!(await confirmBox("Delete bot?", `<p>Delete <b>${esc(b.name)}</b> and its history?</p>`, { danger: true, ok: "Delete" }))) return; await guard(() => DEL("bots/" + b.id)); closeDrawer(); toast("Bot deleted"); }
    if (a === "clone") { closeDrawer(); newBotModal({ ...b, name: b.name + " copy", mode: "paper" }); }
    if (a === "bt") { closeDrawer(); show("backtest"); fillBacktest(b); }
    refreshBots();
  };
  drawerCharts[0].opts.baseline = b.budget;
  drawerCharts[0].setSeries([{ name: "Equity", points: b.equity_curve, color: b.equity >= b.budget ? "#22c38e" : "#f0506e", fill: b.equity >= b.budget ? "rgba(34,195,142,.25)" : "rgba(240,80,110,.25)" }]);
  try {
    const r = await GET(`candles?symbol=${encodeURIComponent(b.symbol)}&interval=${b.interval}&limit=200`);
    const hl = [];
    if (b.grid) b.grid.forEach((g, i) => hl.push({ price: g, color: "rgba(160,170,200,.45)", dash: [2, 4], label: i === 0 ? "grid" : "" }));
    if (b.position) hl.push({ price: b.entry, color: b.position > 0 ? "#22c38e" : "#f0506e", label: "entry", fit: true });
    const c = drawerCharts[1]; c.set({ markers: b.trades.map((t) => ({ t: t.t, side: t.side })), hlines: hl, showVolume: false });
    c.setData(r.candles, !first);
  } catch {}
  $("#dw-params").innerHTML = Object.entries(b.params).map(([k, v]) => `<b>${esc(k)}</b>: ${esc(v)}`).join(" · ") +
    `<br>Budget ${usd(b.budget, 0)} · ${b.leverage}x · ${b.interval}${b.stop_loss_pct ? " · SL " + b.stop_loss_pct + "%" : ""}${b.take_profit_pct ? " · TP " + b.take_profit_pct + "%" : ""}${b.max_drawdown_pct ? " · max DD " + b.max_drawdown_pct + "%" : ""}`;
  $("#dw-trades").innerHTML = b.trades.length ? `<table class="t"><tr><th>Time</th><th>Side</th><th class="n">Price</th><th class="n">Value</th><th class="n">P&L</th><th>Reason</th></tr>${b.trades.slice().reverse().map((t) => `<tr><td class="dim">${fmtFull(t.t)}</td><td class="${t.side === "buy" ? "up" : "down"}">${t.side}</td><td class="n">${fmtPrice(t.price)}</td><td class="n">${usd(t.usd)}</td><td class="n">${t.pnl ? signed(t.pnl) : "–"}</td><td class="dim">${esc(t.reason)}</td></tr>`).join("")}</table>` : `<div class="empty">No trades yet</div>`;
  $("#dw-log").innerHTML = b.logs.slice().reverse().map((l) => `<div><b>${fmtFull(l.t)}</b>${esc(l.msg)}</div>`).join("");
}

// ---------------------------------------------------------------- strategy forms (shared by new-bot and backtest)
function paramFields(strat, values = {}) {
  return strat.params.map((p) => {
    const v = values[p.name] ?? p.default;
    const help = p.help ? ` title="${esc(p.help)}"` : "";
    if (p.type === "bool") return `<div class="field"${help}><label>${esc(p.label)}</label><select class="input" data-p="${p.name}"><option value="false" ${!v ? "selected" : ""}>No</option><option value="true" ${v ? "selected" : ""}>Yes</option></select></div>`;
    if (p.type === "choice") return `<div class="field"${help}><label>${esc(p.label)}</label><select class="input" data-p="${p.name}">${p.choices.map((c) => `<option ${c === v ? "selected" : ""}>${c}</option>`).join("")}</select></div>`;
    return `<div class="field"${help}><label>${esc(p.label)}${p.help ? ' <span class="dim">ⓘ</span>' : ""}</label><input class="input num" type="number" step="any" data-p="${p.name}" value="${v}" ${p.min != null ? `min="${p.min}"` : ""} ${p.max != null ? `max="${p.max}"` : ""}></div>`;
  }).join("");
}
function readParams(root) {
  const o = {};
  $$("[data-p]", root).forEach((el) => { o[el.dataset.p] = el.tagName === "SELECT" && (el.value === "true" || el.value === "false") ? el.value === "true" : el.type === "number" ? +el.value : el.value; });
  return o;
}
function symOptions(sel) { return S.markets.map((m) => `<option ${m.symbol === sel ? "selected" : ""}>${esc(m.symbol)}</option>`).join(""); }
function ivOptions(sel) { return INTERVALS.map((i) => `<option ${i === sel ? "selected" : ""}>${i}</option>`).join(""); }
const STRAT_DEFAULT_IV = { grid: "1m", ma_cross: "15m", rsi: "15m", bollinger: "15m", breakout: "1h", dca: "1h" };

function newBotModal(pre = {}) {
  let strat = S.strategies.find((s) => s.key === pre.strategy) || S.strategies[0];
  let mode = pre.mode || "paper";
  const m = modal(`<div class="mh"><h2>New trading bot</h2><button class="x" id="nb-x">×</button></div>
    <div class="mb">
      <div class="section-t" style="margin-top:0">1 · Strategy</div>
      <div class="stratgrid" id="nb-strats">${S.strategies.map((s) => `<div class="strat ${s.key === strat.key ? "on" : ""}" data-k="${s.key}"><b>${esc(s.label)}</b><span>${esc(s.description)}</span></div>`).join("")}</div>
      <div class="section-t">2 · Market & sizing</div>
      <div class="formgrid">
        <div class="field"><label>Name</label><input class="input" id="nb-name" value="${esc(pre.name || "")}" placeholder="auto"></div>
        <div class="field"><label>Market</label><select class="input" id="nb-sym">${symOptions(pre.symbol || S.symbol)}</select></div>
        <div class="field"><label>Candle interval</label><select class="input" id="nb-iv">${ivOptions(pre.interval || STRAT_DEFAULT_IV[strat.key])}</select></div>
        <div class="field"><label>Budget (USD)</label><input class="input num" type="number" id="nb-budget" value="${pre.budget || 1000}" min="10"></div>
        <div class="field"><label>Leverage</label><input class="input num" type="number" id="nb-lev" value="${pre.leverage || 1}" min="1" max="50" step="1"></div>
        <div class="field"><label>Max notional</label><input class="input num" id="nb-notional" disabled></div>
      </div>
      <div class="section-t">3 · Strategy parameters</div>
      <div class="formgrid" id="nb-params">${paramFields(strat, pre.params)}</div>
      <div class="section-t">4 · Risk management</div>
      <div class="formgrid">
        <div class="field" title="Close the position if price moves this % against the entry"><label>Stop-loss %</label><input class="input num" type="number" id="nb-sl" value="${pre.stop_loss_pct || ""}" placeholder="off" step="any"></div>
        <div class="field" title="Close the position once price moves this % in your favour"><label>Take-profit %</label><input class="input num" type="number" id="nb-tp" value="${pre.take_profit_pct || ""}" placeholder="off" step="any"></div>
        <div class="field" title="Flatten and halt the bot if equity falls this % below its peak"><label>Max drawdown %</label><input class="input num" type="number" id="nb-dd" value="${pre.max_drawdown_pct || 25}" placeholder="off" step="any"></div>
      </div>
      <div class="section-t">5 · Mode</div>
      <div class="modeswitch"><div class="modeopt paper ${mode === "paper" ? "on" : ""}" data-m="paper"><b>Paper trading</b><small>Simulated fills on ${S.status?.live ? "live Liquid prices" : "the simulated market"}. No real money.</small></div>
        <div class="modeopt live ${mode === "live" ? "on" : ""}" data-m="live"><b class="down">Live trading</b><small>${S.status?.live ? "Real orders on your Liquid account." : "Connect your Liquid API key in Settings first."}</small></div></div>
    </div>
    <div class="mf"><span class="dim" style="margin-right:auto;font-size:12px">Tip: backtest before going live.</span><button class="btn" id="nb-bt">Backtest first</button><button class="btn" id="nb-create">Create</button><button class="btn primary" id="nb-start">Create & start</button></div>`);
  const upd = () => { $("#nb-notional", m).value = usd((+$("#nb-budget", m).value || 0) * (+$("#nb-lev", m).value || 1), 0); };
  upd(); $("#nb-budget", m).oninput = upd; $("#nb-lev", m).oninput = upd;
  $("#nb-x", m).onclick = closeModal;
  $("#nb-strats", m).onclick = (e) => { const c = e.target.closest(".strat"); if (!c) return; strat = S.strategies.find((s) => s.key === c.dataset.k); $$(".strat", m).forEach((x) => x.classList.toggle("on", x === c)); $("#nb-params", m).innerHTML = paramFields(strat); $("#nb-iv", m).value = STRAT_DEFAULT_IV[strat.key]; };
  $$(".modeopt", m).forEach((o) => o.onclick = () => { mode = o.dataset.m; $$(".modeopt", m).forEach((x) => x.classList.toggle("on", x === o)); });
  const cfg = () => ({ strategy: strat.key, name: $("#nb-name", m).value.trim() || undefined, symbol: $("#nb-sym", m).value, interval: $("#nb-iv", m).value,
    budget: +$("#nb-budget", m).value, leverage: +$("#nb-lev", m).value, params: readParams($("#nb-params", m)), mode,
    stop_loss_pct: +$("#nb-sl", m).value || 0, take_profit_pct: +$("#nb-tp", m).value || 0, max_drawdown_pct: +$("#nb-dd", m).value || 0 });
  const create = async (start) => {
    const c = cfg();
    if (start && c.mode === "live") {
      const ok = await confirmBox("Start LIVE bot", `<p>This bot will place <b>real orders</b> with up to <b>${usd(c.budget * c.leverage, 0)}</b> notional on ${esc(c.symbol)}.</p>`, { danger: true, ok: "Start live bot", typed: "LIVE" });
      if (!ok) return; c.confirm_live = true;
    }
    c.start = start;
    const b = await guard(() => POST("bots", c));
    closeModal(); toast(`Bot "${b.name}" ${start ? "started" : "created"}`, "ok"); refreshBots(); show("bots");
  };
  $("#nb-create", m).onclick = () => create(false);
  $("#nb-start", m).onclick = () => create(true);
  $("#nb-bt", m).onclick = () => { const c = cfg(); closeModal(); show("backtest"); fillBacktest(c); runBacktest(); };
}

// ---------------------------------------------------------------- backtest
let btStrat = null, btEq = null, btPx = null, btLast = null, btFormReady = false;
function renderBacktestForm(force) {
  if (btFormReady && !force) return;
  btFormReady = true;
  btStrat = btStrat || S.strategies[0];
  $("#btform").innerHTML = `
    <div class="field"><label>Strategy</label><select class="input" id="bt-strat">${S.strategies.map((s) => `<option value="${s.key}" ${s.key === btStrat.key ? "selected" : ""}>${esc(s.label)}</option>`).join("")}</select></div>
    <div class="note" id="bt-desc" style="margin-bottom:10px">${esc(btStrat.description)}</div>
    <div class="row2"><div class="field"><label>Market</label><select class="input" id="bt-sym">${symOptions(S.symbol)}</select></div>
      <div class="field"><label>Interval</label><select class="input" id="bt-iv">${ivOptions(STRAT_DEFAULT_IV[btStrat.key])}</select></div></div>
    <div class="row3"><div class="field"><label>Bars</label><input class="input num" type="number" id="bt-bars" value="1000" min="50" max="5000"></div>
      <div class="field"><label>Budget</label><input class="input num" type="number" id="bt-budget" value="1000"></div>
      <div class="field"><label>Leverage</label><input class="input num" type="number" id="bt-lev" value="1" min="1" max="50"></div></div>
    <div class="section-t">Parameters</div><div class="row2" id="bt-params">${paramFields(btStrat)}</div>
    <div class="section-t">Risk</div>
    <div class="row3"><div class="field"><label>Stop-loss %</label><input class="input num" type="number" id="bt-sl" placeholder="off" step="any"></div>
      <div class="field"><label>Take-profit %</label><input class="input num" type="number" id="bt-tp" placeholder="off" step="any"></div>
      <div class="field"><label>Max DD %</label><input class="input num" type="number" id="bt-dd" placeholder="off" step="any"></div></div>
    <button class="btn primary block" id="bt-run" style="margin-top:6px">Run backtest</button>
    <button class="btn block" id="bt-deploy" style="margin-top:8px" disabled>Deploy as paper bot →</button>
    <p class="dim" style="font-size:11.5px;margin-top:10px" id="bt-hint">${S.status?.live ? "Uses Liquid candle history (the API serves up to 200 candles per request)." : "Uses the simulated market's history."} Fills at bar close with 0.045% fee + 0.02% slippage.</p>`;
  $("#bt-strat").onchange = (e) => { btStrat = S.strategies.find((s) => s.key === e.target.value); $("#bt-params").innerHTML = paramFields(btStrat); $("#bt-desc").textContent = btStrat.description; $("#bt-iv").value = STRAT_DEFAULT_IV[btStrat.key]; };
  $("#bt-run").onclick = runBacktest;
  $("#bt-deploy").onclick = () => { if (btLast) newBotModal({ ...btLast.cfg, mode: "paper" }); };
  if (!btEq) { btEq = new LineChart($("#bt-eq"), { empty: "Run a backtest to see the equity curve" }); btPx = new CandleChart($("#bt-price"), { count: 200 }); btPx.emptyText = "Trades will be plotted here"; btPx.draw(); }
  if (!btLast) $("#btstats").innerHTML = `<div class="stat"><div class="k">Ready</div><div class="v" style="font-size:14px;font-weight:400">Pick a strategy and hit Run.</div></div>`;
}
function fillBacktest(c) {
  btStrat = S.strategies.find((s) => s.key === c.strategy) || btStrat; renderBacktestForm(true);
  $("#bt-strat").value = btStrat.key; $("#bt-params").innerHTML = paramFields(btStrat, c.params); $("#bt-desc").textContent = btStrat.description;
  if (c.symbol) $("#bt-sym").value = c.symbol; if (c.interval) $("#bt-iv").value = c.interval;
  $("#bt-budget").value = c.budget || 1000; $("#bt-lev").value = c.leverage || 1;
  $("#bt-sl").value = c.stop_loss_pct || ""; $("#bt-tp").value = c.take_profit_pct || ""; $("#bt-dd").value = c.max_drawdown_pct || "";
}
async function runBacktest() {
  const cfg = { strategy: btStrat.key, symbol: $("#bt-sym").value, interval: $("#bt-iv").value, bars: +$("#bt-bars").value,
    budget: +$("#bt-budget").value, leverage: +$("#bt-lev").value, params: readParams($("#bt-params")),
    stop_loss_pct: +$("#bt-sl").value || 0, take_profit_pct: +$("#bt-tp").value || 0, max_drawdown_pct: +$("#bt-dd").value || 0 };
  $("#bt-run").disabled = true; $("#bt-run").textContent = "Running…";
  try {
    const r = await guard(() => POST("backtest", cfg));
    btLast = { cfg, r }; $("#bt-deploy").disabled = false;
    const stat = (k, v, s = "") => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
    $("#btstats").innerHTML = stat("Return", `<span class="${cls(r.return_pct)}">${pct(r.return_pct)}</span>`, "final " + usd(r.final_equity)) +
      stat("Buy & hold", `<span class="${cls(r.buy_hold_pct)}">${pct(r.buy_hold_pct)}</span>`, `${cfg.leverage}x exposure`) +
      stat("Max drawdown", `<span class="down">-${r.max_drawdown_pct.toFixed(2)}%</span>`, r.halted_at ? "halted by max DD" : "") +
      stat("Trades", r.trades, `${r.round_trips} closes · ${r.win_rate != null ? r.win_rate.toFixed(0) + "% win" : "no closes"}`) +
      stat("Profit factor", r.profit_factor != null ? r.profit_factor.toFixed(2) : "–", "gross win ÷ gross loss") +
      stat("Sharpe (ann.)", r.sharpe != null ? r.sharpe.toFixed(2) : "–", "fees " + usd(r.fees));
    $("#bt-range").textContent = `${r.bars} bars · ${fmtFull(r.start)} → ${fmtFull(r.end)}`;
    const c0 = r.candles[0].c, bh = r.candles.map((b) => [b.t, cfg.budget * (1 + (b.c / c0 - 1) * cfg.leverage)]);
    btEq.opts.baseline = cfg.budget;
    btEq.setSeries([{ name: "Strategy", points: r.equity_curve, color: "#6384ff", fill: "rgba(99,132,255,.25)", width: 2 }, { name: "Buy & hold", points: bh, color: "#8a93a6", dash: [4, 4], width: 1.2 }]);
    btPx.count = Math.min(r.candles.length, 400);
    const ov = [];
    const cl = r.candles.map((b) => b.c), p = cfg.params;
    if (cfg.strategy === "ma_cross") { const f = p.ma_type === "sma" ? I.sma : I.ema; ov.push({ values: f(cl, p.fast), color: "#f5b041" }, { values: f(cl, p.slow), color: "#a77bff" }); }
    if (cfg.strategy === "bollinger") { const b = I.boll(cl, p.period, p.stdev); ov.push({ values: b.m, color: "#8090ff" }, { values: b.u, color: "rgba(128,144,255,.5)" }, { values: b.l, color: "rgba(128,144,255,.5)" }); }
    const panes = cfg.strategy === "rsi" ? [{ name: `RSI ${p.period}`, range: [0, 100], levels: [p.oversold, p.overbought], series: [{ values: I.rsi(cl, p.period), color: "#f5b041" }] }] : [];
    btPx.set({ overlays: ov, panes, showVolume: false, markers: r.fills.map((f) => ({ t: f.t - (r.candles[1].t - r.candles[0].t), side: f.side })) });
    btPx.setData(r.candles, false);
    $("#bt-fills").innerHTML = r.fills.length ? `<table class="t"><tr><th>Time</th><th>Side</th><th class="n">Price</th><th class="n">Value</th><th class="n">P&L</th><th>Reason</th></tr>${r.fills.slice().reverse().slice(0, 400).map((t) => `<tr><td class="dim">${fmtFull(t.t)}</td><td class="${t.side === "buy" ? "up" : "down"}">${t.side}</td><td class="n">${fmtPrice(t.price)}</td><td class="n">${usd(t.usd)}</td><td class="n">${t.pnl ? signed(t.pnl) : "–"}</td><td class="dim">${esc(t.reason)}</td></tr>`).join("")}</table>` : `<div class="empty">The strategy never traded in this window. Try other parameters or more bars.</div>`;
  } finally { $("#bt-run").disabled = false; $("#bt-run").textContent = "Run backtest"; }
}

// ---------------------------------------------------------------- tools
function renderTools() {
  const v = $("#view-tools"); if (v.dataset.ready) return; v.dataset.ready = 1;
  const px = S.ticker?.price ? +S.ticker.price.toPrecision(6) : 100;
  v.innerHTML = `
  <div class="panel tool"><div class="panel-h">Position size calculator <span class="sub">risk-based</span></div><div class="panel-b" data-tool="size">
    <div class="row2"><div class="field"><label>Account size $</label><input class="input num" data-i="acct" value="10000"></div><div class="field"><label>Risk per trade %</label><input class="input num" data-i="risk" value="1"></div></div>
    <div class="row2"><div class="field"><label>Entry price</label><input class="input num" data-i="entry" value="${px}"></div><div class="field"><label>Stop price</label><input class="input num" data-i="stop" value="${+(px * 0.98).toPrecision(6)}"></div></div>
    <div class="result" data-o></div></div></div>
  <div class="panel tool"><div class="panel-h">Liquidation price <span class="sub">estimate</span></div><div class="panel-b" data-tool="liq">
    <div class="row2"><div class="field"><label>Entry price</label><input class="input num" data-i="entry" value="${px}"></div><div class="field"><label>Leverage</label><input class="input num" data-i="lev" value="10"></div></div>
    <div class="row2"><div class="field"><label>Side</label><select class="input" data-i="side"><option value="buy">Long</option><option value="sell">Short</option></select></div><div class="field"><label>Market max leverage</label><input class="input num" data-i="ml" value="${maxLev()}"></div></div>
    <div class="result" data-o></div></div></div>
  <div class="panel tool"><div class="panel-h">P&amp;L / target calculator</div><div class="panel-b" data-tool="pnl">
    <div class="row2"><div class="field"><label>Entry price</label><input class="input num" data-i="entry" value="${px}"></div><div class="field"><label>Exit price</label><input class="input num" data-i="exit" value="${+(px * 1.05).toPrecision(6)}"></div></div>
    <div class="row3"><div class="field"><label>Size $</label><input class="input num" data-i="size" value="1000"></div><div class="field"><label>Leverage</label><input class="input num" data-i="lev" value="5"></div><div class="field"><label>Side</label><select class="input" data-i="side"><option value="buy">Long</option><option value="sell">Short</option></select></div></div>
    <div class="result" data-o></div></div></div>
  <div class="panel tool"><div class="panel-h">Risk / reward</div><div class="panel-b" data-tool="rr">
    <div class="row3"><div class="field"><label>Entry</label><input class="input num" data-i="entry" value="${px}"></div><div class="field"><label>Stop</label><input class="input num" data-i="stop" value="${+(px * 0.97).toPrecision(6)}"></div><div class="field"><label>Target</label><input class="input num" data-i="target" value="${+(px * 1.09).toPrecision(6)}"></div></div>
    <div class="field"><label>Your win rate %</label><input class="input num" data-i="wr" value="45"></div>
    <div class="result" data-o></div></div></div>
  <div class="panel tool"><div class="panel-h">Funding cost</div><div class="panel-b" data-tool="fund">
    <div class="row3"><div class="field"><label>Position $</label><input class="input num" data-i="size" value="5000"></div><div class="field"><label>Rate / hour %</label><input class="input num" data-i="rate" value="${S.ticker ? (S.ticker.funding_rate * 100).toFixed(4) : "0.0013"}"></div><div class="field"><label>Hours held</label><input class="input num" data-i="hours" value="72"></div></div>
    <div class="result" data-o></div></div></div>
  <div class="panel tool"><div class="panel-h">Grid planner</div><div class="panel-b" data-tool="grid">
    <div class="row3"><div class="field"><label>Lower</label><input class="input num" data-i="lo" value="${+(px * 0.95).toPrecision(6)}"></div><div class="field"><label>Upper</label><input class="input num" data-i="hi" value="${+(px * 1.05).toPrecision(6)}"></div><div class="field"><label>Levels</label><input class="input num" data-i="n" value="10"></div></div>
    <div class="row2"><div class="field"><label>Budget × leverage $</label><input class="input num" data-i="cap" value="1000"></div><div class="field"><label>Fee per side %</label><input class="input num" data-i="fee" value="0.045"></div></div>
    <div class="result" data-o></div></div></div>
  <div class="panel tool"><div class="panel-h">Compounding</div><div class="panel-b" data-tool="comp">
    <div class="row3"><div class="field"><label>Start $</label><input class="input num" data-i="start" value="1000"></div><div class="field"><label>Return per period %</label><input class="input num" data-i="r" value="2"></div><div class="field"><label>Periods</label><input class="input num" data-i="n" value="52"></div></div>
    <div class="result" data-o></div></div></div>`;
  const kv = (k, val) => `<div class="kv"><span>${k}</span><span>${val}</span></div>`;
  const calc = {
    size: (x) => { const riskUsd = x.acct * x.risk / 100, dist = Math.abs(x.entry - x.stop) / x.entry; const notional = dist ? riskUsd / dist : 0;
      return `<div class="big-r">${usd(notional)}</div>${kv("Position size (coin)", x.entry ? (notional / x.entry).toPrecision(5) : "–")}${kv("Amount at risk", usd(riskUsd))}${kv("Stop distance", (dist * 100).toFixed(2) + "%")}${kv("Leverage needed", x.acct ? (notional / x.acct).toFixed(2) + "x" : "–")}`; },
    liq: (x) => { const l = liqPrice(x.entry, x.lev, x.side, x.ml); return `<div class="big-r">${fmtPrice(l)}</div>${kv("Distance", pct((l / x.entry - 1) * 100))}${kv("Initial margin", (100 / x.lev).toFixed(2) + "%")}<p class="dim" style="font-size:11px;margin:6px 0 0">Isolated-margin estimate. Cross margin uses your whole account, so real liquidation is usually further away.</p>`; },
    pnl: (x) => { const d = x.side === "buy" ? 1 : -1, ch = (x.exit / x.entry - 1) * d, pnl = x.size * ch, fees = x.size * 0.00045 * 2, margin = x.size / x.lev;
      return `<div class="big-r ${cls(pnl - fees)}">${usd(pnl - fees)}</div>${kv("Gross P&L", usd(pnl))}${kv("Fees (taker both sides)", usd(fees))}${kv("Margin used", usd(margin))}${kv("Return on margin", pct((pnl - fees) / margin * 100))}`; },
    rr: (x) => { const risk = Math.abs(x.entry - x.stop), rew = Math.abs(x.target - x.entry), rr = risk ? rew / risk : 0, w = x.wr / 100, ev = w * rr - (1 - w);
      return `<div class="big-r">1 : ${rr.toFixed(2)}</div>${kv("Break-even win rate", (100 / (1 + rr)).toFixed(1) + "%")}${kv("Expectancy per $1 risked", `<span class="${cls(ev)}">${ev.toFixed(3)}</span>`)}`; },
    fund: (x) => { const c = x.size * x.rate / 100 * x.hours; return `<div class="big-r">${usd(c)}</div>${kv("Per day", usd(x.size * x.rate / 100 * 24))}${kv("Annualized rate", (x.rate * 24 * 365).toFixed(2) + "%")}<p class="dim" style="font-size:11px;margin:6px 0 0">Positive rate: longs pay shorts. Negative: shorts pay longs.</p>`; },
    grid: (x) => { const step = (x.hi - x.lo) / (x.n - 1), lot = x.cap / (x.n - 1), stepPct = step / ((x.hi + x.lo) / 2) * 100, net = lot * (stepPct - 2 * x.fee) / 100;
      return `<div class="big-r ${cls(net)}">${usd(net)} / round trip</div>${kv("Grid step", `${fmtPrice(step)} (${stepPct.toFixed(3)}%)`)}${kv("Lot size", usd(lot))}${kv("Net per lot after fees", pct(stepPct - 2 * x.fee, 3))}${stepPct <= 2 * x.fee ? '<p class="down" style="font-size:11.5px">Grid step is smaller than fees — every round trip loses money. Use fewer levels or a wider range.</p>' : ""}`; },
    comp: (x) => { const f = x.start * Math.pow(1 + x.r / 100, x.n); return `<div class="big-r">${usd(f)}</div>${kv("Total gain", pct((f / x.start - 1) * 100, 1))}${kv("Doubling time", x.r > 0 ? (Math.log(2) / Math.log(1 + x.r / 100)).toFixed(1) + " periods" : "–")}`; },
  };
  $$("[data-tool]", v).forEach((t) => {
    const run = () => { const x = {}; $$("[data-i]", t).forEach((i) => x[i.dataset.i] = i.tagName === "SELECT" ? i.value : +i.value); try { $("[data-o]", t).innerHTML = calc[t.dataset.tool](x); } catch { $("[data-o]", t).textContent = "–"; } };
    t.addEventListener("input", run); run();
  });
}

// ---------------------------------------------------------------- settings
async function renderSettings() {
  await refreshStatus();
  const st = S.status, svc = st.service || {};
  const v = $("#view-settings");
  v.innerHTML = `
  <div class="panel"><div class="panel-h">Liquid connection <span class="r">${st.connected ? '<span class="tag running">connected</span>' : st.has_credentials ? '<span class="tag live">error</span>' : '<span class="tag">not connected</span>'}</span></div><div class="panel-b">
    ${st.error ? `<div class="note warn" style="margin-bottom:10px">${esc(st.error)}</div>` : ""}
    <p class="muted" style="margin-top:0">Create an API key and secret at <b>sdk.tryliquid.xyz</b>. ${st.keychain ? "They're stored in your macOS Keychain." : "They're stored in a private (0600) file in the app's data folder."}</p>
    ${st.has_credentials ? `<div class="kv"><span>Stored in</span><span>${esc(st.credential_store || "–")}</span></div>` : ""}
    <div class="field"><label>API key</label><input class="input" id="s-key" placeholder="lq_…" autocomplete="off"></div>
    <div class="field"><label>API secret</label><input class="input" id="s-secret" type="password" placeholder="sk_…" autocomplete="off"></div>
    <div style="display:flex;gap:8px"><button class="btn primary" id="s-save">Save & connect</button>${st.has_credentials ? '<button class="btn danger" id="s-del">Remove key</button>' : ""}</div>
    <div class="section-t">Data source</div>
    <div class="seg" id="s-src"><button data-s="simulated" class="${!st.live ? "on" : ""}">Simulated market</button><button data-s="liquid" class="${st.live ? "on" : ""}">Liquid (live)</button></div>
    <p class="dim" style="font-size:11.5px">Switching the source stops running bots. Paper bots on Liquid use real prices with simulated fills.</p>
  </div></div>

  <div class="panel"><div class="panel-h">24/7 trading <span class="r">${st.headless ? '<span class="tag running">background service</span>' : svc.running ? '<span class="tag running">service running</span>' : '<span class="tag">in-app only</span>'}</span></div><div class="panel-b">
    ${svc.mode === "boot"
      ? `<p style="margin-top:0">This Mac is set up as a <b>server</b>. The engine starts at power-on (before anyone logs in), restarts automatically after crashes, power cuts and macOS updates, and resumes your bots. Closing this window doesn't stop trading.</p>`
      : st.headless && st.platform !== "Darwin"
      ? `<p style="margin-top:0">This engine is running on a <b>server</b> under systemd. It trades 24/7 whether or not your Mac is on, restarts automatically after crashes and reboots, and resumes your bots.</p>`
      : st.headless
      ? `<p style="margin-top:0">This engine is running as a <b>background service</b>. It keeps trading when this window is closed, starts at login, restarts if it crashes, and keeps your Mac from idle-sleeping.</p>`
      : `<p style="margin-top:0">Right now the engine runs inside this window, so <b>closing the window stops your bots</b>. Turn on the background service to keep trading 24/7.</p>`}
    <div class="kv"><span>Engine uptime</span><span>${dur(st.uptime_s)}</span></div>
    <div class="kv"><span>Heartbeat</span><span class="${st.heartbeat_age_s < 5 ? "up" : "down"}">${st.heartbeat_age_s.toFixed(1)}s ago</span></div>
    <div class="kv"><span>Auto-resume bots after restart</span><span>on</span></div>
    <div class="kv"><span>Auto-reconnect to Liquid</span><span>on</span></div>
    ${svc.log ? `<div class="kv"><span>Log file</span><span style="font-size:11px">${esc(svc.log)}</span></div>` : ""}
    <div style="display:flex;gap:8px;margin-top:10px">${svc.mode === "boot" ? '<span class="note">Manage with <code>./mac_server_setup.sh --status</code> / <code>--undo</code></span>' : st.headless && st.platform !== "Darwin" ? "" : svc.supported ? (svc.installed ? '<button class="btn danger" id="s-svc-off">Turn off 24/7 service</button>' : '<button class="btn primary" id="s-svc-on">Turn on 24/7 service</button>') : '<span class="note">The launchd service is macOS-only. On a Linux server, run with <code>--headless</code> under systemd (see README).</span>'}</div>
    ${(st.headless && st.platform !== "Darwin") || svc.mode === "boot" ? "" : `<div class="note" style="margin-top:10px">Your Mac must stay powered on and online. To use it as a real server (never sleeps on power, survives power cuts and updates), run <code>./mac_server_setup.sh --at-boot</code>.  Or deploy to a cloud server with <code>./deploy/deploy.sh</code>.</div>`}
  </div></div>

  <div class="panel"><div class="panel-h">Phone alerts <span class="r">${st.notify.configured ? '<span class="tag running">on</span>' : '<span class="tag">off</span>'}</span></div><div class="panel-b">
    <p class="muted" style="margin-top:0">Get a push notification for live trades, warnings and errors — essential when the engine runs on a server. Easiest: install the free <b>ntfy</b> app, subscribe to a hard-to-guess topic, and paste <code>https://ntfy.sh/&lt;topic&gt;</code>. Discord and Slack webhooks work too.</p>
    ${st.notify.from_env ? `<div class="note" style="margin-bottom:10px">Set on the server via <code>LT_NOTIFY_URL</code> (${esc(st.notify.target)}).</div>` : `
    <div class="field"><label>Webhook URL ${st.notify.target ? `<span class="dim">current: ${esc(st.notify.target)}</span>` : ""}</label><input class="input" id="s-nurl" placeholder="https://ntfy.sh/my-secret-topic-123" autocomplete="off"></div>`}
    <div class="field"><label>Send</label><select class="input" id="s-nlevel">
      ${[["trade", "Live trades + warnings + errors"], ["warn", "Warnings + errors"], ["error", "Errors only"]].map(([v, l]) => `<option value="${v}" ${st.notify.level === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
    ${st.notify.last_error ? `<div class="note warn" style="margin-bottom:10px">Last send failed: ${esc(st.notify.last_error)}</div>` : ""}
    <div style="display:flex;gap:8px"><button class="btn" id="s-nsave">Save</button><button class="btn" id="s-ntest" ${st.notify.configured ? "" : "disabled"}>Send test</button>${st.notify.configured && !st.notify.from_env ? '<button class="btn danger" id="s-noff">Turn off</button>' : ""}</div>
  </div></div>

  <div class="panel"><div class="panel-h">Risk limits</div><div class="panel-b">
    <div class="field"><label>Max single order (USD)</label><input class="input num" type="number" id="s-maxord" value="${st.risk.max_order_usd}"></div>
    <div class="field"><label>Max total live exposure (USD, budget × leverage across live bots)</label><input class="input num" type="number" id="s-maxlive" value="${st.risk.max_total_live_usd}"></div>
    <button class="btn" id="s-risk">Save limits</button>
    <div class="section-t">Kill switch</div>
    <p class="muted" style="margin:0 0 8px">The red button in the top bar stops every bot and market-closes their positions.</p>
    ${st.kill_switch ? '<button class="btn" id="s-kreset">Reset kill switch</button>' : '<span class="tag running">armed</span>'}
  </div></div>

  <div class="panel"><div class="panel-h">About</div><div class="panel-b">
    <p style="margin-top:0"><b>Liquid Trader</b> — desktop trading for Liquid (liquid.trade) perpetuals with built-in strategies, backtesting and risk controls.</p>
    <div class="kv"><span>Data folder</span><span style="font-size:11px">${esc(st.data_dir)}</span></div>
    <div class="kv"><span>Keyboard</span><span>1–5 switch views · Esc closes</span></div>
    <div class="note warn" style="margin-top:10px">Trading leveraged perpetual futures carries a high risk of loss. Strategies and backtests are tools, not guarantees. This app talks to Liquid's API through a community-documented signing scheme — test with small sizes first.</div>
  </div></div>`;
  $("#s-save").onclick = async () => {
    const key = $("#s-key").value.trim(), secret = $("#s-secret").value.trim();
    await guard(() => POST("credentials", { key, secret })); toast("Connected to Liquid", "ok"); boot();
  };
  if ($("#s-del")) $("#s-del").onclick = async () => { if (!(await confirmBox("Remove API key?", "<p>The app switches back to the simulated market.</p>"))) return; await guard(() => DEL("credentials")); boot(); };
  $("#s-src").onclick = async (e) => { const b = e.target.closest("button"); if (!b) return; await guard(() => POST("source", { source: b.dataset.s })); boot(); };
  $("#s-risk").onclick = async () => { await guard(() => POST("risk", { max_order_usd: +$("#s-maxord").value, max_total_live_usd: +$("#s-maxlive").value })); toast("Risk limits saved", "ok"); };
  $("#s-nsave").onclick = async () => { const u = $("#s-nurl"); const body = { level: $("#s-nlevel").value }; if (u && u.value.trim()) body.url = u.value.trim(); await guard(() => POST("notify", body)); toast("Alert settings saved", "ok"); renderSettings(); };
  $("#s-ntest").onclick = async () => { await guard(() => POST("notify", { test: true })); toast("Test alert sent — check your phone", "ok"); setTimeout(renderSettings, 3000); };
  if ($("#s-noff")) $("#s-noff").onclick = async () => { await guard(() => POST("notify", { url: "", level: $("#s-nlevel").value })); renderSettings(); };
  if ($("#s-kreset")) $("#s-kreset").onclick = async () => { await guard(() => POST("killswitch/reset")); renderSettings(); };
  if ($("#s-svc-on")) $("#s-svc-on").onclick = async () => {
    if (!(await confirmBox("Turn on 24/7 trading", "<p>Liquid Trader will install a background service (launchd) that runs the engine all the time: it starts at login, restarts automatically, and prevents idle sleep.</p><p class='muted'>This window will reconnect to the service in a few seconds.</p>"))) return;
    const r = await guard(() => POST("service/install"));
    if (r.handoff) handoff(r.port); else renderSettings();
  };
  if ($("#s-svc-off")) $("#s-svc-off").onclick = async () => {
    if (!(await confirmBox("Turn off 24/7 trading", "<p>The background service is removed. Bots only run while this window is open.</p>", { danger: true, ok: "Turn off" }))) return;
    await POST("service/uninstall").catch(() => {});
    toast("Background service removed. Relaunch the app to run bots in-app.", "warn");
    setTimeout(() => location.reload(), 2500);
  };
}
function handoff(port) {
  modal(`<div class="mh"><h2>Starting 24/7 service…</h2></div><div class="mb"><p>Handing your bots over to the background engine. This takes a few seconds.</p><p class="dim" id="ho-st">Waiting…</p></div>`, { small: true });
  const target = `http://127.0.0.1:${port}/`; let n = 0;
  const poll = async () => {
    n++; $("#ho-st").textContent = `Waiting for service (${n})…`;
    try { const r = await fetch(target, { cache: "no-store" }); if (r.ok) { location.href = target; return; } } catch {}
    if (n < 60) setTimeout(poll, 1000); else $("#ho-st").textContent = "The service didn't respond. Check ~/Library/Logs/LiquidTrader.log, then relaunch the app.";
  };
  setTimeout(poll, 1500);
}

// ---------------------------------------------------------------- loops
let lostConn = 0;
async function heartbeat() {
  try { await refreshStatus(); if (lostConn) { lostConn = 0; toast("Reconnected to engine", "ok"); } }
  catch { lostConn++; }
}
async function boot() {
  await refreshStatus();
  try { S.strategies = await GET("strategies"); } catch {}
  btFormReady = false;
  await loadMarkets();
  setSymbol(S.symbol);
  refreshBots(); refreshAccount(); refreshWatch();
  if (S.view === "settings") renderSettings();
}
function every(ms, fn) { const tick = async () => { if (!document.hidden) { try { await fn(); } catch {} } setTimeout(tick, typeof ms === "function" ? ms() : ms); }; setTimeout(tick, typeof ms === "function" ? ms() : ms); }
const fast = () => (S.status?.live ? 3000 : 1000);
every(fast, () => S.view === "trade" && refreshTicker());
every(() => (S.status?.live ? 5000 : 1500), () => S.view === "trade" && refreshChart());
every(() => (S.status?.live ? 3000 : 1500), () => S.view === "trade" && refreshBook());
every(() => (S.status?.live ? 10000 : 3000), refreshWatch);
every(2500, refreshBots);
every(4000, refreshAccount);
every(3000, heartbeat);
updateTicket();
boot();
})();
