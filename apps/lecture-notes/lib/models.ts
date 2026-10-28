export const DEFAULT_TRANSCRIBE_MODEL = "openai/whisper-1";
export const DEFAULT_NOTES_MODEL = "google/gemini-3-flash";

export function transcribeModel(): string {
  return (
    process.env.LECTURE_TRANSCRIBE_MODEL?.trim() || DEFAULT_TRANSCRIBE_MODEL
  );
}

export function notesModel(): string {
  return process.env.LECTURE_NOTES_MODEL?.trim() || DEFAULT_NOTES_MODEL;
}
