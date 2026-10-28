import { join } from "node:path";

export type TranscribeProvider = "local" | "openai";
export type NotesProvider = "ollama" | "openai";

export type AppSettings = {
  transcribeProvider: TranscribeProvider;
  notesProvider: NotesProvider;
  openaiApiKey: string;
  openaiTranscribeModel: string;
  openaiNotesModel: string;
  whisperBin: string;
  whisperModel: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
};

function choice<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
  name: string,
): T {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return fallback;
  if ((allowed as readonly string[]).includes(trimmed)) return trimmed as T;
  throw new Error(`${name} must be ${allowed.join(" or ")}.`);
}

export function readSettings(
  env: Record<string, string | undefined> = process.env,
): AppSettings {
  return {
    transcribeProvider: choice(
      env.TRANSCRIBE_PROVIDER,
      ["local", "openai"],
      "local",
      "TRANSCRIBE_PROVIDER",
    ),
    notesProvider: choice(
      env.NOTES_PROVIDER,
      ["ollama", "openai"],
      "ollama",
      "NOTES_PROVIDER",
    ),
    openaiApiKey: env.OPENAI_API_KEY?.trim() ?? "",
    openaiTranscribeModel: env.OPENAI_TRANSCRIBE_MODEL?.trim() || "whisper-1",
    openaiNotesModel: env.OPENAI_NOTES_MODEL?.trim() || "gpt-4o-mini",
    whisperBin: env.WHISPER_BIN?.trim() || "whisper-cli",
    whisperModel:
      env.WHISPER_MODEL?.trim() ||
      join(process.cwd(), "models", "ggml-base.en.bin"),
    ollamaBaseUrl: env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434/v1",
    ollamaModel: env.OLLAMA_MODEL?.trim() || "llama3.2",
  };
}
