import type { AccountingSettings, ChargeOverride, ShippingSettings, TaxSettings } from "../types";

// Form rows for the tax, shipping and accounting a party adds to a document.
// They edit drafts: a row left empty simply isn't saved (the server keeps tax
// only with a rate, shipping only with an amount, accounting only with a
// segment that has a name and a code).

const numberOrUndefined = (v: string): number | undefined => {
  if (v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

// TaxDetail/@category is free text in the DTD; these are the common values.
const TAX_CATEGORIES = ["sales", "vat", "gst", "usage", "hst", "pst", "qst", "other"];

export function TaxFields({
  value,
  onChange,
  withLevel,
}: {
  value: Partial<TaxSettings> | undefined;
  onChange: (v: Partial<TaxSettings>) => void;
  /** Offer the header-only / header-and-lines choice (orders only). */
  withLevel?: boolean;
}) {
  const v = value ?? {};
  return (
    <div className={`charge-row tax${withLevel ? " with-level" : ""}`}>
      <span className="charge-label">Tax</span>
      <input
        type="number"
        min="0"
        step="any"
        inputMode="decimal"
        placeholder="rate %"
        aria-label="Tax rate in percent"
        value={v.ratePercent ?? ""}
        onChange={(e) => onChange({ ...v, ratePercent: numberOrUndefined(e.target.value) })}
      />
      <select aria-label="Tax category" value={v.category ?? "sales"} onChange={(e) => onChange({ ...v, category: e.target.value })}>
        {TAX_CATEGORIES.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
      <input placeholder="description (e.g. VAT 23%)" aria-label="Tax description" value={v.description ?? ""} onChange={(e) => onChange({ ...v, description: e.target.value })} />
      {withLevel && (
        <select aria-label="Where tax is stated" value={v.level ?? "order"} onChange={(e) => onChange({ ...v, level: e.target.value as "order" | "lines" })}>
          <option value="order">order total only</option>
          <option value="lines">order total + every line</option>
        </select>
      )}
    </div>
  );
}

export function ShippingFields({
  value,
  onChange,
}: {
  value: Partial<ShippingSettings> | undefined;
  onChange: (v: Partial<ShippingSettings>) => void;
}) {
  const v = value ?? {};
  return (
    <div className="charge-row shipping">
      <span className="charge-label">Shipping</span>
      <input
        type="number"
        min="0"
        step="any"
        inputMode="decimal"
        placeholder="amount"
        aria-label="Shipping amount"
        value={v.amount ?? ""}
        onChange={(e) => onChange({ ...v, amount: numberOrUndefined(e.target.value) })}
      />
      <input placeholder="description (e.g. Standard ground)" aria-label="Shipping description" value={v.description ?? ""} onChange={(e) => onChange({ ...v, description: e.target.value })} />
    </div>
  );
}

export function AccountingFields({
  value,
  onChange,
}: {
  value: Partial<AccountingSettings> | undefined;
  onChange: (v: Partial<AccountingSettings>) => void;
}) {
  const v = value ?? {};
  const segments = v.segments ?? [];
  const setSegment = (i: number, patch: Partial<AccountingSettings["segments"][number]>) =>
    onChange({ ...v, segments: segments.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  return (
    <>
      {segments.length === 0 && <p className="hint">No accounting — orders carry no Distribution.</p>}
      {segments.map((s, i) => (
        <div className="charge-row segment" key={i}>
          <input placeholder="type (e.g. Cost Center)" aria-label={`Segment ${i + 1} type`} value={s.name} onChange={(e) => setSegment(i, { name: e.target.value })} />
          <input placeholder="code (e.g. 4711)" aria-label={`Segment ${i + 1} code`} value={s.id} onChange={(e) => setSegment(i, { id: e.target.value })} />
          <input placeholder="description (e.g. Marketing)" aria-label={`Segment ${i + 1} description`} value={s.description} onChange={(e) => setSegment(i, { description: e.target.value })} />
          <button className="btn-link" onClick={() => onChange({ ...v, segments: segments.filter((_, j) => j !== i) })}>remove</button>
        </div>
      ))}
      <button className="btn-secondary" onClick={() => onChange({ ...v, segments: [...segments, { name: "", id: "", description: "" }] })}>
        + Add accounting segment
      </button>
    </>
  );
}

/** "8% sales tax, shipping 3.00" — what a party's defaults amount to. */
export function describeCharges(tax?: Partial<TaxSettings>, shipping?: Partial<ShippingSettings>): string {
  const parts: string[] = [];
  if (tax?.ratePercent != null) parts.push(`${tax.ratePercent}% ${tax.category ?? "sales"} tax`);
  if (shipping?.amount != null) parts.push(`shipping ${shipping.amount.toFixed(2)}`);
  return parts.length > 0 ? parts.join(", ") : "no tax or shipping";
}

/**
 * A connection's say over tax and shipping for its buyer–supplier pair: follow
 * the party's defaults, send none, or send its own figures.
 */
export function ChargeOverrideFields({
  value,
  onChange,
  inheritLabel,
  withLevel,
}: {
  value: ChargeOverride | undefined;
  onChange: (v: ChargeOverride | undefined) => void;
  /** What "follow the defaults" means here, e.g. "as set on Demo Supplier (23% vat tax)". */
  inheritLabel: string;
  withLevel?: boolean;
}) {
  const mode = value?.mode ?? "inherit";
  return (
    <>
      <select
        aria-label="Tax and shipping for this pair"
        value={mode}
        onChange={(e) =>
          onChange(e.target.value === "inherit" ? undefined : e.target.value === "none" ? { mode: "none" } : { mode: "custom", tax: value?.tax, shipping: value?.shipping })
        }
      >
        <option value="inherit">{inheritLabel}</option>
        <option value="none">none — no tax or shipping for this pair</option>
        <option value="custom">specific to this pair…</option>
      </select>
      {value?.mode === "custom" && (
        <div style={{ marginTop: ".6rem" }}>
          <TaxFields value={value.tax} withLevel={withLevel} onChange={(tax) => onChange({ ...value, tax: tax as TaxSettings })} />
          <ShippingFields value={value.shipping} onChange={(shipping) => onChange({ ...value, shipping: shipping as ShippingSettings })} />
          <p className="hint">Only what you fill in is sent; an empty row means that charge is left out for this pair.</p>
        </div>
      )}
    </>
  );
}
