"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { sessionToMarkdown } from "../lib/markdown";
import { deleteSession, loadSession } from "../lib/storage";
import { formatClock, formatWhen, slugify } from "../lib/time";
import type { LectureSession } from "../lib/types";
import { NotesView } from "./notes-view";
import { TranscriptView } from "./transcript-view";

export function LectureDetail({ id }: { id: string }) {
  const router = useRouter();
  const [session, setSession] = useState<LectureSession | null | undefined>(
    undefined,
  );
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setSession(loadSession(id));
  }, [id]);

  if (session === undefined) return <p className="empty">Loading…</p>;
  if (!session) {
    return (
      <p className="empty">
        That lecture is not on this device.{" "}
        <Link href="/lectures">Back to the library</Link>
      </p>
    );
  }

  const copy = async () => {
    await navigator.clipboard.writeText(sessionToMarkdown(session));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const download = () => {
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

  return (
    <article>
      <div className="detail-head">
        <div>
          <h1>{session.title}</h1>
          <p className="meta">
            {formatWhen(session.createdAt)} · {formatClock(session.durationMs)}
            {session.sample ? " · Sample" : ""}
          </p>
        </div>
        <div className="actions">
          <button
            type="button"
            className="text-button"
            onClick={() => void copy()}
          >
            {copied ? "Copied" : "Copy Markdown"}
          </button>
          <button type="button" className="text-button" onClick={download}>
            Export .md
          </button>
          {confirming ? (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                deleteSession(session.id);
                router.push("/lectures");
              }}
            >
              Confirm delete
            </button>
          ) : (
            <button
              type="button"
              className="text-button"
              onClick={() => setConfirming(true)}
            >
              Delete
            </button>
          )}
        </div>
      </div>
      {session.sample ? (
        <p className="banner sample-banner">
          Sample notes stored in this browser.
        </p>
      ) : null}
      <div className="workspace">
        <section className="panel" aria-label="Transcript">
          <h2>Transcript</h2>
          <TranscriptView segments={session.segments} />
        </section>
        <section className="panel" aria-label="Notes">
          <h2>Notes</h2>
          <NotesView
            notes={session.notes}
            onSeek={(ms) => {
              const match = session.segments.reduce<
                (typeof session.segments)[number] | null
              >((best, segment) => {
                if (!best) return segment;
                return Math.abs(segment.startMs - ms) <
                  Math.abs(best.startMs - ms)
                  ? segment
                  : best;
              }, null);
              if (!match) return;
              document
                .getElementById(`segment-${match.id}`)
                ?.scrollIntoView({ block: "center" });
            }}
          />
        </section>
      </div>
    </article>
  );
}
