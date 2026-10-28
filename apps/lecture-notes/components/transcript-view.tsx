import type { TranscriptSegment } from "../lib/types";
import { formatClock } from "../lib/time";

export function TranscriptView({
  segments,
  activeId,
}: {
  segments: TranscriptSegment[];
  activeId?: string | null;
}) {
  if (segments.length === 0) {
    return (
      <p className="empty">
        Speech shows up here about every 20 seconds while you record.
      </p>
    );
  }
  return (
    <ol className="transcript">
      {segments.map((segment) => (
        <li
          key={segment.id}
          id={`segment-${segment.id}`}
          className={segment.id === activeId ? "active" : undefined}
        >
          <button
            type="button"
            onClick={() => {
              document.getElementById(`segment-${segment.id}`)?.scrollIntoView({
                block: "center",
              });
            }}
          >
            {formatClock(segment.startMs)}
          </button>
          <span className={segment.failed ? "failed" : undefined}>
            {segment.text}
          </span>
        </li>
      ))}
    </ol>
  );
}
