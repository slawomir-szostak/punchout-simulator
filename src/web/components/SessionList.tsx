export interface SessionRow {
  /** Selection key: a client-flow key (active/draft) or a server sessionId. */
  id: string;
  title: string;
  subtitle: string;
  /** create / edit / inspect, if known. */
  operation?: string;
  hasErrors?: boolean;
  /** External buyer hit our Mode-B endpoint. */
  inbound?: boolean;
  /** Client-driven session not yet sent (no server records). */
  draft?: boolean;
  count?: number;
}

export function SessionList({
  rows,
  selectedId,
  onSelect,
  onNew,
}: {
  rows: SessionRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <>
      <div className="sidebar-head">
        <span>Sessions</span>
        <button className="btn-primary btn-sm" onClick={onNew}>+ New session</button>
      </div>
      {rows.length === 0 && <p className="hint" style={{ padding: "0 1rem" }}>No sessions yet. Start one with “+ New session”, or they appear here when a buyer hits a Mode-B endpoint.</p>}
      <ul className="conn-list">
        {rows.map((r) => (
          <li
            key={r.id}
            className={`entity-row ${r.id === selectedId ? "active" : ""}`}
            role="button"
            tabIndex={0}
            aria-current={r.id === selectedId ? "true" : undefined}
            onClick={() => onSelect(r.id)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(r.id); } }}
          >
            <div className="session-row-top">
              <span className={`status-dot ${r.hasErrors ? "err" : "ok"}`} />
              <span className="conn-name">{r.title}</span>
              {r.operation && r.operation !== "create" && <span className="badge badge-warn session-op">{r.operation}</span>}
              {r.inbound && <span className="badge badge-muted session-op">inbound</span>}
              {r.draft && <span className="badge badge-muted session-op">draft</span>}
            </div>
            <div className="conn-mode">{r.subtitle}</div>
          </li>
        ))}
      </ul>
    </>
  );
}
