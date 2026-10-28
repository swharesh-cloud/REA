import { transcribe } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

import { publicModelError } from "../../../lib/model-error";
import { readSettings } from "../../../lib/settings";
import { SetupError, transcribeLocalWhisper } from "../../../lib/whisper-local";

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
    const settings = readSettings();
    const bytes = new Uint8Array(await audio.arrayBuffer());
    if (settings.transcribeProvider === "local") {
      const result = await transcribeLocalWhisper({
        bin: settings.whisperBin,
        modelPath: settings.whisperModel,
        audio: bytes,
        fileName: audio.name || "audio.wav",
        signal: request.signal,
      });
      return Response.json({
        text: result.text,
        segments: result.segments,
        durationInSeconds: null,
        language: null,
      });
    }
    if (!settings.openaiApiKey) {
      throw new SetupError(
        "Set OPENAI_API_KEY, or leave TRANSCRIBE_PROVIDER unset for free local Whisper.",
      );
    }
    const model = settings.openaiTranscribeModel;
    const result = await transcribe({
      model: createOpenAI({ apiKey: settings.openaiApiKey }).transcription(
        model,
      ),
      audio: bytes,
      abortSignal: request.signal,
      ...(model.startsWith("whisper")
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
    if (
      request.signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      return Response.json(
        { error: "Transcription was cancelled." },
        { status: 499 },
      );
    }
    if (error instanceof SetupError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: publicModelError(error) }, { status: 502 });
  }
}
