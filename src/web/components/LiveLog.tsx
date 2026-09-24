import type { Connection, LogRecord } from "../types";
import { collapseExchanges } from "../log-dedup";
import { ValidationBadge } from "./Validation";

interface Props {
  records: LogRecord[];
  connections: Connection[];
  onSelect: (record: LogRecord) => void;
}

// 24-hour local time, HH:MM:SS — independent of the browser's AM/PM locale.
function fmtTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Just the host of the exchange's endpoint — enough to tell suppliers apart
// in the list; the detail modal shows the full URL.
function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function LiveLog({ records, connections, onSelect }: Props) {
  const known = new Set(connections.map((c) => c.id));
  const nameOf = (id: string) => connections.find((c) => c.id === id)?.name ?? id ?? "—";

  const deduped = collapseExchanges(records, known);

  return (
    <div className="log">
      {deduped.length === 0 && <p className="hint">No messages yet. Run a flow to see traffic here.</p>}
      {deduped
        .reverse()
        .map((r) => (
          <button key={r.id} className="log-row" onClick={() => onSelect(r)}>
            <span className={`dir dir-${r.direction}`}>{r.direction === "out" ? "↑" : "↓"}</span>
            <span className="log-doctype">{r.docType}</span>
            <ValidationBadge validation={r.validation} />
            <span className="log-meta">
              {nameOf(r.connectionId)}
              {hostOf(r.url) && <> · {hostOf(r.url)}</>} · {fmtTime(r.ts)}
            </span>
          </button>
        ))}
    </div>
  );
}
