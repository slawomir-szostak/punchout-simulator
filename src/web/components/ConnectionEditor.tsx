import { useEffect, useState } from "react";
import type { Connection, ConnectionMode } from "../types";

interface Props {
  connection: Connection | null; // null => new connection draft
  onSave: (data: Partial<Connection>) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
}

const blank: Partial<Connection> = {
  name: "",
  mode: "virtual-buyer",
  from: { domain: "DUNS", identity: "" },
  to: { domain: "DUNS", identity: "" },
  sender: { domain: "DUNS", identity: "" },
  sharedSecret: "",
  deploymentMode: "test",
  authStyle: "SharedSecret",
  punchoutUrl: "",
  orderUrl: "",
};

export function ConnectionEditor({ connection, onSave, onDelete }: Props) {
  const [form, setForm] = useState<Partial<Connection>>(connection ?? blank);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setForm(connection ?? blank);
    setErr(null);
  }, [connection?.id]);

  const set = (patch: Partial<Connection>) => setForm((f) => ({ ...f, ...patch }));
  const setCred = (key: "from" | "to" | "sender", patch: Partial<Connection["from"]>) =>
    setForm((f) => ({ ...f, [key]: { ...(f[key] as any), ...patch } }));

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      await onSave(form);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const isBuyer = form.mode === "virtual-buyer";

  return (
    <div className="editor-form">
      <div className="form-row">
        <label>Name</label>
        <input value={form.name ?? ""} onChange={(e) => set({ name: e.target.value })} placeholder="My supplier integration" />
      </div>

      <div className="form-row">
        <label>Mode</label>
        <select value={form.mode} onChange={(e) => set({ mode: e.target.value as ConnectionMode })}>
          <option value="virtual-buyer">Virtual Buyer (tool drives a supplier)</option>
          <option value="virtual-supplier">Virtual Supplier (tool serves a mock catalog)</option>
        </select>
      </div>

      <fieldset>
        <legend>Identities</legend>
        <p className="hint">
          Convention: <code>From</code>/<code>Sender</code> = the identity the tool presents (the role
          it plays); <code>To</code> = the counterparty.
        </p>
        {(["from", "to", "sender"] as const).map((key) => (
          <div className="cred-row" key={key}>
            <span className="cred-label">{key}</span>
            <input
              placeholder="domain (e.g. DUNS, NetworkID)"
              value={(form[key] as any)?.domain ?? ""}
              onChange={(e) => setCred(key, { domain: e.target.value })}
            />
            <input
              placeholder="identity"
              value={(form[key] as any)?.identity ?? ""}
              onChange={(e) => setCred(key, { identity: e.target.value })}
            />
          </div>
        ))}
      </fieldset>

      <div className="form-row">
        <label>Shared Secret</label>
        <input
          type="text"
          value={form.sharedSecret ?? ""}
          onChange={(e) => set({ sharedSecret: e.target.value })}
          placeholder="shared secret"
        />
      </div>

      <div className="form-grid">
        <div className="form-row">
          <label>Deployment</label>
          <select value={form.deploymentMode} onChange={(e) => set({ deploymentMode: e.target.value as any })}>
            <option value="test">test</option>
            <option value="production">production</option>
          </select>
        </div>
        <div className="form-row">
          <label>Auth style</label>
          <select value={form.authStyle} onChange={(e) => set({ authStyle: e.target.value as any })}>
            <option value="SharedSecret">SharedSecret</option>
            <option value="MAC">MAC</option>
          </select>
        </div>
      </div>

      {isBuyer ? (
        <>
          <div className="form-row">
            <label>PunchOut URL <span className="hint">(supplier setup endpoint)</span></label>
            <input value={form.punchoutUrl ?? ""} onChange={(e) => set({ punchoutUrl: e.target.value })} placeholder="https://supplier.example.com/punchout" />
          </div>
          <div className="form-row">
            <label>Order URL <span className="hint">(supplier order endpoint)</span></label>
            <input value={form.orderUrl ?? ""} onChange={(e) => set({ orderUrl: e.target.value })} placeholder="https://supplier.example.com/order" />
          </div>
        </>
      ) : (
        <p className="hint">
          Virtual-supplier mode serves a built-in mock catalog. Point a real buyer system (or a
          virtual-buyer connection) at <code>/sim/&lt;id&gt;/punchout</code> and <code>/sim/&lt;id&gt;/order</code>.
        </p>
      )}

      {err && <div className="form-error">{err}</div>}

      <div className="form-actions">
        <button className="btn-primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : connection ? "Save changes" : "Create connection"}
        </button>
        {connection && onDelete && (
          <button className="btn-danger" onClick={() => onDelete(connection.id)}>
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
