import { transcribe } from "ai";

import { publicModelError } from "../../../lib/model-error";
import { transcribeModel } from "../../../lib/models";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BYTES = 4_000_000;

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { error: "Upload the audio as a multipart form field named audio." },
      { status: 400 },
    );
  }
  const audio = form.get("audio");
  if (!(audio instanceof File)) {
    return Response.json(
      { error: "Choose an audio file to transcribe." },
      { status: 400 },
    );
  }
  if (audio.size === 0) {
    return Response.json(
      { error: "The audio file was empty." },
      { status: 400 },
    );
  }
  if (audio.size > MAX_BYTES) {
    return Response.json(
      {
        error:
          "That audio piece is over 4 MB. Record in the app or upload a smaller file.",
      },
      { status: 413 },
    );
  }
  try {
    const bytes = new Uint8Array(await audio.arrayBuffer());
    const model = transcribeModel();
    const result = await transcribe({
      model,
      audio: bytes,
      abortSignal: request.signal,
      ...(model.startsWith("openai/")
        ? {
            providerOptions: {
              openai: { timestampGranularities: ["segment"] },
            },
          }
        : {}),
    });
    return Response.json({
      text: result.text,
      segments: result.segments,
      durationInSeconds: result.durationInSeconds ?? null,
      language: result.language ?? null,
    });
  } catch (error) {
    if (request.signal.aborted) {
      return Response.json(
        { error: "Transcription was cancelled." },
        { status: 499 },
      );
    }
    return Response.json({ error: publicModelError(error) }, { status: 502 });
  }
}
