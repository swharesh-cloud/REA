import { APICallError } from "ai";

export function publicModelError(error: unknown): string {
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return "AI Gateway rejected the credentials. Set AI_GATEWAY_API_KEY for local development, or deploy on Vercel so the project can use OIDC.";
    }
    if (error.statusCode === 402) {
      return "AI Gateway credits are exhausted for this team.";
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
