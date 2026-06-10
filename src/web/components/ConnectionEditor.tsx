import { useEffect, useState } from "react";
import type { Buyer, Connection, ConnectionMode, Supplier } from "../types";
import { Field } from "./Field";
import { ConfirmButton } from "./PartyEditors";

interface Props {
  connection: Connection | null; // null => new connection draft
  buyers: Buyer[];
  suppliers: Supplier[];
  onSave: (data: Partial<Connection>) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
}

const blank = (): Partial<Connection> => ({
  buyerId: "",
  supplierId: "",
  mode: "virtual-buyer",
  sharedSecret: "",
  deploymentMode: "test",
  attachmentEncoding: "binary",
});

// A connection pairs a Buyer and a Supplier and holds only pair-specific data
// (mode + credentials). The endpoints and identities come from the parties.
export function ConnectionEditor({ connection, buyers, suppliers, onSave, onDelete }: Props) {
  const [form, setForm] = useState<Partial<Connection>>(connection ?? blank());
  const [overrideSender, setOverrideSender] = useState<boolean>(!!connection?.senderIdentity);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setForm(connection ?? blank());
    setOverrideSender(!!connection?.senderIdentity);
    setErr(null);
  }, [connection?.id]);

  const set = (patch: Partial<Connection>) => setForm((f) => ({ ...f, ...patch }));
  const buyer = buyers.find((b) => b.id === form.buyerId);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const payload = { ...form };
      if (!overrideSender) payload.senderIdentity = undefined;
      await onSave(payload);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const noParties = buyers.length === 0 || suppliers.length === 0;

  return (
    <div className="editor-form">
      {noParties && (
        <div className="form-error">
          Create at least one Buyer and one Supplier first (see the Buyers / Suppliers tabs).
        </div>
      )}

      <Field label={<>Name <span className="hint">(optional — defaults to "Buyer → Supplier")</span></>}>
        <input value={form.name ?? ""} onChange={(e) => set({ name: e.target.value })} placeholder="(auto)" />
      </Field>

      <div className="form-grid">
        <Field label="Buyer">
          <select value={form.buyerId ?? ""} onChange={(e) => set({ buyerId: e.target.value })}>
            <option value="">— select buyer —</option>
            {buyers.map((b) => (
              <option key={b.id} value={b.id}>{b.name} ({b.identity.domain}/{b.identity.identity})</option>
            ))}
          </select>
        </Field>
        <Field label="Supplier">
          <select value={form.supplierId ?? ""} onChange={(e) => set({ supplierId: e.target.value })}>
            <option value="">— select supplier —</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.identity.domain}/{s.identity.identity})</option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Mode">
        <select value={form.mode} onChange={(e) => set({ mode: e.target.value as ConnectionMode })}>
          <option value="virtual-buyer">Virtual Buyer (tool drives the supplier)</option>
          <option value="virtual-supplier">Virtual Supplier (tool serves the mock catalog)</option>
        </select>
      </Field>

      <fieldset>
        <legend>Credentials for this pair</legend>
        <Field label={<>Shared Secret <span className="hint">(the "password" this buyer uses at this supplier)</span></>}>
          <input
            type="password"
            autoComplete="off"
            value={form.sharedSecret ?? ""}
            onChange={(e) => set({ sharedSecret: e.target.value })}
            placeholder={
              (connection as { hasSharedSecret?: boolean } | null)?.hasSharedSecret
                ? "•••••• (set — leave blank to keep)"
                : "shared secret"
            }
          />
        </Field>

        <label className="dangling-toggle">
          <input type="checkbox" checked={overrideSender} onChange={(e) => setOverrideSender(e.target.checked)} />
          Override the Sender identity ("login") for this pair
        </label>
        {overrideSender ? (
          <div className="cred-pair">
            <input
              placeholder="sender domain"
              aria-label="Sender domain"
              value={form.senderIdentity?.domain ?? ""}
              onChange={(e) => set({ senderIdentity: { domain: e.target.value, identity: form.senderIdentity?.identity ?? "" } })}
            />
            <input
              placeholder="sender identity"
              aria-label="Sender identity"
              value={form.senderIdentity?.identity ?? ""}
              onChange={(e) => set({ senderIdentity: { domain: form.senderIdentity?.domain ?? "", identity: e.target.value } })}
            />
          </div>
        ) : (
          <p className="hint">
            Defaults to the buyer's identity
            {buyer ? <> (<code>{buyer.identity.domain}/{buyer.identity.identity}</code>)</> : null}.
          </p>
        )}
      </fieldset>

      <div className="form-grid">
        <Field label="Deployment">
          <select value={form.deploymentMode} onChange={(e) => set({ deploymentMode: e.target.value as any })}>
            <option value="test">test</option>
            <option value="production">production</option>
          </select>
        </Field>
      </div>

      <Field
        label={
          <>
            Attachment encoding{" "}
            <span className="hint">(Content-Transfer-Encoding for OrderRequest attachment parts)</span>
          </>
        }
      >
        <select
          value={form.attachmentEncoding ?? "binary"}
          onChange={(e) => set({ attachmentEncoding: e.target.value as any })}
        >
          <option value="binary">binary — raw bytes (compact; valid over HTTP)</option>
          <option value="base64">base64 — what most Ariba/Coupa receivers expect</option>
        </select>
      </Field>

      {err && <div className="form-error">{err}</div>}
      <div className="form-actions">
        <button className="btn-primary" onClick={save} disabled={saving || noParties}>
          {saving ? "Saving…" : connection ? "Save changes" : "Create connection"}
        </button>
        {connection && onDelete && <ConfirmButton onConfirm={() => onDelete(connection.id)} onError={setErr} />}
      </div>
    </div>
  );
}
