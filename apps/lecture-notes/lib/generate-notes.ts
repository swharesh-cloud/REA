import { createOpenAI } from "@ai-sdk/openai";
import { generateText, NoObjectGeneratedError, Output } from "ai";
import type { LanguageModel } from "ai";

import { cleanNotes, parseNotesJson } from "./clean-notes";
import { notesPrompt, notesSchema } from "./notes-schema";
import type { AppSettings } from "./settings";
import { SetupError } from "./whisper-local";
import type { LectureNotes } from "./types";

function notesModel(settings: AppSettings): LanguageModel {
  if (settings.notesProvider === "openai") {
    if (!settings.openaiApiKey) {
      throw new SetupError(
        "Set OPENAI_API_KEY, or leave NOTES_PROVIDER unset to use free Ollama.",
      );
    }
    return createOpenAI({ apiKey: settings.openaiApiKey }).chat(
      settings.openaiNotesModel,
    );
  }
  return createOpenAI({
    baseURL: settings.ollamaBaseUrl,
    apiKey: "ollama",
  }).chat(settings.ollamaModel);
}

const jsonInstructions = [
  "Reply with one JSON object and no other text.",
  "Keys: title, summary, keyPoints, sections, terms, actionItems, questions.",
  'Each point is {"text": string, "timestampMs": number or null}.',
  'Each section is {"heading": string, "timestampMs": number or null, "bullets": point[]}.',
  'Each term is {"term": string, "definition": string, "timestampMs": number or null}.',
].join(" ");

async function notesFromJson(
  model: LanguageModel,
  prompt: string,
  signal?: AbortSignal,
): Promise<LectureNotes> {
  const result = await generateText({
    model,
    timeout: 90_000,
    abortSignal: signal,
    prompt: `${prompt}\n\n${jsonInstructions}`,
  });
  try {
    return cleanNotes(parseNotesJson(result.text));
  } catch {
    throw new Error(
      "The notes model returned an unexpected shape. Try Update notes.",
    );
  }
}

export async function generateLectureNotes(options: {
  settings: AppSettings;
  transcript: string;
  clipped: boolean;
  signal?: AbortSignal;
}): Promise<LectureNotes> {
  const model = notesModel(options.settings);
  const prompt = notesPrompt(options.transcript, options.clipped);
  if (options.settings.notesProvider !== "openai") {
    return notesFromJson(model, prompt, options.signal);
  }
  try {
    const result = await generateText({
      model,
      timeout: 45_000,
      abortSignal: options.signal,
      output: Output.object({
        name: "LectureNotes",
        description: "Organized lecture notes linked to transcript timestamps.",
        schema: notesSchema,
      }),
      prompt,
    });
    return cleanNotes(result.output);
  } catch (error) {
    if (!NoObjectGeneratedError.isInstance(error)) throw error;
    return notesFromJson(model, prompt, options.signal);
  }
}
