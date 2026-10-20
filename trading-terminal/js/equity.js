export function drawEquity(canvas, points) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const width = Math.max(1, canvas.clientWidth || 320);
  const height = Math.max(1, canvas.clientHeight || 140);
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2.5);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#10120d";
  context.fillRect(0, 0, width, height);
  if (!points.length) {
    context.fillStyle = "#b1ad9e";
    context.font = "13px sans-serif";
    context.fillText("No equity yet", 12, 24);
    return;
  }
  const values = points.map((point) => point.equity);
  let min = values[0];
  let max = values[0];
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = 10;
  const xAt = (index) => pad + (index / Math.max(values.length - 1, 1)) * (width - pad * 2);
  const yAt = (value) => height - pad - ((value - min) / (max - min)) * (height - pad * 2);
  context.beginPath();
  values.forEach((value, index) => {
    const x = xAt(index);
    const y = yAt(value);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.strokeStyle = "#e2a15a";
  context.lineWidth = 1.6;
  context.stroke();
  context.lineTo(xAt(values.length - 1), height - pad);
  context.lineTo(xAt(0), height - pad);
  context.closePath();
  context.fillStyle = "rgba(226, 161, 90, 0.16)";
  context.fill();
  if (values.length === 1) {
    context.fillStyle = "#e2a15a";
    context.beginPath();
    context.arc(xAt(0), yAt(values[0]), 3, 0, Math.PI * 2);
    context.fill();
  }
}
