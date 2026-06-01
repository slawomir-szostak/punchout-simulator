import { useEffect, useState } from "react";
import { api } from "../api";
import type { Cart, Connection, OrderResult, SetupResult } from "../types";
import { CxmlEditor } from "./CxmlEditor";
import { CartView } from "./CartView";
import { ValidationPanel } from "./Validation";

interface Props {
  connection: Connection;
  carts: Record<string, Cart>;
}

interface AttachmentDraft {
  contentId: string;
  filename: string;
  contentType: string;
  dataBase64: string;
  scope: "order" | number;
}

// The Mode A driver UI: build/edit the SetupRequest, send it, watch the cart
// return, then build/edit and send the OrderRequest — with attachments and the
// dangling-cid test.
export function BuyerFlow({ connection, carts }: Props) {
  const [buyerCookie, setBuyerCookie] = useState<string>("");
  const [setupXml, setSetupXml] = useState<string>("");
  const [setupResult, setSetupResult] = useState<SetupResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [orderResult, setOrderResult] = useState<OrderResult | null>(null);
  const [danglingCid, setDanglingCid] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);

  const cart = buyerCookie ? carts[buyerCookie] ?? null : null;

  // Load a fresh SetupRequest preview whenever the connection changes.
  useEffect(() => {
    setSetupResult(null);
    setOrderResult(null);
    setAttachments([]);
    setError(null);
    api
      .setupPreview(connection.id)
      .then((p) => {
        setBuyerCookie(p.buyerCookie);
        setSetupXml(p.xml);
      })
      .catch((e) => setError(String(e)));
  }, [connection.id]);

  const refreshPreview = async () => {
    const p = await api.setupPreview(connection.id);
    setBuyerCookie(p.buyerCookie);
    setSetupXml(p.xml);
    setSetupResult(null);
  };

  const sendSetup = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.sendSetup(connection.id, { buyerCookie, xml: setupXml });
      setSetupResult(res);
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
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      drafts.push({
        contentId: file.name.replace(/[^a-zA-Z0-9._-]/g, "_"),
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        dataBase64: b64,
        scope: "order",
      });
    }
    setAttachments((a) => [...a, ...drafts]);
  };

  const sendOrder = async () => {
    if (!cart) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.sendOrder(connection.id, {
        sessionId: buyerCookie,
        items: cart.items,
        currency: cart.total?.currency ?? "USD",
        danglingCid,
        attachments: attachments.map((a) => ({
          contentId: a.contentId,
          filename: a.filename,
          contentType: a.contentType,
          dataBase64: a.dataBase64,
          scope: a.scope,
        })),
      });
      setOrderResult(res);
      if (res.transportError) setError(`Transport error: ${res.transportError}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flow">
      {error && <div className="form-error">{error}</div>}

      <section className="step">
        <h3>
          <span className="step-num">1</span> SetupRequest
        </h3>
        <div className="step-meta">
          BuyerCookie: <code>{buyerCookie}</code>
          <button className="btn-link" onClick={refreshPreview}>regenerate</button>
        </div>
        <CxmlEditor value={setupXml} onChange={setSetupXml} height={260} />
        <div className="step-actions">
          <button className="btn-primary" onClick={sendSetup} disabled={busy || !setupXml}>
            {busy ? "Sending…" : "Send SetupRequest →"}
          </button>
        </div>
        {setupResult && (
          <div className="result">
            <div className="result-line">
              HTTP {setupResult.httpStatus} · Status code {setupResult.statusCode ?? "—"}
            </div>
            {setupResult.startPage && (
              <div className="result-line">
                StartPage:{" "}
                <a href={setupResult.startPage} target="_blank" rel="noreferrer">
                  open catalog in new tab ↗
                </a>
              </div>
            )}
            <ValidationPanel validation={setupResult.request.validation} />
            <ValidationPanel validation={setupResult.response.validation} />
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
              {attachments.length === 0 ? (
                <p className="hint">No attachments. Add files to send a multipart/related OrderRequest.</p>
              ) : (
                <ul className="att-list">
                  {attachments.map((a, i) => (
                    <li key={i}>
                      <code>cid:{a.contentId}</code> · {a.filename} · {a.contentType} ·{" "}
                      {Math.round((a.dataBase64.length * 3) / 4)} B
                      <button
                        className="btn-link"
                        onClick={() => setAttachments((arr) => arr.filter((_, j) => j !== i))}
                      >
                        remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <label className="dangling-toggle">
                <input
                  type="checkbox"
                  checked={danglingCid}
                  onChange={(e) => setDanglingCid(e.target.checked)}
                  disabled={attachments.length === 0}
                />
                Dangling-<code>cid</code> test — reference attachments that aren't in the envelope, to
                verify the receiver detects the missing attachment
              </label>
            </div>
            <div className="step-actions">
              <button className="btn-primary" onClick={sendOrder} disabled={busy}>
                {busy ? "Sending…" : "Send OrderRequest →"}
              </button>
            </div>
          </>
        )}
        {orderResult && (
          <div className="result">
            <div className="result-line">
              HTTP {orderResult.httpStatus} · Status {orderResult.statusCode ?? "—"}{" "}
              {orderResult.statusText ?? ""}
            </div>
            <ValidationPanel validation={orderResult.request.validation} />
            <ValidationPanel validation={orderResult.response.validation} />
          </div>
        )}
      </section>
    </div>
  );
}
