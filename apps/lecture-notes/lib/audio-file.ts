import { sliceMp3 } from "./mp3-slice";
import type { WavWindow } from "./types";
import { downsample, encodeWav, mixDown, TARGET_SAMPLE_RATE } from "./wav";

function audioBlob(bytes: Uint8Array, type: string): Blob {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Blob([copy], { type });
}
const DIRECT_UPLOAD_LIMIT = 3_500_000;
const DECODE_LIMIT = 24 * 1024 * 1024;
const WINDOW_SECONDS = 20;

export async function audioFileToWindows(file: File): Promise<WavWindow[]> {
  if (file.size > DECODE_LIMIT) {
    throw new Error(
      "This file is over 24 MB. Record in the app, or split the audio before uploading.",
    );
  }
  if (file.size <= DIRECT_UPLOAD_LIMIT && !file.type.includes("wav")) {
    return [
      {
        blob: file,
        mediaType: file.type || "application/octet-stream",
        startMs: 0,
        durationMs: 0,
      },
    ];
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mp3 =
    file.type.includes("mpeg") ||
    file.type.includes("mp3") ||
    file.name.toLowerCase().endsWith(".mp3");
  if (mp3) {
    const pieces = sliceMp3(bytes, WINDOW_SECONDS);
    if (pieces) {
      return pieces.map((piece) => ({
        blob: audioBlob(piece.bytes, "audio/mpeg"),
        mediaType: "audio/mpeg",
        startMs: piece.startMs,
        durationMs: piece.durationMs,
      }));
    }
  }
  if (file.size > 8 * 1024 * 1024) {
    throw new Error(
      "This audio needs to be decoded in the browser and is too large for a phone. Use an MP3, a file under 8 MB, or record in the app.",
    );
  }
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    if (decoded.duration > 3 * 60 * 60) {
      throw new Error("Audio longer than 3 hours is not supported.");
    }
    const windows: WavWindow[] = [];
    const windowFrames = Math.max(
      1,
      Math.floor(decoded.sampleRate * WINDOW_SECONDS),
    );
    for (let start = 0; start < decoded.length; start += windowFrames) {
      const end = Math.min(decoded.length, start + windowFrames);
      const mixed = mixDown(decoded, start, end);
      const samples = downsample(mixed, decoded.sampleRate, TARGET_SAMPLE_RATE);
      windows.push({
        blob: encodeWav(samples, TARGET_SAMPLE_RATE),
        mediaType: "audio/wav",
        startMs: Math.round((start / decoded.sampleRate) * 1000),
        durationMs: Math.round(((end - start) / decoded.sampleRate) * 1000),
        samples,
      });
    }
    return windows;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Audio"))
      throw error;
    throw new Error(
      "The browser could not decode this audio. Try MP3, M4A, WAV, or WebM.",
    );
  } finally {
    await context.close();
  }
}
