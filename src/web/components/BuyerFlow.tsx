import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AttachmentDraft, Cart, CartItem, Connection, FlowSession, ValidationResult } from "../types";
import { CxmlEditor } from "./CxmlEditor";
import { CartView } from "./CartView";
import { CatalogFrame } from "./CatalogFrame";
import { CxmlSummary } from "./CxmlSummary";
import { ValidationPanel, ValidationSummary } from "./Validation";
import { useTheme } from "../hooks/useTheme";

// Append the app's current theme to the mock-catalog StartPage URL so that page
// (served from a possibly different origin) can match the app's light/dark mode.
const withTheme = (url: string, theme: string) =>
  url + (url.includes("?") ? "&" : "?") + "theme=" + theme;

// The StartPage comes verbatim from the remote supplier's response. Only treat
// it as a clickable link when it is an http(s) URL, so a malicious/buggy
// supplier can't slip a javascript:/data: href into the buyer-side UI.
const isHttpUrl = (url: string): boolean => {
  try {
    const p = new URL(url).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
};

type StepStatus = "pending" | "active" | "done" | "error";

// What the counterparty actually said: cXML Status code + text, and the
// Status body where suppliers put order numbers and rejection reasons.
function SupplierReply(o: { ok: boolean; code?: string; text?: string; message?: string; transportError?: string }) {
  const headline = o.transportError
    ? `Transport error: ${o.transportError}`
    : `Status ${o.code ?? "—"}${o.text ? ` ${o.text}` : ""}`;
  return (
    <div className={`supplier-reply ${o.ok ? "supplier-reply-ok" : "supplier-reply-bad"}`}>
      <span className="supplier-reply-icon">{o.ok ? "✓" : "⚠"}</span>
      <div>
        <div className="supplier-reply-head">Supplier response · {headline}</div>
        {o.message && <div className="supplier-reply-msg">{o.message}</div>}
        {!o.message && !o.transportError && <div className="hint">No message in the Status body.</div>}
      </div>
    </div>
  );
}

const stepNum = (status: StepStatus, n: number) => (status === "done" ? "✓" : status === "error" ? "!" : String(n));

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
  // Catalog embedded in an iframe overlay (vs. the default new tab). Holds the
  // cart seen when opened so the overlay can tell when a new one has landed.
  const [embedded, setEmbedded] = useState<{ cartAtOpen: Cart | null } | null>(null);
  // The cXML editors start collapsed behind a one-line digest: most runs never
  // edit the SetupRequest, and the OrderRequest folds away once it has been sent.
  const [setupOpen, setSetupOpen] = useState(false);
  const [orderOpen, setOrderOpen] = useState(!session.orderResult);

  // Step states drive the badges, the highlighted "current" step and which
  // button is primary. A step is "done" when its exchange actually succeeded.
  const setupOk = !!session.setupResult && !session.setupResult.transportError && !!session.setupResult.startPage;
  const setupStatus: StepStatus = setupOk ? "done" : session.setupResult ? "error" : "active";
  const cartStatus: StepStatus = cart ? "done" : setupOk ? "active" : "pending";
  const orderOk = !!session.orderResult && !session.orderResult.transportError;
  const orderStatus: StepStatus = orderOk ? "done" : session.orderResult ? "error" : cart ? "active" : "pending";

  // Bring the cart into view the moment the punchback lands — it arrives from
  // another tab or the iframe, usually below the fold.
  const cartRef = useRef<HTMLElement>(null);
  const hadCart = useRef(!!cart);
  useEffect(() => {
    if (cart && !hadCart.current) cartRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    hadCart.current = !!cart;
  }, [cart]);

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

  const closeEmbedded = useCallback(() => setEmbedded(null), []);

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
      else setOrderOpen(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const itemScopeOptions = cart?.items ?? [];
  const startPage = session.setupResult?.startPage;
  const startPageLinked = !!startPage && isHttpUrl(startPage);
  const catalogHref = startPageLinked ? withTheme(startPage, theme) : "";
  const openEmbedded = () => setEmbedded({ cartAtOpen: cart });

  const copyStartPage = async () => {
    if (!startPage) return;
    try {
      await navigator.clipboard.writeText(startPage);
    } catch {
      /* clipboard unavailable (insecure context) — the URL is still visible to select */
    }
  };

  return (
    <div className="flow">
      {error && <div className="form-error">{error}</div>}

      <section className={`step step-${setupStatus}`}>
        <h3>
          <span className="step-num">{stepNum(setupStatus, 1)}</span> SetupRequest
          {session.setupResult && (
            <span className={`step-status ${setupStatus === "done" ? "step-status-ok" : "step-status-err"}`}>
              {session.setupResult.transportError
                ? "transport error"
                : `HTTP ${session.setupResult.httpStatus} · Status ${session.setupResult.statusCode ?? "—"}`}
            </span>
          )}
        </h3>
        <div className="step-meta">
          Session (BuyerCookie): <code>{session.buyerCookie || "…"}</code>
          {operation && operation !== "create" && <span className="badge badge-warn" style={{ marginLeft: ".5rem" }}>{operation}</span>}
        </div>
        <CxmlSummary xml={session.setupXml} open={setupOpen} onToggle={() => setSetupOpen((o) => !o)} />
        {setupOpen && (
          <CxmlEditor value={session.setupXml} onChange={(v) => { onChange({ setupXml: v }); setSetupCheck(null); }} height={240} />
        )}
        <div className="step-actions">
          <button
            className={setupStatus === "done" ? "btn-secondary" : "btn-primary"}
            onClick={sendSetup}
            disabled={busy || !session.setupXml}
          >
            {busy ? "Working…" : setupStatus === "done" ? "Re-send SetupRequest ↻" : "Send SetupRequest →"}
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
            {startPage && !startPageLinked && (
              <div className="result-line">
                StartPage: <code title="not an http(s) URL — not linked">{startPage}</code>
              </div>
            )}
            {startPageLinked && !cart && (
              <div className="next-action">
                <div className="next-action-text">
                  <strong>Next: shop the catalog</strong>
                  <span className="hint">
                    Open the supplier's StartPage, add items and return the cart — it lands in step 2 automatically.
                  </span>
                </div>
                <div className="next-action-buttons">
                  <a className="btn-primary" href={catalogHref} target="_blank" rel="noreferrer">
                    Open catalog ↗
                  </a>
                  <button className="btn-secondary" onClick={openEmbedded} title="Embed the catalog in an iframe, as some procurement systems do">
                    Open embedded (iframe)
                  </button>
                </div>
                <div className="next-action-url">
                  <code title={startPage}>{startPage}</code>
                  <button className="btn-link" onClick={copyStartPage}>copy</button>
                </div>
              </div>
            )}
            {startPageLinked && cart && (
              <div className="result-line">
                StartPage:{" "}
                <a href={catalogHref} target="_blank" rel="noreferrer">open again ↗</a>
                <button className="btn-link" onClick={openEmbedded}>open embedded</button>
              </div>
            )}
            {(session.setupResult.statusMessage || session.setupResult.transportError || (session.setupResult.statusCode && session.setupResult.statusCode !== "200")) && (
              <SupplierReply
                ok={setupOk && session.setupResult.statusCode === "200"}
                code={session.setupResult.statusCode}
                message={session.setupResult.statusMessage}
                transportError={session.setupResult.transportError}
              />
            )}
            <ValidationSummary validations={[session.setupResult.request.validation, session.setupResult.response.validation]} />
          </div>
        )}
      </section>

      {embedded && startPageLinked && (
        <CatalogFrame src={catalogHref} cartAtOpen={embedded.cartAtOpen} cart={cart} onClose={closeEmbedded} />
      )}

      <section className={`step step-${cartStatus}`} ref={cartRef}>
        <h3>
          <span className="step-num">{stepNum(cartStatus, 2)}</span> Cart (punchback)
          {cartStatus === "active" && (
            <span className="step-status">
              <span className="pulse-dot" /> waiting for the punchback…
            </span>
          )}
          {cart && (
            <span className="step-status step-status-ok">
              {cart.items.length} item{cart.items.length === 1 ? "" : "s"}
              {cart.total ? ` · ${cart.total.currency} ${cart.total.amount.toFixed(2)}` : ""}
            </span>
          )}
        </h3>
        {cartStatus === "pending" ? (
          <p className="hint">Send the SetupRequest first — the cart the user returns from the catalog lands here.</p>
        ) : (
          <CartView cart={cart} />
        )}
      </section>

      <section className={`step step-${orderStatus}`}>
        <h3>
          <span className="step-num">{stepNum(orderStatus, 3)}</span> OrderRequest
          {session.orderResult && (
            <span className={`step-status ${orderStatus === "done" ? "step-status-ok" : "step-status-err"}`}>
              {session.orderResult.transportError
                ? "transport error"
                : `HTTP ${session.orderResult.httpStatus} · Status ${session.orderResult.statusCode ?? "—"} ${session.orderResult.statusText ?? ""}`}
            </span>
          )}
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

            {!session.orderXml && (
              <div className="step-actions">
                <button className="btn-primary" onClick={buildOrder} disabled={busy}>
                  {busy ? "Working…" : "Build OrderRequest →"}
                </button>
              </div>
            )}

            {attachmentsDirty && session.orderXml && (
              <p className="hint warn-hint">
                Attachments changed — rebuild to refresh the <code>cid</code> references, or edit the
                <code>&lt;Comments&gt;</code> below by hand.
              </p>
            )}

            {session.orderXml && (
              <>
                <CxmlSummary xml={session.orderXml} open={orderOpen} onToggle={() => setOrderOpen((o) => !o)} />
                {orderOpen && (
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
                  </>
                )}
                <div className="step-actions">
                  <button className={orderStatus === "done" ? "btn-secondary" : "btn-primary"} onClick={sendOrder} disabled={busy}>
                    {busy ? "Working…" : session.orderResult ? "Re-send OrderRequest ↻" : "Send OrderRequest →"}
                  </button>
                  <button className="btn-secondary" onClick={() => validate("OrderRequest", session.orderXml, setOrderCheck)} disabled={busy || !session.orderXml}>
                    Validate
                  </button>
                  <button className="btn-secondary" onClick={buildOrder} disabled={busy} title="Regenerate the document from the cart and the attachment list">
                    Rebuild from cart
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
            <SupplierReply
              ok={orderStatus === "done" && session.orderResult.statusCode === "200"}
              code={session.orderResult.statusCode}
              text={session.orderResult.statusText}
              message={session.orderResult.statusMessage}
              transportError={session.orderResult.transportError}
            />
            <ValidationSummary validations={[session.orderResult.request.validation, session.orderResult.response.validation]} />
          </div>
        )}
      </section>
    </div>
  );
}
