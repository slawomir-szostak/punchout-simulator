import type { LogRecord } from "../types";
import { CxmlEditor } from "./CxmlEditor";
import { ValidationPanel } from "./Validation";

export function MessageDetail({ record, onClose }: { record: LogRecord; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <span className={`dir dir-${record.direction}`}>{record.direction === "out" ? "OUT ↑" : "IN ↓"}</span>
            <strong>{record.docType}</strong>
            {record.note && <span className="badge badge-warn">{record.note}</span>}
          </div>
          <button className="btn-link" onClick={onClose}>close ✕</button>
        </div>
        <div className="modal-meta">
          <span>session: <code>{record.sessionId}</code></span>
          <span>{new Date(record.ts).toLocaleTimeString()}</span>
          {record.status != null && <span>HTTP {record.status}</span>}
          {record.contentType && <span>{record.contentType}</span>}
        </div>

        {record.attachments && record.attachments.length > 0 && (
          <div className="att-summary">
            <strong>Attachments ({record.attachments.length}):</strong>
            {record.attachments.map((a) => (
              <a key={a.hash} href={`/api/attachments/${a.hash}`} target="_blank" rel="noreferrer">
                {a.filename ?? a.contentId} ({a.size} B)
              </a>
            ))}
          </div>
        )}

        <ValidationPanel validation={record.validation} />
        <CxmlEditor value={record.body} readOnly height={420} />
      </div>
    </div>
  );
}
