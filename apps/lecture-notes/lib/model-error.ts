import { APICallError } from "ai";

export function publicModelError(error: unknown): string {
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return "OpenAI rejected the API key. Check OPENAI_API_KEY, or switch back to free local Whisper and Ollama.";
    }
    if (error.statusCode === 402) {
      return "The OpenAI account has no remaining credit.";
    }
    if (error.statusCode === 429) {
      return "The model provider is busy. Wait a moment and try again.";
    }
    return error.message.slice(0, 300);
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") return "The request was cancelled.";
    return error.message.slice(0, 300);
  }
  return "The model request failed.";
}
