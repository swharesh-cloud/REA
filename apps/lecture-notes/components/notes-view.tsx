import type { LectureNotes, NotePoint } from "../lib/types";
import { formatClock } from "../lib/time";

function Stamp({
  ms,
  onSeek,
}: {
  ms: number | null;
  onSeek?: (ms: number) => void;
}) {
  if (ms === null) return null;
  if (!onSeek) return <span className="stamp">{formatClock(ms)}</span>;
  return (
    <button type="button" className="stamp" onClick={() => onSeek(ms)}>
      {formatClock(ms)}
    </button>
  );
}

function Points({
  items,
  onSeek,
}: {
  items: NotePoint[];
  onSeek?: (ms: number) => void;
}) {
  if (items.length === 0) return <p className="empty">None noted.</p>;
  return (
    <ul>
      {items.map((item) => (
        <li key={`${item.timestampMs ?? "x"}-${item.text}`}>
          {item.text}
          <Stamp ms={item.timestampMs} onSeek={onSeek} />
        </li>
      ))}
    </ul>
  );
}

export function NotesView({
  notes,
  pending,
  onSeek,
}: {
  notes: LectureNotes | null;
  pending?: boolean;
  onSeek?: (ms: number) => void;
}) {
  if (!notes) {
    return (
      <p className="empty">
        {pending
          ? "Organizing notes…"
          : "Notes appear after the first stretch of speech, then refresh about once a minute."}
      </p>
    );
  }
  return (
    <article className="notes">
      {pending ? <p className="status">Updating notes…</p> : null}
      <p className="summary">{notes.summary}</p>
      <h3>Key points</h3>
      <Points items={notes.keyPoints} onSeek={onSeek} />
      <h3>Notes</h3>
      {notes.sections.length === 0 ? (
        <p className="empty">No headed notes yet.</p>
      ) : null}
      {notes.sections.map((section) => (
        <section key={`${section.timestampMs ?? "s"}-${section.heading}`}>
          <h4>
            {section.heading}
            <Stamp ms={section.timestampMs} onSeek={onSeek} />
          </h4>
          <Points items={section.bullets} onSeek={onSeek} />
        </section>
      ))}
      <h3>Terms</h3>
      {notes.terms.length === 0 ? <p className="empty">None noted.</p> : null}
      <ul>
        {notes.terms.map((term) => (
          <li key={term.term}>
            <strong>{term.term}.</strong> {term.definition}
            <Stamp ms={term.timestampMs} onSeek={onSeek} />
          </li>
        ))}
      </ul>
      <h3>Action items</h3>
      <Points items={notes.actionItems} onSeek={onSeek} />
      <h3>Questions to review</h3>
      <Points items={notes.questions} onSeek={onSeek} />
    </article>
  );
}
