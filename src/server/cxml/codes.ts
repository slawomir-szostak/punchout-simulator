import { CURRENCY_CODES, PACKAGE_CODES, UNIT_CODES, WITHDRAWN_UNIT_CODES } from "./code-lists.js";

// cXML does not define units and currencies itself, it points at two code
// lists: UnitOfMeasure "must conform with UN/CEFACT (Recommendation 20) Unit of
// Measure Common Codes", and a currency "must be a three-letter ISO 4217
// currency code".

const set = (codes: string) => new Set(codes.split(" "));
const CURRENCIES = set(CURRENCY_CODES);
const UNITS = set(UNIT_CODES);
const WITHDRAWN = set(WITHDRAWN_UNIT_CODES);
const PACKAGES = set(PACKAGE_CODES);

export type UnitStatus =
  | { kind: "ok" }
  /** Marked as deleted or deprecated in Recommendation 20; `replacement` is its package code, when there is one. */
  | { kind: "withdrawn"; replacement?: string }
  /** On no list; `suggestion` when only the letter case is off. */
  | { kind: "unknown"; suggestion?: string };

const isUnit = (code: string): boolean =>
  // Recommendation 21 package codes are units too, with an "X" in front: XBX = box.
  UNITS.has(code) || (code.startsWith("X") && PACKAGES.has(code.slice(1)));

export function unitStatus(code: string): UnitStatus {
  if (isUnit(code)) return { kind: "ok" };
  if (WITHDRAWN.has(code)) return { kind: "withdrawn", replacement: PACKAGES.has(code) ? `X${code}` : undefined };
  const upper = code.toUpperCase();
  return { kind: "unknown", suggestion: upper !== code && (isUnit(upper) || WITHDRAWN.has(upper)) ? upper : undefined };
}

export const isCurrency = (code: string): boolean => CURRENCIES.has(code);

/** The same code in upper case, when that is a currency and the code as written is not. */
export const currencySuggestion = (code: string): string | undefined => {
  const upper = code.toUpperCase();
  return upper !== code && CURRENCIES.has(upper) ? upper : undefined;
};
