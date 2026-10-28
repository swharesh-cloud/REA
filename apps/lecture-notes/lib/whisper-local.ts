import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseWhisperTranscript, type WhisperSegment } from "./whisper-json";

export class SetupError extends Error {
  readonly status = 400;
}

function runProcess(
  bin: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    const errors: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => {
      errors.push(chunk);
    });
    const stop = () => {
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", stop);
    child.on("error", (error) => {
      signal?.removeEventListener("abort", stop);
      reject(error);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", stop);
      resolve({ code, stderr: Buffer.concat(errors).toString("utf8") });
    });
  });
}

export async function transcribeLocalWhisper(options: {
  bin: string;
  modelPath: string;
  audio: Uint8Array;
  fileName: string;
  signal?: AbortSignal;
}): Promise<{ text: string; segments: WhisperSegment[] }> {
  const directory = await mkdtemp(join(tmpdir(), "lecture-whisper-"));
  const extension = options.fileName.toLowerCase().endsWith(".mp3")
    ? "mp3"
    : "wav";
  const audioPath = join(directory, `audio.${extension}`);
  const outputBase = join(directory, "transcript");
  try {
    await writeFile(audioPath, Buffer.from(options.audio));
    let result: { code: number | null; stderr: string };
    try {
      result = await runProcess(
        options.bin,
        ["-m", options.modelPath, "-f", audioPath, "-oj", "-of", outputBase],
        options.signal,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw new SetupError(
          `Could not find ${options.bin}. On a Mac, run: brew install whisper.cpp`,
        );
      }
      throw error;
    }
    if (options.signal?.aborted) {
      throw new DOMException("Transcription was cancelled.", "AbortError");
    }
    if (result.code !== 0) {
      const detail = result.stderr.trim().slice(-400);
      throw new Error(
        detail
          ? `Local Whisper failed. ${detail}`
          : "Local Whisper failed. Check WHISPER_BIN and WHISPER_MODEL.",
      );
    }
    const raw = await readFile(`${outputBase}.json`, "utf8");
    return parseWhisperTranscript(raw);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
