import { z } from "zod";

const point = z.object({
  text: z.string().describe("One concise note sentence."),
  timestampMs: z
    .number()
    .nullable()
    .describe("Exact start millisecond copied from a transcript cue, or null."),
});

export const notesSchema = z.object({
  title: z.string().describe("Specific lecture title, not the word Lecture."),
  summary: z.string().describe("Two to four sentences a student can reread."),
  keyPoints: z.array(point).describe("Ideas worth remembering."),
  sections: z
    .array(
      z.object({
        heading: z.string(),
        timestampMs: z.number().nullable(),
        bullets: z.array(point),
      }),
    )
    .describe("Topical headings with short bullets."),
  terms: z.array(
    z.object({
      term: z.string(),
      definition: z.string().describe("Definition grounded in the lecture."),
      timestampMs: z.number().nullable(),
    }),
  ),
  actionItems: z
    .array(point)
    .describe("Tasks the speaker asked the audience to do."),
  questions: z
    .array(point)
    .describe("Review questions a student can use to self-test."),
});

export function transcriptForPrompt(
  segments: { startMs: number; text: string; failed?: boolean }[],
): { text: string; clipped: boolean } {
  const lines = segments
    .filter((segment) => segment.text.trim() && !segment.failed)
    .map(
      (segment) => `[${Math.round(segment.startMs)}] ${segment.text.trim()}`,
    );
  const full = lines.join("\n");
  const limit = 80_000;
  if (full.length <= limit) return { text: full, clipped: false };
  const head = full.slice(0, 4_000);
  const tail = full.slice(full.length - (limit - 4_000));
  return {
    clipped: true,
    text: `${head}\n\n[earlier transcript omitted]\n\n${tail}`,
  };
}

export function notesPrompt(transcript: string, clipped: boolean): string {
  return [
    "You are taking organized study notes from a lecture transcript.",
    "Use only information that appears in the transcript. Do not invent facts, citations, or assignments.",
    "Each cue is formatted as [startMs] text. When a note is tied to a moment, copy that cue's startMs into timestampMs. Use null when a point spans many cues or has no clear moment.",
    "Write in the lecture's language.",
    "Keep bullets short enough to scan on a phone.",
    clipped
      ? "The transcript was clipped. Cover the included portion and do not pretend the omitted middle was heard."
      : "The transcript is the full lecture captured so far.",
    "",
    "Transcript:",
    transcript || "[no speech captured yet]",
  ].join("\n");
}
