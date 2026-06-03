import { useEffect, useState } from "react";
import { api } from "../api";
import type { AttachmentDraft, Cart, CartItem, Connection, FlowSession, ValidationResult } from "../types";
import { CxmlEditor } from "./CxmlEditor";
import { CartView } from "./CartView";
import { ValidationPanel } from "./Validation";
import { useTheme } from "../hooks/useTheme";

// Append the app's current theme to the mock-catalog StartPage URL so that page
// (served from a possibly different origin) can match the app's light/dark mode.
const withTheme = (url: string, theme: string) =>
  url + (url.includes("?") ? "&" : "?") + "theme=" + theme;

interface Props {
  connection: Connection;
  session: FlowSession;
  cart: Cart | null;
  /** The session's PunchOutSetupRequest operation (create/edit/inspect). */
  operation?: string;
  /** Prior items carried in an edit/inspect setup. */
  sourceItems?: CartItem[];
  onChange: (patch: Partial<FlowSession>) => void;
}

// The Mode A driver UI for a single session. Session state lives in App so it
// survives tab switches and supports editing + retrying the OrderRequest.
export function BuyerFlow({ connection, session, cart, operation, sourceItems, onChange }: Props) {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachmentsDirty, setAttachmentsDirty] = useState(false);
  // On-demand "validate before send" results (cleared when the document is edited).
  const [setupCheck, setSetupCheck] = useState<ValidationResult | null>(null);
  const [orderCheck, setOrderCheck] = useState<ValidationResult | null>(null);

  const validate = async (docType: "SetupRequest" | "OrderRequest", xml: string, set: (v: ValidationResult) => void) => {
    setError(null);
    try {
      set(await api.validate(connection.id, { docType, xml }));
    } catch (e) {
      setError(String(e));
    }
  };

  // Lazily initialize the session's SetupRequest preview the first time this
  // connection's session is empty. Persisted edits are never clobbered.
  useEffect(() => {
    if (session.buyerCookie || session.setupXml) return;
    api
      .setupPreview(connection.id, { operation, items: sourceItems })
      .then((p) => onChange({ buyerCookie: p.buyerCookie, setupXml: p.xml }))
      .catch((e) => setError(String(e)));
  }, [connection.id, session.buyerCookie, session.setupXml, operation, sourceItems]);

  const sendSetup = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.sendSetup(connection.id, {
        buyerCookie: session.buyerCookie,
        xml: session.setupXml,
      });
      onChange({ setupResult: res, buyerCookie: res.buyerCookie });
      if (res.transportError) setError(`Transport error: ${res.transportError}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    const drafts: AttachmentDraft[] = [];
    for (const file of Array.from(files)) {
      const buf = await file.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      drafts.push({
        contentId: file.name.replace(/[^a-zA-Z0-9._-]/g, "_"),
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        dataBase64: btoa(binary),
        scope: "order",
      });
    }
    onChange({ attachments: [...session.attachments, ...drafts] });
    setAttachmentsDirty(true);
  };

  const updateAttachment = (i: number, patch: Partial<AttachmentDraft>) => {
    onChange({
      attachments: session.attachments.map((a, j) => (j === i ? { ...a, ...patch } : a)),
    });
    setAttachmentsDirty(true);
  };

  const removeAttachment = (i: number) => {
    onChange({ attachments: session.attachments.filter((_, j) => j !== i) });
    setAttachmentsDirty(true);
  };

  const attachmentMeta = () =>
    session.attachments.map((a) => ({ contentId: a.contentId, scope: a.scope }));

  const buildOrder = async () => {
    if (!cart) return;
    setBusy(true);
    setError(null);
    try {
      const { xml } = await api.orderPreview(connection.id, {
        sessionId: session.buyerCookie,
        items: cart.items,
        currency: cart.total?.currency ?? "USD",
        attachments: attachmentMeta(),
      });
      onChange({ orderXml: xml });
      setAttachmentsDirty(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const sendOrder = async () => {
    if (!cart) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.sendOrder(connection.id, {
        sessionId: session.buyerCookie,
        xml: session.orderXml || undefined, // send the edited cXML if present
        items: cart.items,
        currency: cart.total?.currency ?? "USD",
        danglingCid: session.danglingCid,
        attachments: session.attachments,
      });
      onChange({ orderResult: res });
      if (res.transportError) setError(`Transport error: ${res.transportError}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const itemScopeOptions = cart?.items ?? [];

  return (
    <div className="flow">
      {error && <div className="form-error">{error}</div>}

      <section className="step">
        <h3>
          <span className="step-num">1</span> SetupRequest
        </h3>
        <div className="step-meta">
          Session (BuyerCookie): <code>{session.buyerCookie || "…"}</code>
          {operation && operation !== "create" && <span className="badge badge-warn" style={{ marginLeft: ".5rem" }}>{operation}</span>}
        </div>
        <CxmlEditor value={session.setupXml} onChange={(v) => { onChange({ setupXml: v }); setSetupCheck(null); }} height={240} />
        <div className="step-actions">
          <button className="btn-primary" onClick={sendSetup} disabled={busy || !session.setupXml}>
            {busy ? "Working…" : "Send SetupRequest →"}
          </button>
          <button className="btn-secondary" onClick={() => validate("SetupRequest", session.setupXml, setSetupCheck)} disabled={busy || !session.setupXml}>
            Validate
          </button>
        </div>
        {setupCheck && (
          <div className="precheck">
            <span className="precheck-label">Pre-send validation</span>
            <ValidationPanel validation={setupCheck} />
          </div>
        )}
        {session.setupResult && (
          <div className="result">
            <div className="result-line">
              HTTP {session.setupResult.httpStatus} · Status {session.setupResult.statusCode ?? "—"}
            </div>
            {session.setupResult.startPage && (
              <div className="result-line">
                StartPage:{" "}
                <a href={withTheme(session.setupResult.startPage, theme)} target="_blank" rel="noreferrer">
                  open catalog in new tab ↗
                </a>
              </div>
            )}
            <ValidationPanel validation={session.setupResult.request.validation} />
            <ValidationPanel validation={session.setupResult.response.validation} />
          </div>
        )}
      </section>

      <section className="step">
        <h3>
          <span className="step-num">2</span> Cart (punchback)
        </h3>
        <p className="hint">
          After you shop on the StartPage and return the cart, the punchback POSTs to the tool's
          callback and appears here live.
        </p>
        <CartView cart={cart} />
      </section>

      <section className="step">
        <h3>
          <span className="step-num">3</span> OrderRequest
        </h3>
        {!cart ? (
          <p className="hint">Waiting for a cart before building the OrderRequest.</p>
        ) : (
          <>
            <div className="attachments">
              <div className="attachments-head">
                <strong>Attachments</strong>
                <label className="btn-secondary file-btn">
                  + Add file
                  <input type="file" multiple hidden onChange={(e) => addFiles(e.target.files)} />
                </label>
              </div>
              {session.attachments.length === 0 ? (
                <p className="hint">No attachments. Add files to send a multipart/related OrderRequest.</p>
              ) : (
                <ul className="att-list">
                  {session.attachments.map((a, i) => (
                    <li key={i} className="att-row">
                      <code>cid:{a.contentId}</code>
                      <span className="att-file">{a.filename}</span>
                      <select
                        className="att-scope"
                        value={String(a.scope)}
                        onChange={(e) =>
                          updateAttachment(i, {
                            scope: e.target.value === "order" ? "order" : Number(e.target.value),
                          })
                        }
                        title="Attach to the whole order, or to a specific line item"
                      >
                        <option value="order">whole order</option>
                        {itemScopeOptions.map((it, idx) => (
                          <option key={idx} value={idx + 1}>
                            item {idx + 1}: {it.supplierPartId}
                          </option>
                        ))}
                      </select>
                      <button className="btn-link" onClick={() => removeAttachment(i)}>
                        remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <label className="dangling-toggle">
                <input
                  type="checkbox"
                  checked={session.danglingCid}
                  onChange={(e) => onChange({ danglingCid: e.target.checked })}
                  disabled={session.attachments.length === 0}
                />
                Dangling-<code>cid</code> test — reference attachments that aren't in the envelope, to
                verify the receiver detects the missing attachment
              </label>
            </div>

            <div className="step-actions">
              <button className="btn-secondary" onClick={buildOrder} disabled={busy}>
                {session.orderXml ? "Rebuild from cart & attachments" : "Build OrderRequest"}
              </button>
            </div>

            {attachmentsDirty && session.orderXml && (
              <p className="hint warn-hint">
                Attachments changed — rebuild to refresh the <code>cid</code> references, or edit the
                <code>&lt;Comments&gt;</code> below by hand.
              </p>
            )}

            {session.orderXml && (
              <>
                <p className="hint">
                  Edit the OrderRequest before sending — e.g. tweak <code>&lt;Comments&gt;</code>,
                  addresses, or attachment references. This exact document is what gets sent.
                </p>
                <CxmlEditor
                  value={session.orderXml}
                  onChange={(v) => { onChange({ orderXml: v }); setOrderCheck(null); }}
                  height={300}
                />
                <div className="step-actions">
                  <button className="btn-primary" onClick={sendOrder} disabled={busy}>
                    {busy ? "Working…" : session.orderResult ? "Re-send OrderRequest ↻" : "Send OrderRequest →"}
                  </button>
                  <button className="btn-secondary" onClick={() => validate("OrderRequest", session.orderXml, setOrderCheck)} disabled={busy || !session.orderXml}>
                    Validate
                  </button>
                </div>
                {orderCheck && (
                  <div className="precheck">
                    <span className="precheck-label">Pre-send validation</span>
                    <ValidationPanel validation={orderCheck} />
                  </div>
                )}
              </>
            )}
          </>
        )}
        {session.orderResult && (
          <div className="result">
            <div className="result-line">
              HTTP {session.orderResult.httpStatus} · Status {session.orderResult.statusCode ?? "—"}{" "}
              {session.orderResult.statusText ?? ""}
            </div>
            <ValidationPanel validation={session.orderResult.request.validation} />
            <ValidationPanel validation={session.orderResult.response.validation} />
          </div>
        )}
      </section>
    </div>
  );
}
