// Lightweight canvas charting: candlesticks with overlays, sub-panes, markers, zoom & pan,
// plus a simple multi-series line chart for equity curves. No dependencies.
(function () {
  const C = {
    bg: "#0b0e14", grid: "rgba(255,255,255,0.045)", axis: "#6b7386", text: "#aab2c5",
    up: "#22c38e", down: "#f0506e", cross: "rgba(200,210,230,0.35)", label: "#1c2230",
  };
  const DPR = () => window.devicePixelRatio || 1;

  function niceStep(range, target) {
    const raw = range / Math.max(target, 1);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  }
  function fmtPrice(v, ref) {
    if (v == null || !isFinite(v)) return "–";
    const a = Math.abs(ref ?? v);
    const d = a >= 10000 ? 0 : a >= 100 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 5 : 7;
    return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtTime(t, spanMs) {
    const d = new Date(t);
    const pad = (x) => String(x).padStart(2, "0");
    if (spanMs >= 86400000 * 2) return `${d.toLocaleString(undefined, { month: "short" })} ${d.getDate()}`;
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtFull(t) {
    const d = new Date(t);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  class Base {
    constructor(el) {
      this.el = el;
      this.canvas = document.createElement("canvas");
      this.canvas.style.display = "block";
      el.appendChild(this.canvas);
      this.ctx = this.canvas.getContext("2d");
      this.mouse = null;
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(el);
      this.canvas.addEventListener("mousemove", (e) => {
        const r = this.canvas.getBoundingClientRect();
        this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
        this.onMove && this.onMove(e);
        this.draw();
      });
      this.canvas.addEventListener("mouseleave", () => { this.mouse = null; this.draw(); });
      this.resize();
    }
    resize() {
      const w = this.el.clientWidth, h = this.el.clientHeight;
      if (!w || !h) return;
      this.W = w; this.H = h;
      this.canvas.width = w * DPR(); this.canvas.height = h * DPR();
      this.canvas.style.width = w + "px"; this.canvas.style.height = h + "px";
      this.ctx.setTransform(DPR(), 0, 0, DPR(), 0, 0);
      this.draw();
    }
    destroy() { this.ro.disconnect(); this.canvas.remove(); }
    label(x, y, text, bg, fg = "#fff", align = "left") {
      const c = this.ctx;
      c.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
      const w = c.measureText(text).width + 8;
      const bx = align === "right" ? x - w : x;
      c.fillStyle = bg; c.fillRect(bx, y - 8, w, 16);
      c.fillStyle = fg; c.textBaseline = "middle"; c.textAlign = "left";
      c.fillText(text, bx + 4, y);
    }
  }

  // ------------------------------------------------------------------------------------------
  class CandleChart extends Base {
    constructor(el, opts = {}) {
      super(el);
      this.bars = []; this.overlays = []; this.bands = []; this.panes = []; this.markers = [];
      this.hlines = []; this.mode = opts.mode || "candle"; this.showVolume = opts.volume !== false;
      this.count = opts.count || 130; this.offset = 0; this.axisW = 74; this.timeH = 22;
      this.onHover = null;
      let drag = null;
      this.canvas.addEventListener("mousedown", (e) => { drag = { x: e.clientX, off: this.offset }; this.canvas.style.cursor = "grabbing"; });
      window.addEventListener("mouseup", () => { drag = null; this.canvas.style.cursor = "crosshair"; });
      window.addEventListener("mousemove", (e) => {
        if (!drag || !this.bars.length) return;
        const bw = (this.W - this.axisW) / this.count;
        this.offset = Math.max(0, Math.min(this.bars.length - 10, drag.off + Math.round((e.clientX - drag.x) / bw)));
        this.draw();
      });
      this.canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        const f = e.deltaY > 0 ? 1.12 : 1 / 1.12;
        this.count = Math.max(20, Math.min(Math.max(this.bars.length, 40), Math.round(this.count * f)));
        this.draw();
      }, { passive: false });
      this.canvas.addEventListener("dblclick", () => { this.offset = 0; this.count = opts.count || 130; this.draw(); });
      this.canvas.style.cursor = "crosshair";
    }
    setData(bars, keepView = true) {
      this.bars = bars || [];
      if (!keepView) { this.offset = 0; }
      this.offset = Math.min(this.offset, Math.max(0, this.bars.length - 10));
      this.draw();
    }
    set(opts) { Object.assign(this, opts); this.draw(); }
    range() {
      const n = this.bars.length;
      const end = Math.max(0, n - this.offset);
      const start = Math.max(0, end - this.count);
      return [start, end];
    }
    draw() {
      const c = this.ctx, W = this.W, H = this.H;
      if (!W || !this.bars) return;
      c.fillStyle = C.bg; c.fillRect(0, 0, W, H);
      const bars = this.bars;
      if (!bars.length) {
        c.fillStyle = C.axis; c.font = "13px -apple-system, sans-serif"; c.textAlign = "center";
        c.fillText(this.emptyText || "Loading…", W / 2, H / 2); return;
      }
      const [s, e] = this.range();
      const plotW = W - this.axisW;
      const bw = plotW / this.count;
      const paneH = this.panes.length ? Math.min(110, (H - this.timeH) * 0.22) : 0;
      const mainH = H - this.timeH - paneH * this.panes.length;
      const x = (i) => (i - (e - this.count)) * bw + bw / 2;
      // y-range of main pane
      let lo = Infinity, hi = -Infinity;
      for (let i = s; i < e; i++) { lo = Math.min(lo, bars[i].l); hi = Math.max(hi, bars[i].h); }
      for (const o of this.overlays) for (let i = s; i < e; i++) { const v = o.values[i]; if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
      for (const b of this.bands) for (let i = s; i < e; i++) { if (b.upper[i] != null) { hi = Math.max(hi, b.upper[i]); lo = Math.min(lo, b.lower[i]); } }
      for (const h of this.hlines) if (h.fit) { lo = Math.min(lo, h.price); hi = Math.max(hi, h.price); }
      const pad = (hi - lo) * 0.08 || hi * 0.01 || 1;
      lo -= pad; hi += pad;
      const volH = this.showVolume ? mainH * 0.16 : 0;
      const top = 8, bot = mainH - 4;
      const y = (v) => top + (hi - v) / (hi - lo) * (bot - top);
      this._y = y; this._x = x; this._lo = lo; this._hi = hi; this._mainH = mainH; this._bw = bw;
      // grid + price axis
      c.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
      c.textBaseline = "middle"; c.textAlign = "left";
      const step = niceStep(hi - lo, Math.max(3, mainH / 55));
      for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
        const yy = Math.round(y(v)) + 0.5;
        c.strokeStyle = C.grid; c.beginPath(); c.moveTo(0, yy); c.lineTo(plotW, yy); c.stroke();
        c.fillStyle = C.axis; c.fillText(fmtPrice(v, hi), plotW + 6, yy);
      }
      // time axis
      const span = (bars[e - 1].t - bars[s].t) || 1;
      const every = Math.max(1, Math.round(90 / bw));
      c.textAlign = "center";
      for (let i = e - 1; i >= s; i -= every) {
        const xx = Math.round(x(i)) + 0.5;
        c.strokeStyle = C.grid; c.beginPath(); c.moveTo(xx, 0); c.lineTo(xx, H - this.timeH); c.stroke();
        c.fillStyle = C.axis; c.fillText(fmtTime(bars[i].t, span), xx, H - this.timeH / 2);
      }
      c.save(); c.beginPath(); c.rect(0, 0, plotW, mainH); c.clip();
      // volume
      if (volH) {
        let vmax = 0; for (let i = s; i < e; i++) vmax = Math.max(vmax, bars[i].v || 0);
        for (let i = s; i < e; i++) {
          const b = bars[i], hgt = vmax ? (b.v / vmax) * volH : 0;
          c.fillStyle = b.c >= b.o ? "rgba(34,195,142,0.18)" : "rgba(240,80,110,0.18)";
          c.fillRect(x(i) - bw * 0.35, mainH - hgt, Math.max(1, bw * 0.7), hgt);
        }
      }
      // bands
      for (const b of this.bands) {
        c.beginPath(); let started = false;
        for (let i = s; i < e; i++) if (b.upper[i] != null) { started ? c.lineTo(x(i), y(b.upper[i])) : c.moveTo(x(i), y(b.upper[i])); started = true; }
        for (let i = e - 1; i >= s; i--) if (b.lower[i] != null) c.lineTo(x(i), y(b.lower[i]));
        c.closePath(); c.fillStyle = b.fill || "rgba(120,140,255,0.07)"; c.fill();
      }
      // series
      if (this.mode === "candle") {
        for (let i = s; i < e; i++) {
          const b = bars[i], upb = b.c >= b.o, col = upb ? C.up : C.down;
          const xx = x(i);
          c.strokeStyle = col; c.lineWidth = 1;
          c.beginPath(); c.moveTo(Math.round(xx) + 0.5, y(b.h)); c.lineTo(Math.round(xx) + 0.5, y(b.l)); c.stroke();
          const y1 = y(Math.max(b.o, b.c)), y2 = y(Math.min(b.o, b.c));
          c.fillStyle = col;
          c.fillRect(xx - bw * 0.36, y1, Math.max(1, bw * 0.72), Math.max(1, y2 - y1));
        }
      } else {
        const g = c.createLinearGradient(0, top, 0, mainH);
        g.addColorStop(0, "rgba(99,132,255,0.28)"); g.addColorStop(1, "rgba(99,132,255,0)");
        c.beginPath();
        for (let i = s; i < e; i++) i === s ? c.moveTo(x(i), y(bars[i].c)) : c.lineTo(x(i), y(bars[i].c));
        c.strokeStyle = "#6384ff"; c.lineWidth = 1.6; c.stroke();
        c.lineTo(x(e - 1), mainH); c.lineTo(x(s), mainH); c.closePath(); c.fillStyle = g; c.fill();
      }
      for (const o of this.overlays) {
        c.beginPath(); let started = false;
        for (let i = s; i < e; i++) { const v = o.values[i]; if (v == null) continue; started ? c.lineTo(x(i), y(v)) : c.moveTo(x(i), y(v)); started = true; }
        c.strokeStyle = o.color; c.lineWidth = o.width || 1.3; c.setLineDash(o.dash || []); c.stroke(); c.setLineDash([]);
      }
      c.restore();
      // horizontal lines (entries, grid levels, liquidation)
      for (const h of this.hlines) {
        if (h.price < lo || h.price > hi) continue;
        const yy = Math.round(y(h.price)) + 0.5;
        c.strokeStyle = h.color; c.setLineDash(h.dash || [4, 4]); c.lineWidth = 1;
        c.beginPath(); c.moveTo(0, yy); c.lineTo(plotW, yy); c.stroke(); c.setLineDash([]);
        if (h.label) this.label(4, yy, h.label, h.color, "#0b0e14");
        this.label(plotW, yy, fmtPrice(h.price, hi), h.color, "#0b0e14");
      }
      // trade markers
      if (this.markers.length) {
        const t0 = bars[s].t, t1 = bars[e - 1].t, step = bars.length > 1 ? bars[1].t - bars[0].t : 60000;
        for (const m of this.markers) {
          if (m.t < t0 - step || m.t > t1 + step) continue;
          let idx = s; // nearest bar
          let lo2 = s, hi2 = e - 1;
          while (lo2 <= hi2) { const mid = (lo2 + hi2) >> 1; if (bars[mid].t <= m.t) { idx = mid; lo2 = mid + 1; } else hi2 = mid - 1; }
          const xx = x(idx), buy = m.side === "buy";
          const yy = buy ? y(bars[idx].l) + 10 : y(bars[idx].h) - 10;
          c.fillStyle = buy ? C.up : C.down;
          c.beginPath();
          if (buy) { c.moveTo(xx, yy - 6); c.lineTo(xx - 5, yy + 3); c.lineTo(xx + 5, yy + 3); }
          else { c.moveTo(xx, yy + 6); c.lineTo(xx - 5, yy - 3); c.lineTo(xx + 5, yy - 3); }
          c.closePath(); c.fill();
        }
      }
      // last price
      const last = bars[bars.length - 1];
      if (this.offset === 0) {
        const yy = Math.round(y(last.c)) + 0.5, col = last.c >= last.o ? C.up : C.down;
        c.strokeStyle = col; c.setLineDash([2, 3]); c.beginPath(); c.moveTo(0, yy); c.lineTo(plotW, yy); c.stroke(); c.setLineDash([]);
        this.label(plotW, yy, fmtPrice(last.c, hi), col);
      }
      // sub-panes
      this.panes.forEach((p, k) => this.drawPane(p, mainH + k * paneH, paneH, s, e, x, plotW));
      // crosshair
      const m = this.mouse;
      let hoverIdx = e - 1;
      if (m && m.x < plotW && m.y < H - this.timeH) {
        hoverIdx = Math.max(s, Math.min(e - 1, Math.floor(m.x / bw) + (e - this.count)));
        const xx = Math.round(x(hoverIdx)) + 0.5;
        c.strokeStyle = C.cross; c.setLineDash([3, 3]);
        c.beginPath(); c.moveTo(xx, 0); c.lineTo(xx, H - this.timeH); c.moveTo(0, m.y); c.lineTo(plotW, m.y); c.stroke(); c.setLineDash([]);
        if (m.y < mainH) this.label(plotW, m.y, fmtPrice(hi - (m.y - top) / (bot - top) * (hi - lo), hi), "#3a4357");
        c.font = "11px ui-monospace, Menlo, monospace";
        const tl = fmtFull(bars[hoverIdx].t), tw = c.measureText(tl).width + 10;
        c.fillStyle = "#3a4357"; c.fillRect(xx - tw / 2, H - this.timeH + 2, tw, this.timeH - 4);
        c.fillStyle = "#fff"; c.textAlign = "center"; c.fillText(tl, xx, H - this.timeH / 2);
      }
      this.onHover && this.onHover(bars[hoverIdx], hoverIdx);
    }
    drawPane(p, top, h, s, e, x, plotW) {
      const c = this.ctx;
      c.strokeStyle = "rgba(255,255,255,0.08)"; c.beginPath(); c.moveTo(0, top + 0.5); c.lineTo(this.W, top + 0.5); c.stroke();
      let lo = p.range ? p.range[0] : Infinity, hi = p.range ? p.range[1] : -Infinity;
      if (!p.range) for (const sr of p.series) for (let i = s; i < e; i++) { const v = sr.values[i]; if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
      if (!isFinite(lo)) return;
      if (lo === hi) { lo -= 1; hi += 1; }
      const y = (v) => top + 6 + (hi - v) / (hi - lo) * (h - 12);
      c.font = "10px ui-monospace, Menlo, monospace"; c.textAlign = "left";
      for (const lv of p.levels || []) {
        const yy = Math.round(y(lv)) + 0.5;
        c.strokeStyle = "rgba(255,255,255,0.12)"; c.setLineDash([3, 3]); c.beginPath(); c.moveTo(0, yy); c.lineTo(plotW, yy); c.stroke(); c.setLineDash([]);
        c.fillStyle = C.axis; c.fillText(String(lv), plotW + 6, yy);
      }
      c.save(); c.beginPath(); c.rect(0, top, plotW, h); c.clip();
      for (const sr of p.series) {
        if (sr.type === "hist") {
          const y0 = y(0);
          for (let i = s; i < e; i++) { const v = sr.values[i]; if (v == null) continue; c.fillStyle = v >= 0 ? "rgba(34,195,142,0.5)" : "rgba(240,80,110,0.5)"; const yy = y(v); c.fillRect(x(i) - this._bw * 0.3, Math.min(y0, yy), Math.max(1, this._bw * 0.6), Math.abs(yy - y0)); }
          continue;
        }
        c.beginPath(); let st = false;
        for (let i = s; i < e; i++) { const v = sr.values[i]; if (v == null) continue; st ? c.lineTo(x(i), y(v)) : c.moveTo(x(i), y(v)); st = true; }
        c.strokeStyle = sr.color; c.lineWidth = 1.2; c.stroke();
      }
      c.restore();
      c.fillStyle = C.text; c.font = "11px -apple-system, sans-serif"; c.textAlign = "left";
      const lastV = p.series[0].values[e - 1];
      c.fillText(p.name + (lastV != null ? "  " + lastV.toFixed(2) : ""), 6, top + 12);
    }
  }

  // ------------------------------------------------------------------------------------------
  class LineChart extends Base {
    constructor(el, opts = {}) { super(el); this.series = []; this.opts = opts; this.markers = []; }
    setSeries(series) { this.series = series; this.draw(); }
    draw() {
      const c = this.ctx, W = this.W, H = this.H;
      if (!W || !this.series) return;
      c.fillStyle = this.opts.bg || C.bg; c.fillRect(0, 0, W, H);
      const all = this.series.filter((s) => s.points && s.points.length);
      if (!all.length) {
        c.fillStyle = C.axis; c.font = "12px -apple-system, sans-serif"; c.textAlign = "center";
        c.fillText(this.opts.empty || "No data yet", W / 2, H / 2); return;
      }
      const axisW = this.opts.axis === false ? 0 : 64, timeH = this.opts.axis === false ? 0 : 20;
      let t0 = Infinity, t1 = -Infinity, lo = Infinity, hi = -Infinity;
      for (const s of all) for (const [t, v] of s.points) { t0 = Math.min(t0, t); t1 = Math.max(t1, t); lo = Math.min(lo, v); hi = Math.max(hi, v); }
      if (this.opts.baseline != null) { lo = Math.min(lo, this.opts.baseline); hi = Math.max(hi, this.opts.baseline); }
      const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.01 || 1; lo -= pad; hi += pad;
      const pw = W - axisW, ph = H - timeH;
      const x = (t) => (t1 === t0 ? pw / 2 : (t - t0) / (t1 - t0) * (pw - 8) + 4);
      const y = (v) => 4 + (hi - v) / (hi - lo) * (ph - 8);
      if (axisW) {
        c.font = "10px ui-monospace, Menlo, monospace"; c.textBaseline = "middle"; c.textAlign = "left";
        const step = niceStep(hi - lo, Math.max(2, ph / 45));
        for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
          const yy = Math.round(y(v)) + 0.5; c.strokeStyle = C.grid; c.beginPath(); c.moveTo(0, yy); c.lineTo(pw, yy); c.stroke();
          c.fillStyle = C.axis; c.fillText(fmtPrice(v, hi), pw + 5, yy);
        }
        c.textAlign = "center";
        const n = Math.max(2, Math.floor(pw / 110));
        for (let k = 0; k <= n; k++) { const t = t0 + (t1 - t0) * k / n; c.fillText(fmtTime(t, t1 - t0), Math.min(Math.max(x(t), 24), pw - 24), H - 10); }
      }
      if (this.opts.baseline != null) {
        const yy = Math.round(y(this.opts.baseline)) + 0.5; c.strokeStyle = "rgba(255,255,255,0.18)"; c.setLineDash([4, 4]);
        c.beginPath(); c.moveTo(0, yy); c.lineTo(pw, yy); c.stroke(); c.setLineDash([]);
      }
      for (const s of all) {
        c.beginPath(); s.points.forEach(([t, v], i) => (i ? c.lineTo(x(t), y(v)) : c.moveTo(x(t), y(v))));
        c.strokeStyle = s.color; c.lineWidth = s.width || 1.6; c.setLineDash(s.dash || []); c.stroke(); c.setLineDash([]);
        if (s.fill) {
          const g = c.createLinearGradient(0, 0, 0, ph); g.addColorStop(0, s.fill); g.addColorStop(1, "rgba(0,0,0,0)");
          c.lineTo(x(s.points[s.points.length - 1][0]), ph); c.lineTo(x(s.points[0][0]), ph); c.closePath(); c.fillStyle = g; c.fill();
        }
      }
      const m = this.mouse;
      if (m && m.x < pw && axisW) {
        const t = t0 + (m.x - 4) / (pw - 8) * (t1 - t0);
        c.strokeStyle = C.cross; c.setLineDash([3, 3]); c.beginPath(); c.moveTo(m.x, 0); c.lineTo(m.x, ph); c.stroke(); c.setLineDash([]);
        let ty = 14; c.font = "11px ui-monospace, Menlo, monospace"; c.textAlign = "left";
        const lines = [fmtFull(t)];
        for (const s of all) {
          let best = s.points[0];
          for (const p of s.points) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
          lines.push([s.name, best[1], s.color]);
        }
        const bx = m.x + 10 > pw - 170 ? m.x - 180 : m.x + 10;
        c.fillStyle = "rgba(20,24,34,0.92)"; c.fillRect(bx, 4, 170, lines.length * 16 + 6);
        lines.forEach((l, i) => {
          if (i === 0) { c.fillStyle = C.text; c.fillText(l, bx + 6, ty); }
          else { c.fillStyle = l[2]; c.fillText(`${l[0]}: ${fmtPrice(l[1], hi)}`, bx + 6, ty); }
          ty += 16;
        });
      }
    }
  }

  // Tiny sparkline for watchlists and bot cards
  function sparkline(canvas, values, color) {
    const dpr = DPR(), w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !values || values.length < 2) return;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const c = canvas.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    let lo = Math.min(...values), hi = Math.max(...values); if (lo === hi) { lo -= 1; hi += 1; }
    c.beginPath();
    values.forEach((v, i) => { const xx = i / (values.length - 1) * w, yy = 2 + (hi - v) / (hi - lo) * (h - 4); i ? c.lineTo(xx, yy) : c.moveTo(xx, yy); });
    c.strokeStyle = color; c.lineWidth = 1.3; c.stroke();
    c.lineTo(w, h); c.lineTo(0, h); c.closePath();
    const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, color + "40"); g.addColorStop(1, color + "00");
    c.fillStyle = g; c.fill();
  }

  window.Charts = { CandleChart, LineChart, sparkline, fmtPrice, fmtFull, colors: C };
})();
