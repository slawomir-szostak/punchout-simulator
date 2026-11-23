import { useEffect, useState } from "react";
import type { Address, Buyer, Contact, Credential, ProductList, Profile, Supplier } from "../types";
import { AddressFields, ContactFields } from "./AddressFields";
import { AccountingFields, ShippingFields, TaxFields } from "./ChargeFields";
import type { AccountingSettings, ShippingSettings, TaxSettings } from "../types";
import { Field } from "./Field";

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
          aria-label={`${label} — domain`}
          value={value.domain}
          onChange={(e) => onChange({ ...value, domain: e.target.value })}
        />
        <input
          placeholder="identity"
          aria-label={`${label} — identity`}
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
  /** Copy the entity being edited into a new, unsaved draft. */
  onDuplicate?: () => void;
  /** Set on a duplicate draft: drop it and return to the source. */
  onDiscard?: () => void;
}

/** Props for a draft's Name input: focused with the text selected, so a
 *  duplicate's "(copy)" name can be overwritten straight away. */
export function draftNameProps(isDraft: boolean) {
  return isDraft
    ? { autoFocus: true, onFocus: (e: { currentTarget: HTMLInputElement }) => e.currentTarget.select() }
    : {};
}

/** Two-step delete button: first click arms it, second click confirms.
 *  Auto-disarms after 3s. Avoids accidental destructive clicks. A rejected
 *  onConfirm (e.g. the server refusing to delete a referenced entity with 409)
 *  is reported via onError so the editor can surface it instead of failing
 *  silently in the console. */
export function ConfirmButton({
  onConfirm,
  onError,
  label = "Delete",
  confirmLabel = "Confirm delete?",
}: {
  onConfirm: () => void | Promise<void>;
  onError?: (msg: string) => void;
  label?: string;
  confirmLabel?: string;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  const click = async () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy(true);
    onError?.("");
    try {
      await onConfirm();
    } catch (e) {
      setArmed(false);
      onError?.(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      className="btn-danger"
      disabled={busy}
      aria-label={armed ? confirmLabel : label}
      onClick={click}
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
  onDuplicate,
  onDiscard,
  onError,
}: {
  saving: boolean;
  err: string | null;
  isNew: boolean;
  noun: string;
  onSave: () => void;
  onDelete?: () => void | Promise<void>;
  onDuplicate?: () => void;
  onDiscard?: () => void;
  onError?: (msg: string) => void;
}) {
  return (
    <>
      {err && <div className="form-error">{err}</div>}
      <div className="form-actions">
        <button className="btn-primary" onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : isNew ? `Create ${noun}` : "Save changes"}
        </button>
        {!isNew && onDuplicate && (
          <button type="button" className="btn-secondary" onClick={onDuplicate} title={`Copy this ${noun} into a new, unsaved draft`}>
            Duplicate
          </button>
        )}
        {isNew && onDiscard && (
          <button type="button" className="btn-secondary" onClick={onDiscard} disabled={saving}>
            Discard
          </button>
        )}
        {!isNew && onDelete && <ConfirmButton onConfirm={onDelete} onError={onError} />}
      </div>
    </>
  );
}

/**
 * The same organization in other domains — a NetworkID next to a DUNS. Each one
 * is sent as a further Credential wherever the party is named.
 */
function AdditionalIdentities({
  party,
  main,
  value,
  onChange,
}: {
  party: "From" | "To";
  main: Credential;
  value: Credential[];
  onChange: (list: Credential[]) => void;
}) {
  const set = (i: number, patch: Partial<Credential>) => onChange(value.map((c, k) => (k === i ? { ...c, ...patch } : c)));
  // One identity per domain: a receiver rejects two values in the same domain.
  const clash = (c: Credential, i: number) =>
    c.domain.trim() !== "" &&
    [main, ...value.slice(0, i)].some((o) => o.domain === c.domain);
  return (
    <div className="form-row">
      <label>
        Additional identities <span className="hint">— optional; the same organization in other domains</span>
      </label>
      {value.map((c, i) => (
        <div key={i}>
          <div className="cred-pair extra">
            <input
              placeholder="domain (e.g. NetworkID)"
              aria-label={`Additional identity ${i + 1} — domain`}
              value={c.domain}
              onChange={(e) => set(i, { domain: e.target.value })}
            />
            <input
              placeholder="identity"
              aria-label={`Additional identity ${i + 1} — identity`}
              value={c.identity}
              onChange={(e) => set(i, { identity: e.target.value })}
            />
            <button type="button" className="btn-link" onClick={() => onChange(value.filter((_, k) => k !== i))} aria-label={`Remove additional identity ${i + 1}`}>
              Remove
            </button>
          </div>
          {clash(c, i) && (
            <p className="hint warn-hint" role="status">
              This party already has an identity in domain “{c.domain}”. A party has one identity per domain.
            </p>
          )}
        </div>
      ))}
      <div className="cred-add">
        <button type="button" className="btn-link" onClick={() => onChange([...value, { domain: "", identity: "" }])}>
          + Add identity
        </button>
      </div>
      {value.length > 0 && (
        <p className="hint">
          Sent as further <code>Credential</code> elements in <code>{party}</code>, after the main identity. The mock side accepts any of them.
        </p>
      )}
    </div>
  );
}

const blankCred = (): Credential => ({ domain: "DUNS", identity: "" });

export function BuyerEditor({
  buyer,
  seed,
  buyers,
  profiles,
  onSave,
  onDelete,
  onDuplicate,
  onDiscard,
}: { buyer: Buyer | null; seed?: Partial<Buyer>; buyers: Buyer[]; profiles: Profile[] } & SaveProps) {
  const [draft, setDraft] = useDraft<Partial<Buyer>>(
    buyer ?? seed ?? { name: "", identity: blankCred() },
    buyer?.id ?? "new",
  );
  // Mode B tells buyers apart by their From identity: with two buyers sharing
  // one and connected to the same supplier, inbound requests match whichever
  // connection comes first. A duplicate starts out exactly like that.
  const twin = draft.identity?.identity
    ? buyers.find(
        (b) =>
          b.id !== buyer?.id &&
          b.identity.domain === draft.identity?.domain &&
          b.identity.identity === draft.identity?.identity,
      )
    : undefined;
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
      <Field label="Name">
        <input value={draft.name ?? ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Acme Procurement" {...draftNameProps(!!seed)} />
      </Field>
      <CredentialFields
        label="Identity (From)"
        value={draft.identity ?? blankCred()}
        onChange={(identity) => setDraft({ ...draft, identity })}
      />
      <AdditionalIdentities
        party="From"
        main={draft.identity ?? blankCred()}
        value={draft.additionalIdentities ?? []}
        onChange={(additionalIdentities) => setDraft({ ...draft, additionalIdentities })}
      />
      {twin && (
        <p className="hint warn-hint" role="status">
          Same identity as “{twin.name}”. If both are connected to the same supplier, the mock supplier (Mode B) can't tell
          them apart — inbound requests match the first connection. Change the identity to keep them separate.
        </p>
      )}
      <Field
        label={
          <>
            Buyer profile{" "}
            <span className="hint">(how this buyer's cXML is emitted — version, UserAgent, transport…)</span>
          </>
        }
      >
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
      </Field>

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
      <fieldset>
        <legend>Tax <span className="hint">(added to this buyer's OrderRequests when a rate is set)</span></legend>
        <TaxFields value={draft.tax} withLevel onChange={(tax) => setDraft({ ...draft, tax: tax as TaxSettings })} />
        <p className="hint">
          Charged on the goods total. Leave the rate empty and the order carries whatever tax the supplier quoted with the cart, if any.
        </p>
      </fieldset>
      <fieldset>
        <legend>Shipping <span className="hint">(a flat charge in the order header)</span></legend>
        <ShippingFields value={draft.shipping} onChange={(shipping) => setDraft({ ...draft, shipping: shipping as ShippingSettings })} />
        <p className="hint">Leave the amount empty to carry the shipping the supplier quoted with the cart, if any.</p>
      </fieldset>
      <fieldset>
        <legend>Accounting <span className="hint">(who is charged — sent as a Distribution on every order line)</span></legend>
        <Field label={<>Name <span className="hint">(of this accounting combination)</span></>}>
          <input value={draft.accounting?.name ?? ""} onChange={(e) => setDraft({ ...draft, accounting: { ...(draft.accounting ?? { segments: [] }), name: e.target.value } })} placeholder="DistributionCharge" />
        </Field>
        <AccountingFields value={draft.accounting} onChange={(accounting) => setDraft({ ...draft, accounting: accounting as AccountingSettings })} />
      </fieldset>

      <Actions saving={saving} err={err} isNew={!buyer} noun="buyer" onSave={save} onError={setErr} onDelete={buyer && onDelete ? () => onDelete(buyer.id) : undefined} onDuplicate={onDuplicate} onDiscard={onDiscard} />
    </div>
  );
}

export function SupplierEditor({
  supplier,
  seed,
  productLists,
  onSave,
  onDelete,
  onDuplicate,
  onDiscard,
}: { supplier: Supplier | null; seed?: Partial<Supplier>; productLists: ProductList[] } & SaveProps) {
  const [draft, setDraft] = useDraft<Partial<Supplier>>(
    supplier ?? seed ?? { name: "", identity: blankCred(), punchoutUrl: "", orderUrl: "", productListIds: [] },
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
      <Field label="Name">
        <input value={draft.name ?? ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Office Supplies Inc." {...draftNameProps(!!seed)} />
      </Field>
      <CredentialFields
        label="Identity (To)"
        value={draft.identity ?? blankCred()}
        onChange={(identity) => setDraft({ ...draft, identity })}
      />
      <AdditionalIdentities
        party="To"
        main={draft.identity ?? blankCred()}
        value={draft.additionalIdentities ?? []}
        onChange={(additionalIdentities) => setDraft({ ...draft, additionalIdentities })}
      />
      <Field label={<>PunchOut URL <span className="hint">(setup endpoint)</span></>}>
        <input value={draft.punchoutUrl ?? ""} onChange={(e) => setDraft({ ...draft, punchoutUrl: e.target.value })} placeholder="https://supplier.example.com/punchout" />
      </Field>
      <Field label={<>Order URL <span className="hint">(order endpoint)</span></>}>
        <input value={draft.orderUrl ?? ""} onChange={(e) => setDraft({ ...draft, orderUrl: e.target.value })} placeholder="https://supplier.example.com/order" />
      </Field>
      <Field label={<>Profile URL <span className="hint">(optional — where a ProfileRequest goes; defaults to the PunchOut URL)</span></>}>
        <input value={draft.profileUrl ?? ""} onChange={(e) => setDraft({ ...draft, profileUrl: e.target.value })} placeholder="https://supplier.example.com/cxml" />
      </Field>
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
      <Field
        label={<>Carts may later be <span className="hint">(<code>operationAllowed</code> on carts the mock supplier returns)</span></>}
        after={
          <span className="hint">
            Tells the buyer what it may do with a returned cart afterwards. Lower it to check that a buyer system respects the limit.
          </span>
        }
      >
        <select
          value={draft.operationAllowed ?? "edit"}
          onChange={(e) => setDraft({ ...draft, operationAllowed: e.target.value as "create" | "inspect" | "edit" })}
        >
          <option value="edit">edit — reopened to inspect or change (default)</option>
          <option value="inspect">inspect — reopened read-only</option>
          <option value="create">create — not reopened at all</option>
        </select>
      </Field>
      <fieldset>
        <legend>Charges quoted with a cart <span className="hint">(mock supplier: Tax and Shipping in the returned cart's header)</span></legend>
        <TaxFields value={draft.cartTax} onChange={(cartTax) => setDraft({ ...draft, cartTax: cartTax as TaxSettings })} />
        <ShippingFields value={draft.cartShipping} onChange={(cartShipping) => setDraft({ ...draft, cartShipping: cartShipping as ShippingSettings })} />
        <p className="hint">
          Leave both empty for a cart with no charges. The cart's Total is always the goods amount alone — tax and shipping are stated beside it, never added in.
        </p>
      </fieldset>

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

      <Actions saving={saving} err={err} isNew={!supplier} noun="supplier" onSave={save} onError={setErr} onDelete={supplier && onDelete ? () => onDelete(supplier.id) : undefined} onDuplicate={onDuplicate} onDiscard={onDiscard} />
    </div>
  );
}
