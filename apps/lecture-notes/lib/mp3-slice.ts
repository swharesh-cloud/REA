const MPEG1_L3_BITRATES = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const MPEG2_L3_BITRATES = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
];
const MPEG1_RATES = [44100, 48000, 32000];
const MPEG2_RATES = [22050, 24000, 16000];
const MPEG25_RATES = [11025, 12000, 8000];

export type Mp3Piece = {
  bytes: Uint8Array;
  startMs: number;
  durationMs: number;
};

type Frame = {
  offset: number;
  length: number;
  samples: number;
  sampleRate: number;
};

function id3Size(bytes: Uint8Array): number {
  if (bytes.length < 10) return 0;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
    return 0;
  }
  const size =
    ((bytes[6] ?? 0) & 0x7f) * 2 ** 21 +
    ((bytes[7] ?? 0) & 0x7f) * 2 ** 14 +
    ((bytes[8] ?? 0) & 0x7f) * 2 ** 7 +
    ((bytes[9] ?? 0) & 0x7f);
  return Math.min(bytes.length, 10 + size);
}

export function readMp3Frame(bytes: Uint8Array, offset: number): Frame | null {
  if (offset + 4 > bytes.length) return null;
  const first = bytes[offset] ?? 0;
  const second = bytes[offset + 1] ?? 0;
  if (first !== 0xff || (second & 0xe0) !== 0xe0) return null;
  const versionBits = (second >> 3) & 0x03;
  const layerBits = (second >> 1) & 0x03;
  if (versionBits === 1 || layerBits !== 1) return null;
  const third = bytes[offset + 2] ?? 0;
  const bitrateIndex = (third >> 4) & 0x0f;
  const sampleIndex = (third >> 2) & 0x03;
  const padding = (third >> 1) & 0x01;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3)
    return null;
  const mpeg1 = versionBits === 3;
  const bitrates = mpeg1 ? MPEG1_L3_BITRATES : MPEG2_L3_BITRATES;
  const rates =
    versionBits === 3
      ? MPEG1_RATES
      : versionBits === 2
        ? MPEG2_RATES
        : MPEG25_RATES;
  const bitrate = bitrates[bitrateIndex] ?? 0;
  const sampleRate = rates[sampleIndex] ?? 0;
  if (bitrate === 0 || sampleRate === 0) return null;
  const samples = mpeg1 ? 1152 : 576;
  const coefficient = mpeg1 ? 144 : 72;
  const length =
    Math.floor((coefficient * bitrate * 1000) / sampleRate) + padding;
  if (length < 4 || offset + length > bytes.length) return null;
  return { offset, length, samples, sampleRate };
}

export function sliceMp3(
  bytes: Uint8Array,
  windowSeconds = 20,
): Mp3Piece[] | null {
  let offset = id3Size(bytes);
  const frames: Frame[] = [];
  let scanned = 0;
  while (offset + 4 <= bytes.length && scanned < bytes.length) {
    const frame = readMp3Frame(bytes, offset);
    if (!frame) {
      offset += 1;
      scanned += 1;
      if (frames.length === 0 && scanned > 8192) return null;
      continue;
    }
    frames.push(frame);
    offset = frame.offset + frame.length;
    scanned = 0;
  }
  if (frames.length < 8) return null;
  const pieces: Mp3Piece[] = [];
  let group: Frame[] = [];
  let groupSeconds = 0;
  let elapsedMs = 0;
  const flush = () => {
    const first = group[0];
    const last = group[group.length - 1];
    if (!first || !last) return;
    const start = first.offset;
    const end = last.offset + last.length;
    pieces.push({
      bytes: bytes.subarray(start, end),
      startMs: elapsedMs,
      durationMs: Math.round(groupSeconds * 1000),
    });
    elapsedMs += Math.round(groupSeconds * 1000);
    group = [];
    groupSeconds = 0;
  };
  for (const frame of frames) {
    group.push(frame);
    groupSeconds += frame.samples / frame.sampleRate;
    if (groupSeconds >= windowSeconds) flush();
  }
  if (group.length > 0) flush();
  return pieces.length > 0 ? pieces : null;
}
