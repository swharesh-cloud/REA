import type { LectureNotes, LectureSession, TranscriptSegment } from "./types";

const STORAGE_KEY = "lecture-notes.sessions.v1";
const CHANGE_EVENT = "lecture-notes-changed";

function isPoint(
  value: unknown,
): value is { text: string; timestampMs: number | null } {
  if (!value || typeof value !== "object") return false;
  const point = value as { text?: unknown; timestampMs?: unknown };
  return (
    typeof point.text === "string" &&
    (point.timestampMs === null || typeof point.timestampMs === "number")
  );
}

function normalizeNotes(value: unknown): LectureNotes | null {
  if (!value || typeof value !== "object") return null;
  const notes = value as Partial<LectureNotes>;
  if (typeof notes.title !== "string" || typeof notes.summary !== "string") {
    return null;
  }
  const points = (items: unknown) =>
    Array.isArray(items) ? items.filter(isPoint) : [];
  const sections = Array.isArray(notes.sections)
    ? notes.sections.flatMap((section) => {
        if (!section || typeof section !== "object") return [];
        const heading = (section as { heading?: unknown }).heading;
        const timestampMs = (section as { timestampMs?: unknown }).timestampMs;
        if (typeof heading !== "string") return [];
        return [
          {
            heading,
            timestampMs:
              timestampMs === null || typeof timestampMs === "number"
                ? timestampMs
                : null,
            bullets: points((section as { bullets?: unknown }).bullets),
          },
        ];
      })
    : [];
  const terms = Array.isArray(notes.terms)
    ? notes.terms.flatMap((term) => {
        if (!term || typeof term !== "object") return [];
        const record = term as {
          term?: unknown;
          definition?: unknown;
          timestampMs?: unknown;
        };
        if (
          typeof record.term !== "string" ||
          typeof record.definition !== "string"
        ) {
          return [];
        }
        return [
          {
            term: record.term,
            definition: record.definition,
            timestampMs:
              record.timestampMs === null ||
              typeof record.timestampMs === "number"
                ? record.timestampMs
                : null,
          },
        ];
      })
    : [];
  return {
    title: notes.title,
    summary: notes.summary,
    keyPoints: points(notes.keyPoints),
    sections,
    terms,
    actionItems: points(notes.actionItems),
    questions: points(notes.questions),
  };
}

function normalizeSegment(value: unknown): TranscriptSegment | null {
  if (!value || typeof value !== "object") return null;
  const segment = value as Partial<TranscriptSegment>;
  if (
    typeof segment.id !== "string" ||
    typeof segment.startMs !== "number" ||
    typeof segment.endMs !== "number" ||
    typeof segment.text !== "string"
  ) {
    return null;
  }
  return {
    id: segment.id,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
    ...(segment.failed ? { failed: true } : {}),
  };
}

export function normalizeSession(value: unknown): LectureSession | null {
  if (!value || typeof value !== "object") return null;
  const session = value as Partial<LectureSession>;
  if (
    typeof session.id !== "string" ||
    typeof session.createdAt !== "string" ||
    typeof session.title !== "string"
  ) {
    return null;
  }
  return {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt:
      typeof session.updatedAt === "string"
        ? session.updatedAt
        : session.createdAt,
    durationMs: typeof session.durationMs === "number" ? session.durationMs : 0,
    title: session.title,
    titleEdited: session.titleEdited === true,
    status: "ready",
    segments: Array.isArray(session.segments)
      ? session.segments.flatMap((segment) => {
          const normalized = normalizeSegment(segment);
          return normalized ? [normalized] : [];
        })
      : [],
    notes: normalizeNotes(session.notes),
    ...(session.sample ? { sample: true } : {}),
  };
}

export function loadSessions(): LectureSession[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((session) => {
      const normalized = normalizeSession(session);
      return normalized ? [normalized] : [];
    });
  } catch {
    return [];
  }
}

export function loadSession(id: string): LectureSession | null {
  return loadSessions().find((session) => session.id === id) ?? null;
}

function writeSessions(sessions: LectureSession[]) {
  const payload = JSON.stringify(sessions.slice(0, 40));
  window.localStorage.setItem(STORAGE_KEY, payload);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function saveSession(session: LectureSession) {
  const next = {
    ...session,
    updatedAt: new Date().toISOString(),
    status: session.status,
  };
  const others = loadSessions().filter((item) => item.id !== session.id);
  try {
    writeSessions([next, ...others]);
  } catch (error) {
    if (
      !(error instanceof DOMException) ||
      error.name !== "QuotaExceededError"
    ) {
      throw error;
    }
    writeSessions([next, ...others.slice(0, 4)]);
  }
  return next;
}

export function deleteSession(id: string) {
  writeSessions(loadSessions().filter((session) => session.id !== id));
}

export function subscribeSessions(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, listener);
  };
}
