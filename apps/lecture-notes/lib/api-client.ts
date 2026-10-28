import type { LectureNotes, TranscriptSegment } from "./types";

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "error" in body) {
      const error = (body as { error?: unknown }).error;
      if (typeof error === "string" && error.trim()) return error;
    }
  } catch {
    // The body was not JSON.
  }
  return `Request failed (${response.status}).`;
}

export async function transcribeAudio(blob: Blob): Promise<{
  text: string;
  segments: { text: string; startSecond: number; endSecond: number }[];
  durationInSeconds: number | null;
}> {
  const body = new FormData();
  const extension = blob.type.includes("mpeg") ? "mp3" : "wav";
  body.set("audio", blob, `lecture.${extension}`);
  const response = await fetch("/api/transcribe", { method: "POST", body });
  if (!response.ok)
    throw new ApiError(await readError(response), response.status);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object") {
    throw new ApiError("Transcription returned an empty response.", 502);
  }
  const record = payload as {
    text?: unknown;
    segments?: unknown;
    durationInSeconds?: unknown;
  };
  const segments = Array.isArray(record.segments)
    ? record.segments.flatMap((segment) => {
        if (!segment || typeof segment !== "object") return [];
        const item = segment as {
          text?: unknown;
          startSecond?: unknown;
          endSecond?: unknown;
        };
        if (typeof item.text !== "string") return [];
        return [
          {
            text: item.text,
            startSecond:
              typeof item.startSecond === "number" ? item.startSecond : 0,
            endSecond: typeof item.endSecond === "number" ? item.endSecond : 0,
          },
        ];
      })
    : [];
  return {
    text: typeof record.text === "string" ? record.text : "",
    segments,
    durationInSeconds:
      typeof record.durationInSeconds === "number"
        ? record.durationInSeconds
        : null,
  };
}

export function segmentsFromTranscript(
  result: Awaited<ReturnType<typeof transcribeAudio>>,
  startMs: number,
  durationMs: number,
): TranscriptSegment[] {
  const pieces = result.segments.filter((segment) => segment.text.trim());
  if (pieces.length === 0) {
    const text = result.text.trim();
    if (!text) return [];
    const heard = result.durationInSeconds
      ? Math.round(result.durationInSeconds * 1000)
      : durationMs;
    return [
      {
        id: crypto.randomUUID(),
        startMs,
        endMs: startMs + heard,
        text,
      },
    ];
  }
  return pieces.map((piece) => ({
    id: crypto.randomUUID(),
    startMs: startMs + Math.round(piece.startSecond * 1000),
    endMs: startMs + Math.round(piece.endSecond * 1000),
    text: piece.text.trim(),
  }));
}

export async function requestNotes(
  segments: TranscriptSegment[],
  signal?: AbortSignal,
): Promise<LectureNotes> {
  const response = await fetch("/api/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      segments: segments.map((segment) => ({
        startMs: segment.startMs,
        text: segment.text,
        failed: segment.failed === true,
      })),
    }),
    signal,
  });
  if (!response.ok)
    throw new ApiError(await readError(response), response.status);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !("notes" in payload)) {
    throw new ApiError("Notes came back empty.", 502);
  }
  return (payload as { notes: LectureNotes }).notes;
}

export async function withRetry<T>(task: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      last = error;
      const status = error instanceof ApiError ? error.status : 0;
      const retryable =
        status === 0 || status === 408 || status === 429 || status >= 500;
      if (!retryable || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw last instanceof Error ? last : new Error("Request failed.");
}
