import { z } from "zod";

import { publicModelError } from "../../../lib/model-error";
import { generateLectureNotes } from "../../../lib/generate-notes";
import { transcriptForPrompt } from "../../../lib/notes-schema";
import { readSettings } from "../../../lib/settings";
import { SetupError } from "../../../lib/whisper-local";

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
    const notes = await generateLectureNotes({
      settings: readSettings(),
      transcript: transcript.text,
      clipped: transcript.clipped,
      signal: request.signal,
    });
    return Response.json({ notes });
  } catch (error) {
    if (error instanceof SetupError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: publicModelError(error) }, { status: 502 });
  }
}
