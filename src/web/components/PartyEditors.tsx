import { useEffect, useState } from "react";
import type { Buyer, CatalogItem, Credential, Profile, Supplier } from "../types";

// Editors for the standalone Buyer and Supplier entities. Each holds only the
// attributes intrinsic to that party (see the normalized model).

function CredentialFields({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: Credential;
  onChange: (c: Credential) => void;
  hint?: string;
}) {
  return (
    <div className="form-row">
      <label>{label}{hint && <span className="hint"> — {hint}</span>}</label>
      <div className="cred-pair">
        <input
          placeholder="domain (e.g. DUNS, NetworkID)"
          value={value.domain}
          onChange={(e) => onChange({ ...value, domain: e.target.value })}
        />
        <input
          placeholder="identity"
          value={value.identity}
          onChange={(e) => onChange({ ...value, identity: e.target.value })}
        />
      </div>
    </div>
  );
}

export function useDraft<T>(initial: T, depsKey: string) {
  const [draft, setDraft] = useState<T>(initial);
  useEffect(() => setDraft(initial), [depsKey]);
  return [draft, setDraft] as const;
}

export interface SaveProps {
  onSave: (data: any) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
}

export function Actions({
  saving,
  err,
  isNew,
  noun,
  onSave,
  onDelete,
}: {
  saving: boolean;
  err: string | null;
  isNew: boolean;
  noun: string;
  onSave: () => void;
  onDelete?: () => void;
}) {
  return (
    <>
      {err && <div className="form-error">{err}</div>}
      <div className="form-actions">
        <button className="btn-primary" onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : isNew ? `Create ${noun}` : "Save changes"}
        </button>
        {!isNew && onDelete && (
          <button className="btn-danger" onClick={onDelete}>
            Delete
          </button>
        )}
      </div>
    </>
  );
}

const blankCred = (): Credential => ({ domain: "DUNS", identity: "" });

export function BuyerEditor({
  buyer,
  profiles,
  onSave,
  onDelete,
}: { buyer: Buyer | null; profiles: Profile[] } & SaveProps) {
  const [draft, setDraft] = useDraft<Partial<Buyer>>(
    buyer ?? { name: "", identity: blankCred() },
    buyer?.id ?? "new",
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      await onSave(draft);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="editor-form">
      <p className="hint">A buyer holds only its own cXML identity (the <code>From</code> credential it presents). Reuse it across many supplier connections.</p>
      <div className="form-row">
        <label>Name</label>
        <input value={draft.name ?? ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Acme Procurement" />
      </div>
      <CredentialFields
        label="Identity (From)"
        value={draft.identity ?? blankCred()}
        onChange={(identity) => setDraft({ ...draft, identity })}
      />
      <div className="form-row">
        <label>
          Platform profile{" "}
          <span className="hint">(how this buyer's cXML is emitted — version, UserAgent, transport…)</span>
        </label>
        <select
          value={draft.profileId ?? ""}
          onChange={(e) => setDraft({ ...draft, profileId: e.target.value || undefined })}
        >
          <option value="">Generic (default)</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <Actions saving={saving} err={err} isNew={!buyer} noun="buyer" onSave={save} onDelete={buyer && onDelete ? () => onDelete(buyer.id) : undefined} />
    </div>
  );
}

export function SupplierEditor({ supplier, onSave, onDelete }: { supplier: Supplier | null } & SaveProps) {
  const [draft, setDraft] = useDraft<Partial<Supplier>>(
    supplier ?? { name: "", identity: blankCred(), punchoutUrl: "", orderUrl: "", catalog: [] },
    supplier?.id ?? "new",
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      await onSave(draft);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const catalog = draft.catalog ?? [];
  const setItem = (i: number, patch: Partial<CatalogItem>) =>
    setDraft({ ...draft, catalog: catalog.map((it, j) => (j === i ? { ...it, ...patch } : it)) });
  const addItem = () =>
    setDraft({
      ...draft,
      catalog: [...catalog, { supplierPartId: "", description: "", unitPrice: 0, currency: "USD", uom: "EA", unspsc: "" }],
    });
  const removeItem = (i: number) => setDraft({ ...draft, catalog: catalog.filter((_, j) => j !== i) });

  return (
    <div className="editor-form">
      <p className="hint">
        A supplier holds its cXML identity (<code>To</code>) and its <strong>endpoints</strong>, which are constant for the supplier — set them once here, not per connection.
      </p>
      <div className="form-row">
        <label>Name</label>
        <input value={draft.name ?? ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Office Supplies Inc." />
      </div>
      <CredentialFields
        label="Identity (To)"
        value={draft.identity ?? blankCred()}
        onChange={(identity) => setDraft({ ...draft, identity })}
      />
      <div className="form-row">
        <label>PunchOut URL <span className="hint">(setup endpoint)</span></label>
        <input value={draft.punchoutUrl ?? ""} onChange={(e) => setDraft({ ...draft, punchoutUrl: e.target.value })} placeholder="https://supplier.example.com/punchout" />
      </div>
      <div className="form-row">
        <label>Order URL <span className="hint">(order endpoint)</span></label>
        <input value={draft.orderUrl ?? ""} onChange={(e) => setDraft({ ...draft, orderUrl: e.target.value })} placeholder="https://supplier.example.com/order" />
      </div>

      <fieldset>
        <legend>Mock catalog <span className="hint">(used when the tool acts as this supplier)</span></legend>
        {catalog.length === 0 && <p className="hint">No items — the built-in demo catalog is served when empty.</p>}
        {catalog.map((it, i) => (
          <div className="catalog-row" key={i}>
            <input placeholder="SupplierPartID" value={it.supplierPartId} onChange={(e) => setItem(i, { supplierPartId: e.target.value })} />
            <input placeholder="Description" value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} />
            <input placeholder="Price" type="number" step="0.01" value={it.unitPrice} onChange={(e) => setItem(i, { unitPrice: Number(e.target.value) })} />
            <input placeholder="Cur" value={it.currency} onChange={(e) => setItem(i, { currency: e.target.value })} />
            <input placeholder="UoM" value={it.uom} onChange={(e) => setItem(i, { uom: e.target.value })} />
            <input placeholder="UNSPSC" value={it.unspsc} onChange={(e) => setItem(i, { unspsc: e.target.value })} />
            <button className="btn-link" onClick={() => removeItem(i)}>remove</button>
          </div>
        ))}
        <button className="btn-secondary" onClick={addItem}>+ Add item</button>
      </fieldset>

      <Actions saving={saving} err={err} isNew={!supplier} noun="supplier" onSave={save} onDelete={supplier && onDelete ? () => onDelete(supplier.id) : undefined} />
    </div>
  );
}
