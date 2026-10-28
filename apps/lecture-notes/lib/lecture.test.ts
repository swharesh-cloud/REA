import assert from "node:assert/strict";
import { test } from "node:test";

import { sessionToMarkdown } from "./markdown";
import { readMp3Frame, sliceMp3 } from "./mp3-slice";
import { createSampleSession } from "./sample-lecture";
import { readSettings } from "./settings";
import { formatClock } from "./time";
import { downsample, encodeWav, rootMeanSquare } from "./wav";
import { parseWhisperTranscript } from "./whisper-json";
import { cleanNotes, parseNotesJson } from "./clean-notes";

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

test("defaults to free local Whisper and Ollama", () => {
  const settings = readSettings({});
  assert.equal(settings.transcribeProvider, "local");
  assert.equal(settings.notesProvider, "ollama");
  assert.equal(settings.whisperBin, "whisper-cli");
  assert.equal(settings.ollamaModel, "llama3.2");
  assert.equal(settings.openaiTranscribeModel, "whisper-1");
  assert.equal(settings.openaiNotesModel, "gpt-4o-mini");
  assert.match(settings.whisperModel, /ggml-base\.en\.bin$/u);
});

test("rejects an unknown provider instead of calling a paid API", () => {
  assert.throws(
    () => readSettings({ TRANSCRIBE_PROVIDER: "gateway" }),
    /TRANSCRIBE_PROVIDER must be local or openai/u,
  );
  assert.equal(
    readSettings({ TRANSCRIBE_PROVIDER: "openai", NOTES_PROVIDER: "openai" })
      .transcribeProvider,
    "openai",
  );
});

test("reads whisper.cpp json offsets as transcript segments", () => {
  const parsed = parseWhisperTranscript(
    JSON.stringify({
      transcription: [
        {
          offsets: { from: 1200, to: 4500 },
          text: " Chlorophyll reflects green.",
        },
      ],
    }),
  );
  assert.equal(parsed.segments[0]?.startSecond, 1.2);
  assert.equal(parsed.segments[0]?.endSecond, 4.5);
  assert.equal(parsed.text, "Chlorophyll reflects green.");
});

test("cleans notes json that a small local model might wrap in text", () => {
  const notes = cleanNotes(
    parseNotesJson(
      'Here are the notes:\n{"title":"Leaves","summary":"Light becomes sugar.","keyPoints":[{"text":"Green is reflected","timestampMs":"22000"}],"sections":[],"terms":[],"actionItems":[],"questions":[]}',
    ),
  );
  assert.equal(notes.title, "Leaves");
  assert.equal(notes.keyPoints[0]?.timestampMs, 22000);
});
