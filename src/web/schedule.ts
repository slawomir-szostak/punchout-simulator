// Delivery schedules for an order line, as the UI edits them: plain logic, kept
// out of the component so it can be tested without a browser.

export interface Delivery {
  quantity: number;
  /** YYYY-MM-DD, as a date input gives it. */
  date: string;
}

/** Schedules keyed by cart-line index. */
export type Schedules = Record<number, Delivery[]>;

export const isoDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const addDays = (date: string, days: number): string => {
  const [y, m, d] = date.split("-").map(Number);
  return isoDate(new Date(y, m - 1, d + days));
};

export const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Split a quantity into `parts` deliveries a week apart, the first a week from
 * `from`. Whole quantities stay whole (the remainder goes to the first
 * deliveries); fractional ones are divided to three decimals.
 */
export function splitEvenly(quantity: number, parts: number, from: string = isoDate(new Date())): Delivery[] {
  const n = Math.max(1, Math.floor(parts));
  const whole = Number.isInteger(quantity);
  const base = whole ? Math.floor(quantity / n) : round3(quantity / n);
  const out: Delivery[] = [];
  let left = quantity;
  for (let i = 0; i < n; i++) {
    const extra = whole && i < quantity - base * n ? 1 : 0;
    const q = i === n - 1 ? round3(left) : base + extra;
    left = round3(left - q);
    out.push({ quantity: q, date: addDays(from, 7 * (i + 1)) });
  }
  return out.filter((d) => d.quantity > 0);
}
