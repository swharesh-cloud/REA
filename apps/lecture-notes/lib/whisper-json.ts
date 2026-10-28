export type WhisperSegment = {
  text: string;
  startSecond: number;
  endSecond: number;
};

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    value.trim() &&
    Number.isFinite(Number(value))
  ) {
    return Number(value);
  }
  return null;
}

function clockToSeconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+):(\d+):(\d+)[,.](\d+)$/u.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const fraction = Number(match[4]);
  const width = match[4]?.length ?? 3;
  return hours * 3600 + minutes * 60 + seconds + fraction / 10 ** width;
}

export function parseWhisperTranscript(raw: string): {
  text: string;
  segments: WhisperSegment[];
} {
  const parsed: unknown = JSON.parse(raw);
  const transcription =
    parsed && typeof parsed === "object"
      ? (parsed as { transcription?: unknown }).transcription
      : undefined;
  if (!Array.isArray(transcription)) return { text: "", segments: [] };
  const segments = transcription.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as {
      text?: unknown;
      offsets?: { from?: unknown; to?: unknown };
      timestamps?: { from?: unknown; to?: unknown };
    };
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!text) return [];
    const fromMs = asNumber(record.offsets?.from);
    const toMs = asNumber(record.offsets?.to);
    const startSecond =
      fromMs === null
        ? (clockToSeconds(record.timestamps?.from) ?? 0)
        : fromMs / 1000;
    const endSecond =
      toMs === null
        ? (clockToSeconds(record.timestamps?.to) ?? startSecond)
        : toMs / 1000;
    return [{ text, startSecond, endSecond }];
  });
  return {
    text: segments.map((segment) => segment.text).join(" "),
    segments,
  };
}
