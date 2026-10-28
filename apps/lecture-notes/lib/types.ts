export type TranscriptSegment = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  failed?: boolean;
};

export type NotePoint = {
  text: string;
  timestampMs: number | null;
};

export type NoteSection = {
  heading: string;
  timestampMs: number | null;
  bullets: NotePoint[];
};

export type NoteTerm = {
  term: string;
  definition: string;
  timestampMs: number | null;
};

export type LectureNotes = {
  title: string;
  summary: string;
  keyPoints: NotePoint[];
  sections: NoteSection[];
  terms: NoteTerm[];
  actionItems: NotePoint[];
  questions: NotePoint[];
};

export type LectureSession = {
  id: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
  title: string;
  titleEdited: boolean;
  status: "recording" | "ready";
  segments: TranscriptSegment[];
  notes: LectureNotes | null;
  sample?: boolean;
};

export type Phase = "idle" | "recording" | "paused" | "stopping" | "uploading";

export type WavWindow = {
  blob: Blob;
  mediaType: string;
  startMs: number;
  durationMs: number;
  samples?: Float32Array;
};
