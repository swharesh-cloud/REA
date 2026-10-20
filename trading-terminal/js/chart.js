const UP = "#7dcea0";
const DOWN = "#e07a5f";
const GRID = "rgba(243, 240, 230, 0.07)";
const AXIS = "#c4c0b2";
const CROSS = "rgba(226, 161, 90, 0.95)";
const DRAW = "#e2a15a";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function createChart(canvas) {
  const context = canvas.getContext("2d");
  const state = {
    candles: [],
    overlays: [],
    panes: [],
    showVolume: true,
    drawings: [],
    tool: "pan",
    draft: null,
    candleWidth: 7,
    rightIndex: 0,
    pinned: true,
    pointers: new Map(),
    drag: null,
    pinch: null,
    cursor: null,
    width: 1,
    height: 1,
    dpr: 1,
    onCursor: null,
    onCommit: null,
    onDelete: null,
    onView: null,
    disposed: false,
  };
  let frame = 0;
  let lastPinned = true;

  function schedule() {
    if (state.disposed || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  }

  function resize() {
    const parent = canvas.parentElement ?? canvas;
    const rect = parent.getBoundingClientRect();
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2.5);
    state.width = Math.max(1, Math.floor(rect.width));
    state.height = Math.max(1, Math.floor(rect.height));
    state.dpr = dpr;
    canvas.width = Math.floor(state.width * dpr);
    canvas.height = Math.floor(state.height * dpr);
    schedule();
  }

  function computeBox() {
    const width = state.width;
    const height = state.height;
    const axisWidth = 62;
    const timeHeight = 22;
    const top = 4;
    const plotLeft = 0;
    const plotRight = Math.max(48, width - axisWidth);
    const available = Math.max(40, height - timeHeight - top);
    const paneCount = state.panes.length;
    let volumeHeight = state.showVolume ? Math.round(Math.min(64, available * 0.16)) : 0;
    let paneHeight = paneCount ? Math.round(Math.min(86, available * 0.2)) : 0;
    let priceHeight = available - volumeHeight - paneHeight * paneCount;
    if (priceHeight < 80) {
      const scale = Math.max(0.4, (available - 80) / Math.max(1, volumeHeight + paneHeight * paneCount));
      volumeHeight = Math.round(volumeHeight * scale);
      paneHeight = Math.round(paneHeight * scale);
      priceHeight = available - volumeHeight - paneHeight * paneCount;
    }
    const priceTop = top;
    const priceBottom = priceTop + priceHeight;
    let cursor = priceBottom;
    const volume = state.showVolume
      ? { top: cursor, bottom: cursor + volumeHeight, height: volumeHeight }
      : null;
    if (volume) cursor = volume.bottom;
    const panes = state.panes.map((pane) => {
      const box = { ...pane, top: cursor, bottom: cursor + paneHeight, height: paneHeight };
      cursor += paneHeight;
      return box;
    });
    return {
      plotLeft,
      plotRight,
      plotWidth: plotRight - plotLeft,
      priceTop,
      priceBottom,
      priceHeight,
      volume,
      panes,
      timeTop: height - timeHeight,
      width,
      height,
    };
  }

  function indexToX(index, box) {
    return box.plotRight - (state.rightIndex - index) * state.candleWidth;
  }

  function xToIndex(x, box) {
    return state.rightIndex - (box.plotRight - x) / state.candleWidth;
  }

  function visibleIndexes(box) {
    const count = state.candles.length;
    if (!count) return { start: 0, end: -1 };
    const start = clamp(Math.floor(xToIndex(box.plotLeft, box)) - 1, 0, count - 1);
    const end = clamp(Math.ceil(xToIndex(box.plotRight, box)) + 1, 0, count - 1);
    return { start, end };
  }

  function clampView(box) {
    const count = state.candles.length;
    if (!count) return;
    const visible = box.plotWidth / state.candleWidth;
    const maxRight = count - 1 + Math.min(3, visible * 0.25);
    if (visible >= count + 2) {
      state.rightIndex = maxRight;
      state.pinned = true;
      return;
    }
    const minRight = Math.max(0, visible - 2);
    state.rightIndex = clamp(state.rightIndex, Math.min(minRight, maxRight), maxRight);
    state.pinned = state.rightIndex >= maxRight - 0.4;
  }

  function pin() {
    const box = computeBox();
    const count = state.candles.length;
    const visible = box.plotWidth / state.candleWidth;
    state.rightIndex = count ? count - 1 + Math.min(3, visible * 0.25) : 0;
    state.pinned = true;
    notifyPin();
    schedule();
  }

  function notifyPin() {
    if (lastPinned !== state.pinned) {
      lastPinned = state.pinned;
      state.onView?.({ pinned: state.pinned });
    }
  }

  function priceExtent(range) {
    let min = Infinity;
    let max = -Infinity;
    const consider = (value) => {
      if (!finite(value)) return;
      if (value < min) min = value;
      if (value > max) max = value;
    };
    for (let index = range.start; index <= range.end; index += 1) {
      const candle = state.candles[index];
      consider(candle.low);
      consider(candle.high);
      for (const overlay of state.overlays) consider(overlay.values[index]);
    }
    for (const drawing of state.drawings) {
      if (drawing.type === "hline") consider(drawing.price);
      if (drawing.type === "trend") {
        consider(drawing.a.price);
        consider(drawing.b.price);
      }
    }
    if (!finite(min) || !finite(max)) return { min: 0, max: 1 };
    if (min === max) {
      const pad = Math.abs(min) * 0.02 || 1;
      return { min: min - pad, max: max + pad };
    }
    const pad = (max - min) * 0.08;
    return { min: min - pad, max: max + pad };
  }

  function yFor(scale, top, bottom, value) {
    const span = scale.max - scale.min || 1;
    const ratio = (value - scale.min) / span;
    return bottom - ratio * (bottom - top);
  }

  function priceAt(scale, top, bottom, y) {
    const span = scale.max - scale.min || 1;
    const ratio = (bottom - y) / (bottom - top || 1);
    return scale.min + ratio * span;
  }

  function timeAt(index) {
    const candles = state.candles;
    if (!candles.length) return null;
    if (index <= 0) return candles[0].time;
    if (index >= candles.length - 1) return candles[candles.length - 1].time;
    const left = Math.floor(index);
    const right = Math.min(candles.length - 1, left + 1);
    const fraction = index - left;
    return candles[left].time + (candles[right].time - candles[left].time) * fraction;
  }

  function indexAtTime(time) {
    const candles = state.candles;
    if (!candles.length) return null;
    if (time <= candles[0].time) return 0;
    if (time >= candles[candles.length - 1].time) return candles.length - 1;
    let low = 0;
    let high = candles.length - 1;
    while (low + 1 < high) {
      const mid = (low + high) >> 1;
      if (candles[mid].time <= time) low = mid;
      else high = mid;
    }
    const span = candles[high].time - candles[low].time;
    if (span === 0) return low;
    return low + (time - candles[low].time) / span;
  }

  function seriesExtent(pane, range) {
    if (pane.fixed) return pane.fixed;
    let min = Infinity;
    let max = -Infinity;
    const consider = (values) => {
      for (let index = range.start; index <= range.end; index += 1) {
        const value = values?.[index];
        if (!finite(value)) continue;
        if (value < min) min = value;
        if (value > max) max = value;
      }
    };
    for (const line of pane.lines ?? []) consider(line.values);
    for (const histogram of pane.histograms ?? []) consider(histogram.values);
    if (!finite(min) || !finite(max)) return { min: 0, max: 1 };
    if (min === max) return { min: min - 1, max: max + 1 };
    const pad = (max - min) * 0.12;
    return { min: min - pad, max: max + pad };
  }

  function drawSeries(values, color, scale, top, bottom, box, range, dashed) {
    context.save();
    context.beginPath();
    context.rect(box.plotLeft, top, box.plotWidth, Math.max(1, bottom - top));
    context.clip();
    context.beginPath();
    context.strokeStyle = color;
    context.lineWidth = 1.4;
    if (dashed) context.setLineDash([4, 3]);
    let drawing = false;
    for (let index = range.start; index <= range.end; index += 1) {
      const value = values?.[index];
      if (!finite(value)) {
        drawing = false;
        continue;
      }
      const x = indexToX(index, box);
      const y = yFor(scale, top, bottom, value);
      if (!drawing) {
        context.moveTo(x, y);
        drawing = true;
      } else context.lineTo(x, y);
    }
    context.stroke();
    context.restore();
  }

  function drawCandles(box, range, scale) {
    const bodyWidth = Math.max(1, state.candleWidth * 0.68);
    context.save();
    context.beginPath();
    context.rect(box.plotLeft, box.priceTop, box.plotWidth, box.priceHeight);
    context.clip();
    context.lineWidth = 1;
    for (let index = range.start; index <= range.end; index += 1) {
      const candle = state.candles[index];
      const up = candle.close >= candle.open;
      const color = up ? UP : DOWN;
      const x = indexToX(index, box);
      context.strokeStyle = color;
      context.fillStyle = color;
      context.beginPath();
      context.moveTo(x, yFor(scale, box.priceTop, box.priceBottom, candle.high));
      context.lineTo(x, yFor(scale, box.priceTop, box.priceBottom, candle.low));
      context.stroke();
      const openY = yFor(scale, box.priceTop, box.priceBottom, candle.open);
      const closeY = yFor(scale, box.priceTop, box.priceBottom, candle.close);
      const top = Math.min(openY, closeY);
      const height = Math.max(1, Math.abs(closeY - openY));
      context.fillRect(x - bodyWidth / 2, top, bodyWidth, height);
    }
    context.restore();
  }

  function drawVolume(box, range) {
    if (!box.volume) return;
    let maxVolume = 0;
    for (let index = range.start; index <= range.end; index += 1) {
      maxVolume = Math.max(maxVolume, state.candles[index].volume || 0);
    }
    if (!(maxVolume > 0)) return;
    const bodyWidth = Math.max(1, state.candleWidth * 0.68);
    context.save();
    context.beginPath();
    context.rect(box.plotLeft, box.volume.top, box.plotWidth, box.volume.height);
    context.clip();
    for (let index = range.start; index <= range.end; index += 1) {
      const candle = state.candles[index];
      const height = (candle.volume / maxVolume) * (box.volume.height - 2);
      context.fillStyle = candle.close >= candle.open ? "rgba(125, 206, 160, 0.75)" : "rgba(224, 122, 95, 0.75)";
      const x = indexToX(index, box);
      context.fillRect(x - bodyWidth / 2, box.volume.bottom - height, bodyWidth, height);
    }
    context.restore();
  }

  function drawPanes(box, range) {
    for (const pane of box.panes) {
      const scale = seriesExtent(pane, range);
      context.save();
      context.strokeStyle = GRID;
      context.beginPath();
      context.moveTo(box.plotLeft, pane.top);
      context.lineTo(box.plotRight, pane.top);
      context.stroke();
      for (const guide of pane.guides ?? []) {
        if (!finite(guide)) continue;
        const y = yFor(scale, pane.top + 2, pane.bottom - 2, guide);
        context.setLineDash([3, 3]);
        context.strokeStyle = "rgba(196, 192, 178, 0.35)";
        context.beginPath();
        context.moveTo(box.plotLeft, y);
        context.lineTo(box.plotRight, y);
        context.stroke();
        context.setLineDash([]);
      }
      context.restore();
      const bodyWidth = Math.max(1, state.candleWidth * 0.68);
      for (const histogram of pane.histograms ?? []) {
        context.save();
        context.beginPath();
        context.rect(box.plotLeft, pane.top, box.plotWidth, pane.height);
        context.clip();
        for (let index = range.start; index <= range.end; index += 1) {
          const value = histogram.values?.[index];
          if (!finite(value)) continue;
          const y = yFor(scale, pane.top + 2, pane.bottom - 2, value);
          const zero = yFor(scale, pane.top + 2, pane.bottom - 2, 0);
          const top = Math.min(y, zero);
          context.fillStyle = value >= 0 ? histogram.up : histogram.down;
          context.fillRect(indexToX(index, box) - bodyWidth / 2, top, bodyWidth, Math.max(1, Math.abs(y - zero)));
        }
        context.restore();
      }
      for (const line of pane.lines ?? []) {
        drawSeries(line.values, line.color, scale, pane.top + 2, pane.bottom - 2, box, range, line.dashed);
      }
      context.fillStyle = AXIS;
      context.font = "11px sans-serif";
      context.textAlign = "left";
      context.fillText(formatAxis(scale.max), box.plotRight + 6, pane.top + 12);
      context.fillText(formatAxis(scale.min), box.plotRight + 6, pane.bottom - 4);
    }
  }

  function formatAxis(value) {
    if (!finite(value)) return "";
    const absolute = Math.abs(value);
    if (absolute >= 1000) return value.toFixed(0);
    if (absolute >= 10) return value.toFixed(2);
    if (absolute >= 1) return value.toFixed(3);
    return value.toFixed(4);
  }

  function drawGrid(box, scale) {
    context.save();
    context.strokeStyle = GRID;
    context.fillStyle = AXIS;
    context.font = "11px sans-serif";
    context.textAlign = "left";
    const steps = 4;
    for (let step = 0; step <= steps; step += 1) {
      const value = scale.min + ((scale.max - scale.min) * step) / steps;
      const y = yFor(scale, box.priceTop, box.priceBottom, value);
      context.beginPath();
      context.moveTo(box.plotLeft, y);
      context.lineTo(box.plotRight, y);
      context.stroke();
      context.fillText(formatAxis(value), box.plotRight + 6, y + 4);
    }
    context.restore();
  }

  function drawTimeAxis(box, range) {
    context.fillStyle = AXIS;
    context.font = "11px sans-serif";
    context.textAlign = "center";
    const count = Math.max(1, Math.floor(box.plotWidth / 84));
    for (let step = 0; step < count; step += 1) {
      const index = Math.round(range.start + ((range.end - range.start) * step) / Math.max(1, count - 1));
      const candle = state.candles[index];
      if (!candle) continue;
      const x = indexToX(index, box);
      context.fillText(shortTime(candle.time), x, box.height - 6);
    }
  }

  function shortTime(time) {
    const date = new Date(time);
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const hours = String(date.getUTCHours()).padStart(2, "0");
    const minutes = String(date.getUTCMinutes()).padStart(2, "0");
    if (state.timeframe === "1d" || state.timeframe === "1w") return `${month}/${day}`;
    return `${month}/${day} ${hours}:${minutes}`;
  }

  function drawDrawings(box, scale) {
    context.save();
    context.beginPath();
    context.rect(box.plotLeft, box.priceTop, box.plotWidth, box.priceHeight);
    context.clip();
    context.strokeStyle = DRAW;
    context.fillStyle = DRAW;
    context.lineWidth = 1.6;
    for (const drawing of state.drawings) {
      if (drawing.type === "hline") {
        const y = yFor(scale, box.priceTop, box.priceBottom, drawing.price);
        context.beginPath();
        context.moveTo(box.plotLeft, y);
        context.lineTo(box.plotRight, y);
        context.stroke();
      } else if (drawing.type === "trend") {
        const start = indexAtTime(drawing.a.time);
        const end = indexAtTime(drawing.b.time);
        if (start == null || end == null) continue;
        context.beginPath();
        context.moveTo(indexToX(start, box), yFor(scale, box.priceTop, box.priceBottom, drawing.a.price));
        context.lineTo(indexToX(end, box), yFor(scale, box.priceTop, box.priceBottom, drawing.b.price));
        context.stroke();
      }
    }
    if (state.draft && state.cursor) {
      const start = indexAtTime(state.draft.time);
      if (start != null) {
        context.setLineDash([4, 3]);
        context.beginPath();
        context.moveTo(indexToX(start, box), yFor(scale, box.priceTop, box.priceBottom, state.draft.price));
        context.lineTo(state.cursor.x, state.cursor.y);
        context.stroke();
      }
    }
    context.restore();
  }

  function drawCrosshair(box, scale) {
    if (!state.cursor) return;
    const { x, y } = state.cursor;
    if (x < box.plotLeft || x > box.plotRight || y < box.priceTop || y > box.priceBottom) return;
    context.save();
    context.strokeStyle = CROSS;
    context.setLineDash([3, 3]);
    context.beginPath();
    context.moveTo(x, box.priceTop);
    context.lineTo(x, box.timeTop);
    context.moveTo(box.plotLeft, y);
    context.lineTo(box.plotRight, y);
    context.stroke();
    context.setLineDash([]);
    const price = priceAt(scale, box.priceTop, box.priceBottom, y);
    context.fillStyle = "#e2a15a";
    context.fillRect(box.plotRight, y - 8, box.width - box.plotRight, 16);
    context.fillStyle = "#2a1c0c";
    context.font = "11px sans-serif";
    context.textAlign = "left";
    context.fillText(formatAxis(price), box.plotRight + 4, y + 4);
    context.restore();
  }

  function draw() {
    if (!context) return;
    context.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    context.clearRect(0, 0, state.width, state.height);
    context.fillStyle = "#141611";
    context.fillRect(0, 0, state.width, state.height);
    const box = computeBox();
    clampView(box);
    notifyPin();
    if (!state.candles.length) {
      context.fillStyle = AXIS;
      context.font = "14px sans-serif";
      context.fillText("No candles in this window.", 16, 32);
      return;
    }
    const range = visibleIndexes(box);
    const scale = priceExtent(range);
    drawGrid(box, scale);
    for (const overlay of state.overlays) {
      drawSeries(
        overlay.values,
        overlay.color,
        scale,
        box.priceTop,
        box.priceBottom,
        box,
        range,
        overlay.dashed,
      );
    }
    drawCandles(box, range, scale);
    drawVolume(box, range);
    drawPanes(box, range);
    drawDrawings(box, scale);
    drawTimeAxis(box, range);
    drawCrosshair(box, scale);
    state.lastView = { box, scale, range };
  }

  function localPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function emitCursor() {
    if (!state.onCursor) return;
    const view = state.lastView;
    if (!state.cursor || !view || !state.candles.length) {
      state.onCursor(null);
      return;
    }
    const index = Math.round(xToIndex(state.cursor.x, view.box));
    if (index < 0 || index >= state.candles.length) {
      state.onCursor(null);
      return;
    }
    state.onCursor({ index, candle: state.candles[index] });
  }

  function zoomAt(nextWidth, anchorX) {
    const box = computeBox();
    const index = xToIndex(anchorX, box);
    state.candleWidth = clamp(nextWidth, 2.5, 32);
    state.rightIndex = index + (box.plotRight - anchorX) / state.candleWidth;
    clampView(box);
    notifyPin();
    schedule();
  }

  function hitTest(x, y) {
    const view = state.lastView;
    if (!view) return null;
    const { box, scale } = view;
    let best = null;
    let bestDistance = 10;
    for (const drawing of state.drawings) {
      if (drawing.type === "hline") {
        const lineY = yFor(scale, box.priceTop, box.priceBottom, drawing.price);
        const distance = Math.abs(y - lineY);
        if (distance < bestDistance) {
          best = drawing.id;
          bestDistance = distance;
        }
      } else if (drawing.type === "trend") {
        const startIndex = indexAtTime(drawing.a.time);
        const endIndex = indexAtTime(drawing.b.time);
        if (startIndex == null || endIndex == null) continue;
        const x1 = indexToX(startIndex, box);
        const y1 = yFor(scale, box.priceTop, box.priceBottom, drawing.a.price);
        const x2 = indexToX(endIndex, box);
        const y2 = yFor(scale, box.priceTop, box.priceBottom, drawing.b.price);
        const distance = segmentDistance(x, y, x1, y1, x2, y2);
        if (distance < bestDistance) {
          best = drawing.id;
          bestDistance = distance;
        }
      }
    }
    return best;
  }

  function place(point) {
    const box = computeBox();
    const scale = state.lastView?.scale ?? priceExtent(visibleIndexes(box));
    if (point.x < box.plotLeft || point.x > box.plotRight) return;
    if (point.y < box.priceTop || point.y > box.priceBottom) return;
    const price = priceAt(scale, box.priceTop, box.priceBottom, point.y);
    const time = timeAt(xToIndex(point.x, box));
    if (!finite(price) || !finite(time)) return;
    if (state.tool === "hline") {
      state.onCommit?.({ type: "hline", price });
      return;
    }
    if (state.tool === "trend") {
      if (!state.draft) state.draft = { time, price };
      else {
        state.onCommit?.({
          type: "trend",
          a: { time: state.draft.time, price: state.draft.price },
          b: { time, price },
        });
        state.draft = null;
      }
      schedule();
      return;
    }
    if (state.tool === "erase") {
      const id = hitTest(point.x, point.y);
      if (id) state.onDelete?.(id);
    }
  }

  function onPointerDown(event) {
    canvas.setPointerCapture?.(event.pointerId);
    const point = localPoint(event);
    state.pointers.set(event.pointerId, point);
    state.cursor = point;
    if (state.pointers.size === 2) {
      const [first, second] = [...state.pointers.values()];
      state.pinch = {
        distance: Math.hypot(first.x - second.x, first.y - second.y) || 1,
        width: state.candleWidth,
        mid: (first.x + second.x) / 2,
      };
      state.drag = null;
      return;
    }
    if (state.tool === "pan") {
      state.drag = { x: point.x, rightIndex: state.rightIndex, moved: false };
    } else {
      state.drag = { x: point.x, y: point.y, moved: false };
    }
  }

  function onPointerMove(event) {
    const point = localPoint(event);
    if (state.pointers.has(event.pointerId)) state.pointers.set(event.pointerId, point);
    state.cursor = point;
    if (state.pointers.size >= 2 && state.pinch) {
      const [first, second] = [...state.pointers.values()];
      const distance = Math.hypot(first.x - second.x, first.y - second.y) || 1;
      zoomAt(state.pinch.width * (distance / state.pinch.distance), state.pinch.mid);
      return;
    }
    if (state.drag && state.tool === "pan" && state.pointers.size === 1) {
      const dx = point.x - state.drag.x;
      if (Math.abs(dx) > 3) state.drag.moved = true;
      state.rightIndex = state.drag.rightIndex - dx / state.candleWidth;
      clampView(computeBox());
      notifyPin();
    } else if (state.drag) {
      if (Math.hypot(point.x - state.drag.x, point.y - state.drag.y) > 6) state.drag.moved = true;
    }
    emitCursor();
    schedule();
  }

  function onPointerUp(event) {
    const point = localPoint(event);
    const drag = state.drag;
    state.pointers.delete(event.pointerId);
    if (state.pointers.size < 2) state.pinch = null;
    state.drag = null;
    if (state.tool !== "pan" && drag && !drag.moved && state.pointers.size === 0) place(point);
    emitCursor();
    schedule();
  }

  function onWheel(event) {
    event.preventDefault();
    const point = localPoint(event);
    const factor = event.deltaY > 0 ? 0.9 : 1.12;
    zoomAt(state.candleWidth * factor, point.x);
  }

  function onKey(event) {
    const box = computeBox();
    const anchor = box.plotRight - 24;
    if (event.key === "+" || event.key === "=") zoomAt(state.candleWidth * 1.15, anchor);
    else if (event.key === "-" || event.key === "_") zoomAt(state.candleWidth / 1.15, anchor);
    else if (event.key === "ArrowLeft") {
      state.rightIndex -= 4;
      clampView(box);
      notifyPin();
      schedule();
    } else if (event.key === "ArrowRight") {
      state.rightIndex += 4;
      clampView(box);
      notifyPin();
      schedule();
    } else if (event.key === "Home") pin();
    else return;
    event.preventDefault();
  }

  function onLeave() {
    state.cursor = null;
    state.onCursor?.(null);
    schedule();
  }

  const observer = new ResizeObserver(() => resize());
  observer.observe(canvas.parentElement ?? canvas);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("keydown", onKey);
  canvas.addEventListener("pointerleave", onLeave);
  resize();

  return {
    resize,
    pin,
    setTimeframe(timeframe) {
      state.timeframe = timeframe;
      schedule();
    },
    setCandles(candles, { indexShift = 0 } = {}) {
      const follow = state.pinned || state.candles.length === 0;
      state.candles = candles;
      if (follow) pin();
      else {
        state.rightIndex -= indexShift;
        clampView(computeBox());
        notifyPin();
        schedule();
      }
    },
    setSeries({ overlays = [], panes = [], showVolume = true } = {}) {
      state.overlays = overlays;
      state.panes = panes;
      state.showVolume = showVolume;
      schedule();
    },
    setDrawings(drawings) {
      state.drawings = drawings;
      schedule();
    },
    setTool(tool) {
      state.tool = tool;
      if (tool !== "trend") state.draft = null;
      schedule();
    },
    setOnCursor(listener) {
      state.onCursor = listener;
    },
    setOnCommit(listener) {
      state.onCommit = listener;
    },
    setOnDelete(listener) {
      state.onDelete = listener;
    },
    setOnView(listener) {
      state.onView = listener;
    },
    destroy() {
      state.disposed = true;
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("keydown", onKey);
      canvas.removeEventListener("pointerleave", onLeave);
    },
  };
}

function segmentDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(px - x1, py - y1);
  const t = clamp((px - x1) * dx + (py - y1) * dy, 0, lengthSquared) / lengthSquared;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
