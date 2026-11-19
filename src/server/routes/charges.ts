import type { AccountingSettings, ChargeOverride, ShippingSettings, TaxSettings } from "../cxml/types.js";

// Normalisers for the tax / shipping / accounting settings that arrive from the
// editors, shared by the party and connection routes, plus the rule for how a
// connection's override combines with a party's defaults.

const str = (v: any): string | undefined => (v != null && String(v) !== "" ? String(v) : undefined);

/** A number field from a form: finite and not negative, else undefined. */
const amount = (v: any): number | undefined => {
  const n = typeof v === "number" ? v : v == null || v === "" ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

// Tax settings are kept only when a rate is given; the category the DTD
// requires on TaxDetail defaults to "sales".
export function taxSettings(t: any): TaxSettings | undefined {
  const ratePercent = amount(t?.ratePercent);
  if (ratePercent == null) return undefined;
  return {
    ratePercent,
    category: str(t?.category) ?? "sales",
    description: str(t?.description),
    level: t?.level === "lines" ? "lines" : undefined,
  };
}

export function shippingSettings(s: any): ShippingSettings | undefined {
  const value = amount(s?.amount);
  return value == null ? undefined : { amount: value, description: str(s?.description) };
}

// Accounting is kept when it has at least one segment with a name and an id
// (AccountingSegment/@id is required; Name and Description are its content).
export function accountingSettings(a: any): AccountingSettings | undefined {
  const segments = (Array.isArray(a?.segments) ? a.segments : [])
    .map((s: any) => ({ name: String(s?.name ?? "").trim(), id: String(s?.id ?? "").trim(), description: String(s?.description ?? "").trim() }))
    .filter((s: { name: string; id: string }) => s.name && s.id);
  if (segments.length === 0) return undefined;
  return { name: str(a?.name) ?? "DistributionCharge", segments };
}

/** A connection's override: undefined (inherit), none, or custom with what was filled in. */
export function chargeOverride(o: any): ChargeOverride | undefined {
  if (o?.mode === "none") return { mode: "none" };
  if (o?.mode === "custom") return { mode: "custom", tax: taxSettings(o.tax), shipping: shippingSettings(o.shipping) };
  return undefined;
}

/**
 * The tax and shipping in force for a pair. `inherited` is false when the
 * connection decided (none / custom): the result is then final — in particular
 * an order must not fall back to the supplier's quote.
 */
export function resolveCharges(
  override: ChargeOverride | undefined,
  defaults: { tax?: TaxSettings; shipping?: ShippingSettings },
): { tax?: TaxSettings; shipping?: ShippingSettings; inherited: boolean } {
  if (!override) return { tax: defaults.tax, shipping: defaults.shipping, inherited: true };
  if (override.mode === "none") return { inherited: false };
  return { tax: override.tax, shipping: override.shipping, inherited: false };
}
