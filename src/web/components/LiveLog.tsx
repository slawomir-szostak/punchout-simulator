import type { Connection, LogRecord } from "../types";
import { ValidationBadge } from "./Validation";

interface Props {
  records: LogRecord[];
  connections: Connection[];
  onSelect: (record: LogRecord) => void;
}

export function LiveLog({ records, connections, onSelect }: Props) {
  const nameOf = (id: string) => connections.find((c) => c.id === id)?.name ?? id ?? "—";
  return (
    <div className="log">
      {records.length === 0 && <p className="hint">No messages yet. Run a flow to see traffic here.</p>}
      {records
        .slice()
        .reverse()
        .map((r) => (
          <button key={r.id} className="log-row" onClick={() => onSelect(r)}>
            <span className={`dir dir-${r.direction}`}>{r.direction === "out" ? "↑" : "↓"}</span>
            <span className="log-doctype">{r.docType}</span>
            <span className="log-conn">{nameOf(r.connectionId)}</span>
            <span className="log-ts">{new Date(r.ts).toLocaleTimeString()}</span>
            <ValidationBadge validation={r.validation} />
          </button>
        ))}
    </div>
  );
}
