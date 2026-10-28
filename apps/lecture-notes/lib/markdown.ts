import type { LectureNotes, LectureSession, NotePoint } from "./types";
import { formatClock } from "./time";

function point(item: NotePoint): string {
  const stamp =
    item.timestampMs === null ? "" : ` (${formatClock(item.timestampMs)})`;
  return `- ${item.text}${stamp}`;
}

export function notesToMarkdown(notes: LectureNotes): string {
  const sections = [
    `# ${notes.title}`,
    "",
    "## Summary",
    "",
    notes.summary,
    "",
    "## Key points",
    "",
    ...(notes.keyPoints.length > 0
      ? notes.keyPoints.map(point)
      : ["- None noted."]),
    "",
    "## Notes",
    "",
  ];
  if (notes.sections.length === 0) {
    sections.push("_No headed notes yet._", "");
  }
  for (const section of notes.sections) {
    const stamp =
      section.timestampMs === null
        ? ""
        : ` (${formatClock(section.timestampMs)})`;
    sections.push(`### ${section.heading}${stamp}`, "");
    sections.push(
      ...(section.bullets.length > 0 ? section.bullets.map(point) : ["- "]),
      "",
    );
  }
  sections.push("## Terms", "");
  if (notes.terms.length === 0) sections.push("_None noted._", "");
  for (const term of notes.terms) {
    const stamp =
      term.timestampMs === null ? "" : ` (${formatClock(term.timestampMs)})`;
    sections.push(`- **${term.term}**: ${term.definition}${stamp}`);
  }
  sections.push("", "## Action items", "");
  sections.push(
    ...(notes.actionItems.length > 0
      ? notes.actionItems.map((item) => point(item).replace("- ", "- [ ] "))
      : ["- [ ] None noted."]),
    "",
    "## Questions to review",
    "",
    ...(notes.questions.length > 0
      ? notes.questions.map(point)
      : ["- None noted."]),
    "",
  );
  return sections.join("\n");
}

export function sessionToMarkdown(session: LectureSession): string {
  const lines = [
    session.notes
      ? notesToMarkdown(session.notes)
      : `# ${session.title}\n\n_Notes have not been generated yet._\n`,
    "## Transcript",
    "",
  ];
  if (session.segments.length === 0) {
    lines.push("_No transcript yet._");
  }
  for (const segment of session.segments) {
    lines.push(`- ${formatClock(segment.startMs)} ${segment.text}`);
  }
  lines.push("");
  return lines.join("\n");
}
