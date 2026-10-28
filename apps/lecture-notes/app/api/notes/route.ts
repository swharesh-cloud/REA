import { generateText, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";

import { publicModelError } from "../../../lib/model-error";
import { notesModel } from "../../../lib/models";
import {
  notesPrompt,
  notesSchema,
  transcriptForPrompt,
} from "../../../lib/notes-schema";

export const runtime = "nodejs";
export const maxDuration = 60;

const requestSchema = z.object({
  segments: z
    .array(
      z.object({
        startMs: z.number(),
        text: z.string(),
        failed: z.boolean().optional(),
      }),
    )
    .max(5000),
});

function cleanTimestamp(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json(
      { error: "Send the transcript as JSON." },
      { status: 400 },
    );
  }
  const parsed = requestSchema.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      { error: "The transcript payload was not valid." },
      { status: 400 },
    );
  }
  const spoken = parsed.data.segments.filter(
    (segment) => !segment.failed && segment.text.trim(),
  );
  if (spoken.length === 0) {
    return Response.json(
      { error: "There is no transcript to organize yet." },
      { status: 400 },
    );
  }
  const transcript = transcriptForPrompt(parsed.data.segments);
  try {
    const result = await generateText({
      model: notesModel(),
      reasoning: "low",
      timeout: 45_000,
      abortSignal: request.signal,
      output: Output.object({
        name: "LectureNotes",
        description: "Organized lecture notes linked to transcript timestamps.",
        schema: notesSchema,
      }),
      prompt: notesPrompt(transcript.text, transcript.clipped),
    });
    const notes = result.output;
    return Response.json({
      notes: {
        title: notes.title.trim() || "Untitled lecture",
        summary: notes.summary.trim(),
        keyPoints: notes.keyPoints
          .map((point) => ({
            text: point.text.trim(),
            timestampMs: cleanTimestamp(point.timestampMs),
          }))
          .filter((point) => point.text),
        sections: notes.sections
          .map((section) => ({
            heading: section.heading.trim(),
            timestampMs: cleanTimestamp(section.timestampMs),
            bullets: section.bullets
              .map((point) => ({
                text: point.text.trim(),
                timestampMs: cleanTimestamp(point.timestampMs),
              }))
              .filter((point) => point.text),
          }))
          .filter((section) => section.heading),
        terms: notes.terms
          .map((term) => ({
            term: term.term.trim(),
            definition: term.definition.trim(),
            timestampMs: cleanTimestamp(term.timestampMs),
          }))
          .filter((term) => term.term && term.definition),
        actionItems: notes.actionItems
          .map((point) => ({
            text: point.text.trim(),
            timestampMs: cleanTimestamp(point.timestampMs),
          }))
          .filter((point) => point.text),
        questions: notes.questions
          .map((point) => ({
            text: point.text.trim(),
            timestampMs: cleanTimestamp(point.timestampMs),
          }))
          .filter((point) => point.text),
      },
    });
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      return Response.json(
        {
          error:
            "The notes model returned an unexpected shape. Try Update notes.",
        },
        { status: 502 },
      );
    }
    return Response.json({ error: publicModelError(error) }, { status: 502 });
  }
}
