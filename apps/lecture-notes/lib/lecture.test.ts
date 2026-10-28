import assert from "node:assert/strict";
import { test } from "node:test";

import { sessionToMarkdown } from "./markdown";
import { readMp3Frame, sliceMp3 } from "./mp3-slice";
import { createSampleSession } from "./sample-lecture";
import { formatClock } from "./time";
import { downsample, encodeWav, rootMeanSquare } from "./wav";

test("formats a lecture clock with hours", () => {
  assert.equal(formatClock(65_000), "00:01:05");
  assert.equal(formatClock(3_661_000), "01:01:01");
});

test("encodes 16-bit mono wav", async () => {
  const blob = encodeWav(new Float32Array([0, 1, -1]), 16_000);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(bytes.length, 44 + 6);
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...bytes.slice(8, 12)), "WAVE");
  assert.ok(rootMeanSquare(new Float32Array(8)) === 0);
  assert.equal(downsample(new Float32Array([0, 1, 0, 1]), 4, 2).length, 2);
});

test("splits mpeg layer 3 frames without decoding", () => {
  const frameLength = 417;
  const frames = new Uint8Array(frameLength * 8);
  for (let index = 0; index < 8; index += 1) {
    const offset = index * frameLength;
    frames[offset] = 0xff;
    frames[offset + 1] = 0xfb;
    frames[offset + 2] = 0x90;
  }
  assert.equal(readMp3Frame(frames, 0)?.length, frameLength);
  const pieces = sliceMp3(frames, 20);
  assert.equal(pieces?.length, 1);
  assert.equal(pieces?.[0]?.bytes.length, frames.length);
  assert.equal(sliceMp3(new Uint8Array(32)), null);
});

test("exports sample notes as markdown with timestamps", () => {
  const markdown = sessionToMarkdown(createSampleSession());
  assert.match(markdown, /^# How leaves store sunlight/u);
  assert.match(markdown, /## Questions to review/u);
  assert.match(markdown, /00:00:04/u);
  assert.match(markdown, /## Transcript/u);
});
