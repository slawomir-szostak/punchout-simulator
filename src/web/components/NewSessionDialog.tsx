import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { CartItem, ConnectionWithParties, SessionSummary } from "../types";

export interface NewSessionChoice {
  connectionId: string;
  operation: "create" | "edit" | "inspect";
  /** Prior items carried into an edit/inspect setup. */
  items?: CartItem[];
}

// Modal for starting a Mode-A session: pick the connection, the SetupRequest
// operation, and — for edit/inspect — a source session whose returned cart
// supplies the prior items (inspect can narrow to a single item).
export function NewSessionDialog({
  connections,
  sessions,
  onCancel,
  onCreate,
}: {
  connections: ConnectionWithParties[];
  sessions: SessionSummary[];
  onCancel: () => void;
  onCreate: (choice: NewSessionChoice) => void;
}) {
  const buyerConns = connections.filter((c) => c.mode === "virtual-buyer");
  const [connectionId, setConnectionId] = useState(buyerConns[0]?.id ?? "");
  const [operation, setOperation] = useState<"create" | "edit" | "inspect">("create");
  const [sourceId, setSourceId] = useState("");
  const [sourceCart, setSourceCart] = useState<CartItem[] | null>(null);
  const [itemIdx, setItemIdx] = useState<number>(-1); // -1 = all items
  const ref = useRef<HTMLDivElement>(null);

  // Sessions that returned a cart make sensible edit/inspect sources.
  const sources = sessions.filter((s) => s.docTypes.includes("PunchOutOrderMessage"));

  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Load the chosen source session's cart so we can carry / pick its items.
  useEffect(() => {
    setSourceCart(null);
    setItemIdx(-1);
    if (!sourceId || operation === "create") return;
    api.getCart(sourceId).then((cart) => setSourceCart(cart?.items ?? [])).catch(() => setSourceCart([]));
  }, [sourceId, operation]);

  const needsSource = operation === "edit" || operation === "inspect";
  const canCreate =
    !!connectionId && (!needsSource || (!!sourceId && (sourceCart?.length ?? 0) > 0));

  const create = () => {
    let items: CartItem[] | undefined;
    if (needsSource && sourceCart) {
      items = operation === "inspect" && itemIdx >= 0 ? [sourceCart[itemIdx]] : sourceCart;
    }
    onCreate({ connectionId, operation, items });
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="New session" tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div><strong>New session</strong></div>
          <button className="btn-link" onClick={onCancel}>close ✕</button>
        </div>

        <div className="editor-form">
          <div className="form-row">
            <label>Connection</label>
            {buyerConns.length === 0 ? (
              <p className="form-error">No virtual-buyer connections. Create one in Connections first.</p>
            ) : (
              <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
                {buyerConns.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} ({c.buyer?.name} → {c.supplier?.name})</option>
                ))}
              </select>
            )}
          </div>

          <div className="form-row">
            <label>Operation</label>
            <select value={operation} onChange={(e) => setOperation(e.target.value as any)}>
              <option value="create">create — start a fresh cart</option>
              <option value="edit">edit — reopen a prior cart to modify</option>
              <option value="inspect">inspect — view a previously ordered item</option>
            </select>
            <span className="hint">
              {operation === "create" && "A new, empty punchout session."}
              {operation === "edit" && "Reopens a previous session's cart (sent as ItemOut) for editing."}
              {operation === "inspect" && "Sends a previously ordered item for a read-only view."}
            </span>
          </div>

          {needsSource && (
            <>
              <div className="form-row">
                <label>Source session <span className="hint">(its returned cart supplies the items)</span></label>
                {sources.length === 0 ? (
                  <p className="hint">No prior session with a returned cart yet — run a create session first.</p>
                ) : (
                  <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                    <option value="">— choose a session —</option>
                    {sources.map((s) => (
                      <option key={s.sessionId} value={s.sessionId}>
                        {(s.connectionName ?? s.sessionId)} · {s.lastTs ? new Date(s.lastTs).toLocaleString() : ""}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {operation === "inspect" && sourceCart && sourceCart.length > 0 && (
                <div className="form-row">
                  <label>Item to inspect</label>
                  <select value={itemIdx} onChange={(e) => setItemIdx(Number(e.target.value))}>
                    <option value={-1}>All items ({sourceCart.length})</option>
                    {sourceCart.map((it, i) => (
                      <option key={i} value={i}>{it.supplierPartId} — {it.description}</option>
                    ))}
                  </select>
                </div>
              )}
              {sourceId && sourceCart != null && sourceCart.length === 0 && (
                <p className="hint">That session has no cart items to carry.</p>
              )}
            </>
          )}

          <div className="form-actions">
            <button className="btn-primary" onClick={create} disabled={!canCreate}>Start session</button>
            <button className="btn-secondary" onClick={onCancel}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
