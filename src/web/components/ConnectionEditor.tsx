import { useEffect, useState } from "react";
import type { Buyer, Connection, ConnectionMode, Supplier } from "../types";
import { Field } from "./Field";
import { ConfirmButton, draftNameProps } from "./PartyEditors";

/** The connection a duplicate draft was copied from, when it has a secret. */
export interface SecretSource {
  id: string;
  name: string;
  supplierId: string;
}

/** What onSave receives: the form, plus the source to copy the secret from. */
export type ConnectionPayload = Partial<Connection> & { copySecretFrom?: string };

interface Props {
  connection: Connection | null; // null => new connection draft
  /** Prefill for a new draft (duplicate). */
  seed?: Partial<Connection>;
  /** Duplicate draft: the source whose stored secret can be copied server-side. */
  secretSource?: SecretSource;
  buyers: Buyer[];
  suppliers: Supplier[];
  onSave: (data: ConnectionPayload) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  onDuplicate?: () => void;
  onDiscard?: () => void;
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
export function ConnectionEditor({ connection, seed, secretSource, buyers, suppliers, onSave, onDelete, onDuplicate, onDiscard }: Props) {
  const initial = connection ?? seed ?? blank();
  const [form, setForm] = useState<Partial<Connection>>(initial);
  const [overrideSender, setOverrideSender] = useState<boolean>(!!initial.senderIdentity);
  const [copySecret, setCopySecret] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setForm(initial);
    setOverrideSender(!!initial.senderIdentity);
    setErr(null);
  }, [connection?.id]);

  // The stored secret belongs to the source supplier's endpoint, so it can only
  // be carried over while the draft still points at that supplier (the server
  // enforces the same rule).
  const canCopySecret = !!secretSource && form.supplierId === secretSource.supplierId;
  const willCopySecret = canCopySecret && copySecret && !form.sharedSecret;

  const set = (patch: Partial<Connection>) => setForm((f) => ({ ...f, ...patch }));
  const buyer = buyers.find((b) => b.id === form.buyerId);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const payload: ConnectionPayload = { ...form };
      if (!overrideSender) payload.senderIdentity = undefined;
      if (willCopySecret) payload.copySecretFrom = secretSource!.id;
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
        <input value={form.name ?? ""} onChange={(e) => set({ name: e.target.value })} placeholder="(auto)" {...draftNameProps(!!seed)} />
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
        {secretSource && !form.sharedSecret && (
          <label className="check-row">
            <input type="checkbox" checked={copySecret && canCopySecret} disabled={!canCopySecret} onChange={(e) => setCopySecret(e.target.checked)} />
            <span>
              Copy the shared secret from “{secretSource.name}”
              <span className="hint">
                {canCopySecret
                  ? " — or type a new one above"
                  : " — only possible while the supplier is the same; the secret belongs to that supplier"}
              </span>
            </span>
          </label>
        )}

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
        {connection && onDuplicate && (
          <button type="button" className="btn-secondary" onClick={onDuplicate} title="Copy this connection into a new, unsaved draft">
            Duplicate
          </button>
        )}
        {!connection && onDiscard && (
          <button type="button" className="btn-secondary" onClick={onDiscard} disabled={saving}>
            Discard
          </button>
        )}
        {connection && onDelete && <ConfirmButton onConfirm={() => onDelete(connection.id)} onError={setErr} />}
      </div>
    </div>
  );
}
