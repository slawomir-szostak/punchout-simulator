import type { Address, Contact } from "../types";
import { COUNTRIES, SUBDIVISIONS, countryName, postalCodeValid } from "../geo";

// A compact editor for a cXML Address (ShipTo/BillTo) and, with `role`, a Contact.
// Country is chosen from a list (and drives the country name + the State control
// + postal-code format hint); State is a dropdown for countries with a known
// subdivision list, otherwise free text. Edits a partial object and reports the
// whole object back; an all-empty object should be normalized away server-side.

const ROLES = ["endUser", "purchasingAgent", "buyerMasterAccount", "administrator", "sales", "technicalSupport", "default"];

export function AddressFields<T extends Address>({
  value,
  onChange,
  contact = false,
}: {
  value: T;
  onChange: (v: T) => void;
  /** When true, show a Contact role selector (and treat the object as a Contact). */
  contact?: boolean;
}) {
  const set = (patch: Partial<Address> & { role?: string }) => onChange({ ...value, ...patch } as T);
  const v = value as Address & { role?: string };

  const iso = v.countryIsoCode ?? "";
  const subdivisions = iso ? SUBDIVISIONS[iso] : undefined;
  const postalOk = postalCodeValid(iso, v.postalCode);

  // Selecting a country sets both the ISO code and the matching name, and clears
  // a now-mismatched State (when switching to/from a country with a fixed list).
  const onCountry = (nextIso: string) => {
    const patch: Partial<Address> = { countryIsoCode: nextIso || undefined, countryName: countryName(nextIso) };
    const nextSubs = nextIso ? SUBDIVISIONS[nextIso] : undefined;
    if (subdivisions !== nextSubs) patch.state = undefined; // list changed → reset
    set(patch);
  };

  return (
    <div className="address-grid">
      {contact && (
        <label className="addr-field">
          <span className="field-label">Role</span>
          <select value={v.role ?? "endUser"} onChange={(e) => set({ role: e.target.value })}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
      )}
      <label className="addr-field grow">
        <span className="field-label">Name</span>
        <input value={v.name ?? ""} onChange={(e) => set({ name: e.target.value })} placeholder={contact ? "Jane Buyer" : "Acme HQ"} />
      </label>
      <label className="addr-field">
        <span className="field-label">addressID</span>
        <input value={v.addressId ?? ""} onChange={(e) => set({ addressId: e.target.value })} placeholder="1001" />
      </label>
      <label className="addr-field">
        <span className="field-label">addressID domain</span>
        <input value={v.addressIdDomain ?? ""} onChange={(e) => set({ addressIdDomain: e.target.value })} placeholder="NetworkID" />
      </label>
      {contact && (
        <>
          <label className="addr-field grow">
            <span className="field-label">Email</span>
            <input value={v.email ?? ""} onChange={(e) => set({ email: e.target.value })} placeholder="jane@buyer.example" />
          </label>
          <label className="addr-field">
            <span className="field-label">Phone</span>
            <input value={v.phone ?? ""} onChange={(e) => set({ phone: e.target.value })} placeholder="+1 555 0100" />
          </label>
        </>
      )}

      {/* Country first — it drives the State control and the postal format. */}
      <label className="addr-field">
        <span className="field-label">Country</span>
        <select value={iso} onChange={(e) => onCountry(e.target.value)}>
          <option value="">— select —</option>
          {COUNTRIES.map((c) => <option key={c.iso} value={c.iso}>{c.name} ({c.iso})</option>)}
        </select>
      </label>
      <label className="addr-field">
        <span className="field-label">State / province</span>
        {subdivisions ? (
          <select value={v.state ?? ""} onChange={(e) => set({ state: e.target.value || undefined })}>
            <option value="">— select —</option>
            {subdivisions.map((s) => <option key={s.code} value={s.code}>{s.code} — {s.name}</option>)}
          </select>
        ) : (
          <input value={v.state ?? ""} onChange={(e) => set({ state: e.target.value })} placeholder="State / region" />
        )}
      </label>
      <label className="addr-field">
        <span className="field-label">City</span>
        <input value={v.city ?? ""} onChange={(e) => set({ city: e.target.value })} placeholder="San Francisco" />
      </label>
      <label className="addr-field">
        <span className="field-label">
          Postal code{!postalOk && <span className="addr-warn" title="Doesn't match this country's usual format"> · format?</span>}
        </span>
        <input
          className={postalOk ? "" : "addr-invalid"}
          value={v.postalCode ?? ""}
          onChange={(e) => set({ postalCode: e.target.value })}
          placeholder="94105"
        />
      </label>
      <label className="addr-field grow">
        <span className="field-label">Street</span>
        <input value={v.street ?? ""} onChange={(e) => set({ street: e.target.value })} placeholder="1 Market St" />
      </label>
      <label className="addr-field">
        <span className="field-label">DeliverTo</span>
        <input value={v.deliverTo ?? ""} onChange={(e) => set({ deliverTo: e.target.value })} placeholder="Receiving dock" />
      </label>
    </div>
  );
}

/** Convenience wrapper for a Contact (Address + role). */
export function ContactFields({ value, onChange }: { value: Contact; onChange: (v: Contact) => void }) {
  return <AddressFields value={value} onChange={onChange} contact />;
}
