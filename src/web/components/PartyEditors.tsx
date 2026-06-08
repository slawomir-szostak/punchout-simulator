import { useEffect, useState } from "react";
import type { Address, Buyer, Contact, Credential, ProductList, Profile, Supplier } from "../types";
import { AddressFields, ContactFields } from "./AddressFields";

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

/** Two-step delete button: first click arms it, second click confirms.
 *  Auto-disarms after 3s. Avoids accidental destructive clicks. */
export function ConfirmButton({
  onConfirm,
  label = "Delete",
  confirmLabel = "Confirm delete?",
}: {
  onConfirm: () => void;
  label?: string;
  confirmLabel?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className="btn-danger"
      aria-label={armed ? confirmLabel : label}
      onClick={() => (armed ? onConfirm() : setArmed(true))}
    >
      {armed ? confirmLabel : label}
    </button>
  );
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
        {!isNew && onDelete && <ConfirmButton onConfirm={onDelete} />}
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
          Buyer profile{" "}
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

      <p className="hint">
        These addresses pre-fill and are sent in the <strong>OrderRequest</strong>. They appear in the{" "}
        <strong>PunchOutSetupRequest</strong> only when this buyer's profile enables it
        (Buyer Profiles → Addresses → “Send ShipTo / Contact in the PunchOutSetupRequest”).
      </p>
      <fieldset>
        <legend>Ship-to address <span className="hint">(default for this buyer's orders; pre-fills the OrderRequest)</span></legend>
        <AddressFields value={draft.shipTo ?? {}} onChange={(shipTo: Address) => setDraft({ ...draft, shipTo })} />
      </fieldset>
      <fieldset>
        <legend>Bill-to address <span className="hint">(usually constant per buyer org)</span></legend>
        <AddressFields value={draft.billTo ?? {}} onChange={(billTo: Address) => setDraft({ ...draft, billTo })} />
      </fieldset>
      <fieldset>
        <legend>Contact <span className="hint">(end-user / requisitioner — name, email, phone)</span></legend>
        <ContactFields value={(draft.contact ?? { role: "endUser" }) as Contact} onChange={(contact: Contact) => setDraft({ ...draft, contact })} />
      </fieldset>

      <Actions saving={saving} err={err} isNew={!buyer} noun="buyer" onSave={save} onDelete={buyer && onDelete ? () => onDelete(buyer.id) : undefined} />
    </div>
  );
}

export function SupplierEditor({
  supplier,
  productLists,
  onSave,
  onDelete,
}: { supplier: Supplier | null; productLists: ProductList[] } & SaveProps) {
  const [draft, setDraft] = useDraft<Partial<Supplier>>(
    supplier ?? { name: "", identity: blankCred(), punchoutUrl: "", orderUrl: "", productListIds: [] },
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

  const assigned = draft.productListIds ?? [];
  const toggleList = (id: string, on: boolean) =>
    setDraft({
      ...draft,
      productListIds: on ? [...assigned, id] : assigned.filter((x) => x !== id),
    });

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
      <div className="form-row">
        <label className="check-row">
          <input
            type="checkbox"
            checked={!!draft.allowMixedCurrency}
            onChange={(e) => setDraft({ ...draft, allowMixedCurrency: e.target.checked })}
          />
          Allow mixed-currency orders
          <span className="hint"> — treat multiple currencies in one document as a warning, not an error (this supplier handles it)</span>
        </label>
      </div>

      <fieldset>
        <legend>Mock catalog <span className="hint">(product lists served when the tool acts as this supplier)</span></legend>
        {productLists.length === 0 ? (
          <p className="hint">No product lists yet — create one in the Products section first.</p>
        ) : (
          <>
            {assigned.length === 0 && <p className="hint">No lists assigned — the built-in demo catalog is served.</p>}
            <ul className="checkbox-list">
              {productLists.map((p) => (
                <li key={p.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={assigned.includes(p.id)}
                      onChange={(e) => toggleList(p.id, e.target.checked)}
                    />
                    {p.name} <span className="hint">({p.items.length} items)</span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
      </fieldset>

      <Actions saving={saving} err={err} isNew={!supplier} noun="supplier" onSave={save} onDelete={supplier && onDelete ? () => onDelete(supplier.id) : undefined} />
    </div>
  );
}
