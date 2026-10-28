"use client";

import { useEffect, useRef, useState } from "react";

import { audioFileToWindows } from "../lib/audio-file";
import {
  requestNotes,
  segmentsFromTranscript,
  transcribeAudio,
  withRetry,
} from "../lib/api-client";
import { PcmRecorder } from "../lib/pcm-recorder";
import { mapPool } from "../lib/pool";
import { createSampleSession } from "../lib/sample-lecture";
import { saveSession } from "../lib/storage";
import { formatClock, formatWhen, slugify } from "../lib/time";
import type {
  LectureSession,
  Phase,
  TranscriptSegment,
  WavWindow,
} from "../lib/types";
import { rootMeanSquare } from "../lib/wav";
import { sessionToMarkdown } from "../lib/markdown";
import { NotesView } from "./notes-view";
import { TranscriptView } from "./transcript-view";

function draftSession(): LectureSession {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    durationMs: 0,
    title: `Lecture ${formatWhen(now)}`,
    titleEdited: false,
    status: "recording",
    segments: [],
    notes: null,
  };
}

export function Studio() {
  const [session, setSession] = useState<LectureSession | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [status, setStatus] = useState("Ready when you are.");
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<"transcript" | "notes">("notes");
  const [notesPending, setNotesPending] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const sessionRef = useRef<LectureSession | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const recorderRef = useRef<PcmRecorder | null>(null);
  const queueRef = useRef(Promise.resolve());
  const pendingRef = useRef(0);
  const notesAbort = useRef<AbortController | null>(null);
  const lastNotesAt = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const busy =
    phase === "recording" ||
    phase === "paused" ||
    phase === "stopping" ||
    phase === "uploading";
  phaseRef.current = phase;

  const persist = (next: LectureSession) => {
    const saved = saveSession(next);
    sessionRef.current = saved;
    setSession(saved);
    return saved;
  };

  const mergeSegments = (incoming: TranscriptSegment[], durationMs: number) => {
    const current = sessionRef.current;
    if (!current) return;
    const segments = [...current.segments, ...incoming].sort(
      (left, right) => left.startMs - right.startMs,
    );
    const end = segments.reduce(
      (max, segment) => Math.max(max, segment.endMs),
      current.durationMs,
    );
    persist({
      ...current,
      segments,
      durationMs: Math.max(end, durationMs, current.durationMs),
    });
  };

  const runNotes = async (force = false) => {
    const current = sessionRef.current;
    if (!current) return;
    const spoken = current.segments.some(
      (segment) => !segment.failed && segment.text.trim(),
    );
    if (!spoken) return;
    if (
      !force &&
      lastNotesAt.current !== 0 &&
      Date.now() - lastNotesAt.current < 75_000
    ) {
      return;
    }
    notesAbort.current?.abort();
    const controller = new AbortController();
    notesAbort.current = controller;
    setNotesPending(true);
    try {
      const notes = await requestNotes(current.segments, controller.signal);
      const latest = sessionRef.current;
      if (!latest || latest.id !== current.id) return;
      persist({
        ...latest,
        title: latest.titleEdited ? latest.title : notes.title || latest.title,
        notes,
      });
      lastNotesAt.current = Date.now();
      setError(null);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError")
        return;
      setError(
        caught instanceof Error ? caught.message : "Could not write notes.",
      );
    } finally {
      if (notesAbort.current === controller) setNotesPending(false);
    }
  };

  const enqueue = (window: WavWindow & { silent?: boolean }) => {
    if (
      window.silent ||
      (window.samples && rootMeanSquare(window.samples) < 0.004)
    ) {
      setStatus("Quiet stretch skipped.");
      return;
    }
    pendingRef.current += 1;
    setStatus(
      pendingRef.current > 1
        ? `Transcribing ${pendingRef.current} pieces…`
        : "Transcribing the latest piece…",
    );
    queueRef.current = queueRef.current.then(async () => {
      try {
        const result = await withRetry(() => transcribeAudio(window.blob));
        const segments = segmentsFromTranscript(
          result,
          window.startMs,
          window.durationMs,
        );
        if (segments.length > 0)
          mergeSegments(segments, window.startMs + window.durationMs);
        setError(null);
      } catch (caught) {
        mergeSegments(
          [
            {
              id: crypto.randomUUID(),
              startMs: window.startMs,
              endMs: window.startMs + window.durationMs,
              text: "[untranscribed audio]",
              failed: true,
            },
          ],
          window.startMs + window.durationMs,
        );
        setError(
          caught instanceof Error ? caught.message : "Transcription failed.",
        );
      } finally {
        pendingRef.current = Math.max(0, pendingRef.current - 1);
        if (pendingRef.current === 0 && phaseRef.current !== "uploading") {
          setStatus(phaseRef.current === "paused" ? "Paused." : "Listening.");
        }
      }
    });
  };

  useEffect(() => {
    void fetch("/api/config")
      .then(async (response) => {
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (
          body &&
          typeof body === "object" &&
          "gatewayConfigured" in body &&
          (body as { gatewayConfigured?: unknown }).gatewayConfigured === false
        ) {
          setStatus((current) =>
            current === "Ready when you are."
              ? "Add AI_GATEWAY_API_KEY before recording. The sample still works."
              : current,
          );
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("sample") !== "1")
      return;
    const sample = createSampleSession();
    persist(sample);
    setElapsedMs(sample.durationMs);
    setStatus("Sample notes. Record or upload to make your own.");
  }, []);

  useEffect(() => {
    if (phase !== "recording") return undefined;
    const timer = window.setInterval(() => {
      setElapsedMs(recorderRef.current?.elapsedMs() ?? 0);
    }, 200);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "recording" && phase !== "paused") return undefined;
    const timer = window.setTimeout(() => {
      void runNotes(false);
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [session?.segments.length, phase]);

  const start = async () => {
    setError(null);
    const previous = sessionRef.current;
    const draft = draftSession();
    lastNotesAt.current = 0;
    setElapsedMs(0);
    const recorder = new PcmRecorder();
    recorderRef.current = recorder;
    recorder.onlevel = setLevel;
    recorder.onchunk = (chunk) => {
      enqueue({
        blob: chunk.blob,
        mediaType: "audio/wav",
        startMs: chunk.startMs,
        durationMs: chunk.durationMs,
        silent: chunk.silent,
      });
      if (!chunk.silent) {
        setStatus("Listening. The next transcript piece follows this one.");
      }
    };
    recorder.oninterrupt = () => {
      recorder.pause();
      setPhase("paused");
      setElapsedMs(recorder.elapsedMs());
      setStatus(
        "The browser interrupted the microphone. Resume when you are ready.",
      );
    };
    try {
      await recorder.start();
      persist({ ...draft, status: "recording" });
      setPhase("recording");
      setStatus("Recording. Transcript pieces arrive about every 20 seconds.");
    } catch (caught) {
      setPhase("idle");
      sessionRef.current = previous;
      setSession(previous);
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not start the microphone.",
      );
    }
  };

  const pause = () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorder.pause();
    setPhase("paused");
    setElapsedMs(recorder.elapsedMs());
    setStatus("Paused.");
  };

  const resume = async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    try {
      await recorder.resume();
      setPhase("recording");
      setStatus("Recording again.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not resume.");
    }
  };

  const stop = async () => {
    const recorder = recorderRef.current;
    setPhase("stopping");
    setStatus("Finishing the last audio piece…");
    await recorder?.stop();
    await queueRef.current;
    const current = sessionRef.current;
    const duration = Math.max(
      recorder?.elapsedMs() ?? 0,
      current?.durationMs ?? 0,
    );
    if (current) {
      persist({ ...current, status: "ready", durationMs: duration });
    }
    setElapsedMs(duration);
    setPhase("idle");
    setStatus("Recording saved on this device.");
    await runNotes(true);
  };

  const upload = async (file: File) => {
    setError(null);
    setPhase("uploading");
    const draft = { ...draftSession(), status: "ready" as const };
    lastNotesAt.current = 0;
    persist(draft);
    setElapsedMs(0);
    try {
      const windows = await audioFileToWindows(file);
      let done = 0;
      await mapPool(windows, 2, async (window) => {
        if (window.samples && rootMeanSquare(window.samples) < 0.004) {
          done += 1;
          return;
        }
        const result = await withRetry(() => transcribeAudio(window.blob));
        const segments = segmentsFromTranscript(
          result,
          window.startMs,
          window.durationMs,
        );
        if (segments.length > 0) {
          mergeSegments(
            segments,
            window.startMs + Math.max(window.durationMs, 0),
          );
        }
        done += 1;
        setStatus(`Transcribed ${done} of ${windows.length}.`);
      });
      const current = sessionRef.current;
      if (current && current.durationMs === 0) {
        const end = current.segments.reduce(
          (max, segment) => Math.max(max, segment.endMs),
          0,
        );
        persist({ ...current, durationMs: end });
        setElapsedMs(end);
      } else {
        setElapsedMs(sessionRef.current?.durationMs ?? 0);
      }
      setStatus("Upload saved on this device.");
      await runNotes(true);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not read that audio file.",
      );
    } finally {
      setPhase("idle");
    }
  };

  const showSample = () => {
    const sample = createSampleSession();
    persist(sample);
    setElapsedMs(sample.durationMs);
    setPhase("idle");
    setError(null);
    setStatus("Sample notes. Record or upload to make your own.");
  };

  const copyNotes = async () => {
    if (!session) return;
    await navigator.clipboard.writeText(sessionToMarkdown(session));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const downloadNotes = () => {
    if (!session) return;
    const blob = new Blob([sessionToMarkdown(session)], {
      type: "text/markdown",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${slugify(session.title)}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const seek = (ms: number) => {
    const segments = sessionRef.current?.segments ?? [];
    const match = segments.reduce<TranscriptSegment | null>((best, segment) => {
      if (!best) return segment;
      return Math.abs(segment.startMs - ms) < Math.abs(best.startMs - ms)
        ? segment
        : best;
    }, null);
    if (!match) return;
    setActiveId(match.id);
    setPanel("transcript");
    window.setTimeout(() => {
      document
        .getElementById(`segment-${match.id}`)
        ?.scrollIntoView({ block: "center" });
    }, 30);
  };

  return (
    <section className="studio">
      <label className="title-row">
        <span>Title</span>
        <input
          aria-label="Lecture title"
          value={session?.title ?? ""}
          placeholder="Untitled lecture"
          onChange={(event) => {
            const current = sessionRef.current;
            if (!current) return;
            persist({
              ...current,
              title: event.target.value,
              titleEdited: true,
            });
          }}
        />
      </label>
      <div className="transport">
        <div className="timer-row">
          <div className="timer" aria-live="polite">
            {formatClock(
              phase === "recording"
                ? elapsedMs
                : session?.durationMs || elapsedMs,
            )}
          </div>
          <div className="level" aria-hidden="true">
            <span style={{ transform: `scaleX(${Math.max(0.04, level)})` }} />
          </div>
        </div>
        <div className="controls">
          {phase === "recording" ? (
            <button type="button" className="primary" onClick={pause}>
              Pause
            </button>
          ) : phase === "paused" ? (
            <button
              type="button"
              className="primary"
              onClick={() => void resume()}
            >
              Resume
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              onClick={() => void start()}
              disabled={busy}
            >
              Start
            </button>
          )}
          <button
            type="button"
            onClick={() => void stop()}
            disabled={phase !== "recording" && phase !== "paused"}
          >
            Stop
          </button>
          <label className="file-button">
            Upload audio
            <input
              ref={fileRef}
              type="file"
              accept="audio/*,.mp3,.m4a,.wav,.webm,.mp4,.aac"
              hidden
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.currentTarget.value = "";
                if (file) void upload(file);
              }}
            />
          </label>
          <button type="button" onClick={showSample} disabled={busy}>
            View sample
          </button>
        </div>
        <p className="status" aria-live="polite">
          {status}
        </p>
      </div>
      {session?.sample ? (
        <p className="banner sample-banner">
          Sample lecture. It is stored on this device so you can try copy and
          export. It is not a recording.
        </p>
      ) : null}
      {error ? <p className="banner">{error}</p> : null}
      <div className="switch" role="tablist" aria-label="Lecture panes">
        <button
          type="button"
          role="tab"
          aria-selected={panel === "notes"}
          onClick={() => setPanel("notes")}
        >
          Notes
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={panel === "transcript"}
          onClick={() => setPanel("transcript")}
        >
          Transcript
        </button>
      </div>
      <div className="workspace">
        <section
          className="panel"
          hidden={panel !== "transcript"}
          aria-label="Transcript"
        >
          <h2>Transcript</h2>
          <TranscriptView
            segments={session?.segments ?? []}
            activeId={activeId}
          />
        </section>
        <section
          className="panel"
          hidden={panel !== "notes"}
          aria-label="Notes"
        >
          <h2>Notes</h2>
          <div className="actions">
            <button
              type="button"
              className="text-button"
              onClick={() => void runNotes(true)}
              disabled={!session || notesPending}
            >
              Update notes
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => void copyNotes()}
              disabled={!session}
            >
              {copied ? "Copied" : "Copy Markdown"}
            </button>
            <button
              type="button"
              className="text-button"
              onClick={downloadNotes}
              disabled={!session}
            >
              Export .md
            </button>
          </div>
          <NotesView
            notes={session?.notes ?? null}
            pending={notesPending}
            onSeek={seek}
          />
        </section>
      </div>
    </section>
  );
}
