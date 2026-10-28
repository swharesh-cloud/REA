"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { loadSessions, subscribeSessions } from "../lib/storage";
import { formatClock, formatWhen } from "../lib/time";

export function LectureLibrary() {
  const [sessions, setSessions] = useState(loadSessions);

  useEffect(() => subscribeSessions(() => setSessions(loadSessions())), []);

  return (
    <section className="library">
      <h1>Library</h1>
      <p className="meta">
        Saved in this browser. Audio stays on the device only while a tab is
        recording.
      </p>
      {sessions.length === 0 ? (
        <p className="empty">
          No lectures yet. <Link href="/">Record one</Link> or open the sample
          from the recorder.
        </p>
      ) : null}
      {sessions.map((session) => (
        <Link
          className="library-card"
          key={session.id}
          href={`/lectures/${session.id}`}
        >
          <strong>{session.title}</strong>
          <span className="meta">
            {formatWhen(session.createdAt)} · {formatClock(session.durationMs)}
            {session.sample ? " · Sample" : ""}
          </span>
          <span>
            {session.notes?.summary ??
              "Transcript saved. Notes not generated yet."}
          </span>
        </Link>
      ))}
    </section>
  );
}
