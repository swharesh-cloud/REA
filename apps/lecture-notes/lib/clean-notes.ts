import { notesSchema } from "./notes-schema";
import type { LectureNotes } from "./types";

function cleanTimestamp(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

function coerceTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    value.trim() &&
    Number.isFinite(Number(value))
  ) {
    return Number(value);
  }
  return null;
}

export function coerceNotesJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(coerceNotesJson);
  if (!value || typeof value !== "object") return value;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    next[key] =
      key === "timestampMs" ? coerceTimestamp(item) : coerceNotesJson(item);
  }
  return next;
}

export function parseNotesJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("The notes model did not return JSON. Try Update notes.");
  }
  return JSON.parse(text.slice(start, end + 1));
}

export function cleanNotes(value: unknown): LectureNotes {
  const notes = notesSchema.parse(coerceNotesJson(value));
  const point = (item: { text: string; timestampMs: number | null }) => ({
    text: item.text.trim(),
    timestampMs: cleanTimestamp(item.timestampMs),
  });
  return {
    title: notes.title.trim() || "Untitled lecture",
    summary: notes.summary.trim(),
    keyPoints: notes.keyPoints.map(point).filter((item) => item.text),
    sections: notes.sections
      .map((section) => ({
        heading: section.heading.trim(),
        timestampMs: cleanTimestamp(section.timestampMs),
        bullets: section.bullets.map(point).filter((item) => item.text),
      }))
      .filter((section) => section.heading),
    terms: notes.terms
      .map((term) => ({
        term: term.term.trim(),
        definition: term.definition.trim(),
        timestampMs: cleanTimestamp(term.timestampMs),
      }))
      .filter((term) => term.term && term.definition),
    actionItems: notes.actionItems.map(point).filter((item) => item.text),
    questions: notes.questions.map(point).filter((item) => item.text),
  };
}
