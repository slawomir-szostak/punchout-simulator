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

  // Where the request will go. Only a Profile URL is a place the supplier was
  // asked on purpose; without one the PunchOut (else the order) URL is tried.
  const target = supplier?.profileUrl
    ? { url: supplier.profileUrl, source: "profileUrl" as const }
    : supplier?.punchoutUrl
      ? { url: supplier.punchoutUrl, source: "punchoutUrl" as const }
      : supplier?.orderUrl
        ? { url: supplier.orderUrl, source: "orderUrl" as const }
        : undefined;
  const sourceName = { profileUrl: "Profile URL", punchoutUrl: "PunchOut URL", orderUrl: "order URL" };

  // Four outcomes, and only two of them are bad news:
  //  profile    — the supplier answered with its profile;
  //  no-profile — it answered in cXML, but with an error instead of a profile.
  //               The endpoint is reachable and speaks cXML; it just does not
  //               serve a ProfileRequest (there, or at all). Common in practice.
  //  rejected   — it answered 401/403: the credentials were refused;
  //  failed     — no cXML answer at all (wrong URL, not a cXML endpoint, network).
  const unreadable = result?.response.validation?.issues.find((i) => i.code === "not-well-formed" || i.code === "not-cxml")?.message;
  const outcome = !result
    ? undefined
    : result.transportError || !result.statusCode
      ? "failed"
      : result.profile
        ? "profile"
        : result.statusCode === "401" || result.statusCode === "403"
          ? "rejected"
          : "no-profile";
  const fallback = !!result && result.urlSource !== "profileUrl";

  return (
    <fieldset>
      <legend>Supplier profile <span className="hint">(cXML ProfileRequest — what the supplier supports, and where)</span></legend>
      <p className="hint">
        Asks the supplier which requests it accepts and at which URLs. It also works as a ping: a quick check that the
        endpoint answers cXML and accepts this connection's credentials, before you open a session.
      </p>
      {target && (
        <p className="hint">
          {target.source === "profileUrl" ? (
            <>Goes to the supplier's Profile URL: <code>{target.url}</code></>
          ) : (
            <>
              No Profile URL is set on the supplier, so this goes to its {sourceName[target.source]}:{" "}
              <code>{target.url}</code>. A supplier with one cXML endpoint for everything will answer there. One with a
              separate endpoint per request usually will not — it will reply with an error, which still tells you the
              endpoint is reachable.
            </>
          )}
        </p>
      )}
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
          <div className={`supplier-reply ${outcome === "profile" ? "supplier-reply-ok" : outcome === "no-profile" ? "supplier-reply-partial" : "supplier-reply-bad"}`}>
            <span className="supplier-reply-icon">{outcome === "profile" ? "✓" : outcome === "no-profile" ? "ℹ" : "⚠"}</span>
            <div>
              <div className="supplier-reply-head">
                {result.transportError
                  ? `Transport error: ${result.transportError}`
                  : `${result.url} · HTTP ${result.httpStatus} · ${result.statusCode ? `Status ${result.statusCode}` : "not a cXML document"}`}
              </div>
              <div className="supplier-reply-msg">
                {outcome === "profile" && `The supplier answered with its profile: ${result.profile!.transactions.length} supported request type(s).`}
                {outcome === "no-profile" && "The endpoint is reachable and speaks cXML, but it did not return a profile."}
                {outcome === "rejected" && "The endpoint speaks cXML, but refused this connection's credentials."}
                {outcome === "failed" && (unreadable ?? "No cXML answer.")}
              </div>
              {(outcome === "no-profile" || outcome === "rejected") && result.statusMessage && (
                <div className="supplier-reply-note">It said: “{result.statusMessage}”</div>
              )}
              {outcome === "no-profile" && (
                <div className="supplier-reply-note">
                  {fallback ? (
                    <>
                      That is the usual answer from an endpoint that accepts only a{" "}
                      {result.urlSource === "punchoutUrl" ? "PunchOutSetupRequest" : "OrderRequest"}: the request was sent
                      to the supplier's {sourceName[result.urlSource]} because no Profile URL is set. So the URL is right
                      and the server is up — this is not a connection problem. If the supplier has a separate profile
                      URL, set it under Suppliers → Profile URL; many suppliers have none, and then you can simply open a
                      session.
                    </>
                  ) : (
                    <>
                      This is the supplier's Profile URL, so it was expected to answer. Its message above says why it
                      did not; the supplier may not implement the Profile transaction.
                    </>
                  )}
                </div>
              )}
              {outcome === "rejected" && (
                <div className="supplier-reply-note">Check the connection's shared secret and the sender identity.</div>
              )}
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
