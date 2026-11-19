import { useState } from "react";
import { api } from "../api";
import type { ProfileResult, Supplier } from "../types";
import { ValidationSummary } from "./Validation";

// Sends a cXML ProfileRequest over a virtual-buyer connection and shows what
// the supplier advertises: the requests it accepts and where. Every cXML
// server must answer one, so it is also the cheapest way to check that the
// endpoint is reachable and the credentials are accepted — before a session.
export function SupplierProfileCheck({
  connectionId,
  supplier,
  onSupplierChanged,
  onOpenSession,
}: {
  connectionId: string;
  supplier?: Supplier;
  /** Called after the supplier's URLs were updated from the profile. */
  onSupplierChanged: () => Promise<void> | void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProfileResult | null>(null);
  const [applied, setApplied] = useState(false);

  const send = async () => {
    setBusy(true);
    setError(null);
    setApplied(false);
    try {
      setResult(await api.sendProfile(connectionId));
    } catch (e) {
      setResult(null);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Take over the URLs the supplier advertises for the requests this tool sends.
  const apply = async () => {
    if (!result || !supplier) return;
    setBusy(true);
    setError(null);
    try {
      const patch = Object.fromEntries(result.differences.map((d) => [d.field, d.advertised]));
      await api.suppliers.update(supplier.id, { ...supplier, ...patch });
      await onSupplierChanged();
      setApplied(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const ok = !!result && !result.transportError && !!result.profile;
  const unreadable = result?.response.validation?.issues.find((i) => i.code === "not-well-formed" || i.code === "not-cxml")?.message;

  return (
    <fieldset>
      <legend>Supplier profile <span className="hint">(cXML ProfileRequest — what the supplier supports, and where)</span></legend>
      <p className="hint">
        Asks the supplier which requests it accepts and at which URLs. It also works as a ping: a quick check that the
        endpoint answers cXML and accepts this connection's credentials, before you open a session.
      </p>
      <div className="step-actions" style={{ marginTop: 0 }}>
        <button className="btn-secondary" onClick={send} disabled={busy}>
          {busy ? "Working…" : result ? "Send ProfileRequest again ↻" : "Send ProfileRequest →"}
        </button>
        {result && (
          <button className="btn-link" onClick={() => onOpenSession(result.sessionId)}>
            show the two messages ↗
          </button>
        )}
      </div>
      {error && <div className="form-error">{error}</div>}

      {result && (
        <div className="result">
          <div className={`supplier-reply ${ok ? "supplier-reply-ok" : "supplier-reply-bad"}`}>
            <span className="supplier-reply-icon">{ok ? "✓" : "⚠"}</span>
            <div>
              <div className="supplier-reply-head">
                {result.transportError
                  ? `Transport error: ${result.transportError}`
                  : `${result.url} · HTTP ${result.httpStatus} · ${result.statusCode ? `Status ${result.statusCode}` : "not a cXML document"}`}
              </div>
              <div className="supplier-reply-msg">
                {ok
                  ? `The supplier answered with its profile: ${result.profile!.transactions.length} supported request type(s).`
                  : (result.statusMessage ?? unreadable ?? (result.statusCode ? "The supplier answered, but without a profile." : ""))}
              </div>
            </div>
          </div>

          {result.profile && (
            <>
              <table className="cart-table">
                <thead>
                  <tr>
                    <th>Request</th>
                    <th>Send it to</th>
                    <th>Options</th>
                  </tr>
                </thead>
                <tbody>
                  {result.profile.transactions.map((t, i) => (
                    <tr key={i}>
                      <td>{t.requestName}</td>
                      <td><code>{t.url}</code></td>
                      <td>{t.options.length ? t.options.map((o) => `${o.name} = ${o.value}`).join(" · ") : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="hint">
                Services available since <code>{result.profile.effectiveDate ?? "—"}</code>
                {result.profile.lastRefresh && <> · profile last refreshed <code>{result.profile.lastRefresh}</code></>}
                {result.profile.options.length > 0 && <> · {result.profile.options.map((o) => `${o.name} = ${o.value}`).join(" · ")}</>}
              </p>

              {result.differences.length > 0 && !applied && (
                <div className="precheck">
                  <span className="precheck-label">The supplier advertises different URLs than this tool has configured</span>
                  <ul className="issue-list">
                    {result.differences.map((d) => (
                      <li key={d.field} className="issue issue-warning">
                        <span className="issue-sev">{d.requestName}</span>
                        <span className="issue-msg">
                          configured <code>{d.configured || "(none)"}</code> → advertised <code>{d.advertised}</code>
                        </span>
                      </li>
                    ))}
                  </ul>
                  {supplier && (
                    <div className="step-actions">
                      <button className="btn-secondary" onClick={apply} disabled={busy}>
                        Use the advertised URLs on {supplier.name}
                      </button>
                    </div>
                  )}
                </div>
              )}
              {applied && <p className="hint">The supplier's URLs were updated from its profile.</p>}
              {result.differences.length === 0 && !applied && (
                <p className="hint">The PunchOut and order URLs configured on the supplier match what it advertises.</p>
              )}
            </>
          )}
          <ValidationSummary validations={[result.request.validation, result.response.validation]} />
        </div>
      )}
    </fieldset>
  );
}
