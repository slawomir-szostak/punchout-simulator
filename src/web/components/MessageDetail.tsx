import { useEffect, useState } from "react";
import type { LogRecord } from "../types";
import { api } from "../api";
import { CxmlEditor } from "./CxmlEditor";
import { ValidationPanel } from "./Validation";

type View = "cxml" | "raw";

export function MessageDetail({ record, onClose }: { record: LogRecord; onClose: () => void }) {
  const [view, setView] = useState<View>("cxml");
  const [raw, setRaw] = useState<string | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const isMultipart = /^multipart\//i.test(record.contentType ?? "");

  // Reset when a different record is opened in the (reused) modal.
  useEffect(() => {
    setView("cxml");
    setRaw(null);
    setRawError(null);
    setCopied(false);
  }, [record.id]);

  // Lazily fetch the reconstructed raw wire message the first time it's shown.
  useEffect(() => {
    if (view !== "raw" || raw !== null || rawError !== null) return;
    api
      .rawMessage(record.sessionId, record.id)
      .then(setRaw)
      .catch((e) => setRawError(e instanceof Error ? e.message : String(e)));
  }, [view, raw, rawError, record.sessionId, record.id]);

  const activeText = view === "raw" ? raw ?? "" : record.body;
  const copy = () => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(activeText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

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

        <div className="detail-toolbar">
          <div className="tabs">
            <button
              className={`tab ${view === "cxml" ? "active" : ""}`}
              onClick={() => setView("cxml")}
            >
              cXML
            </button>
            <button
              className={`tab ${view === "raw" ? "active" : ""}`}
              onClick={() => setView("raw")}
            >
              Raw{isMultipart ? " (multipart)" : ""}
            </button>
          </div>
          <button className="btn-secondary" onClick={copy} disabled={view === "raw" && raw === null}>
            {copied ? "Copied ✓" : "Copy"}
          </button>
        </div>

        {view === "cxml" ? (
          <CxmlEditor value={record.body} readOnly height={420} />
        ) : rawError ? (
          <p className="form-error">Could not load raw message: {rawError}</p>
        ) : raw === null ? (
          <p className="hint">Loading raw message…</p>
        ) : (
          <>
            {isMultipart && (
              <p className="hint">
                Full wire message (headers + multipart envelope). Binary attachment parts are shown
                decoded as text.
              </p>
            )}
            <CxmlEditor value={raw} readOnly height={420} language="plaintext" />
          </>
        )}
      </div>
    </div>
  );
}
