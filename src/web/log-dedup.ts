import type { LogRecord } from "./types";

export const PAIR_WINDOW_MS = 2000;

// Collapse the same wire message logged from both simulated actors *within the
// same exchange*. In a real integration only one side is the tool, so nothing
// collapses; in the self-contained demo the tool is both buyer and supplier, so
// identical bytes are logged twice (buyer-out + supplier-in) milliseconds apart.
// We only merge those near-simultaneous duplicates — a later re-send of the
// identical document (seconds apart, same bytes because the editor keeps the
// original payloadID) is a distinct event and must get its own row. When merging,
// prefer the copy tied to a known Connection (the buyer-flow view). Returns the
// kept records in ascending timestamp order.
export function collapseExchanges(records: LogRecord[], known: Set<string>): LogRecord[] {
  const sorted = [...records].sort((a, b) => a.ts.localeCompare(b.ts));
  const deduped: LogRecord[] = [];
  const lastForKey = new Map<string, LogRecord>();
  for (const r of sorted) {
    const key = `${r.docType} ${r.body ?? ""}`;
    const prev = lastForKey.get(key);
    if (prev && Math.abs(Date.parse(r.ts) - Date.parse(prev.ts)) <= PAIR_WINDOW_MS) {
      if (!known.has(prev.connectionId) && known.has(r.connectionId)) {
        const idx = deduped.indexOf(prev);
        if (idx >= 0) deduped[idx] = r;
        lastForKey.set(key, r);
      }
      continue;
    }
    deduped.push(r);
    lastForKey.set(key, r);
  }
  return deduped;
}
