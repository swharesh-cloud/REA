import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dirname, "..", "icons");
mkdirSync(root, { recursive: true });

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length - 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, pixels) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    pixels.copy(raw, row + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function draw(size) {
  const pixels = Buffer.alloc(size * size * 4, 0);
  const set = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const index = (y * size + x) * 4;
    pixels[index] = r;
    pixels[index + 1] = g;
    pixels[index + 2] = b;
    pixels[index + 3] = 255;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) set(x, y, 20, 22, 17);
  }
  const candles = [
    { x: 0.32, open: 0.62, close: 0.42, high: 0.3, low: 0.74, color: [143, 212, 170] },
    { x: 0.5, open: 0.46, close: 0.68, high: 0.34, low: 0.78, color: [229, 137, 111] },
    { x: 0.68, open: 0.6, close: 0.28, high: 0.2, low: 0.68, color: [226, 161, 90] },
  ];
  const body = Math.max(2, Math.round(size * 0.07));
  const wick = Math.max(1, Math.round(size * 0.015));
  for (const candle of candles) {
    const center = Math.round(candle.x * size);
    const y = (fraction) => Math.round(fraction * size);
    const top = y(Math.min(candle.open, candle.close));
    const bottom = y(Math.max(candle.open, candle.close));
    for (let py = y(candle.high); py <= y(candle.low); py += 1) {
      for (let px = center - wick; px <= center + wick; px += 1) set(px, py, ...candle.color);
    }
    for (let py = top; py <= bottom; py += 1) {
      for (let px = center - body; px <= center + body; px += 1) set(px, py, ...candle.color);
    }
  }
  return pixels;
}

for (const size of [180, 192, 512]) {
  writeFileSync(join(root, `icon-${size}.png`), png(size, draw(size)));
}
process.stdout.write(`Wrote icons in ${dirname(join(root, "icon-192.png"))}\n`);
