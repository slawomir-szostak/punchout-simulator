import { describe, expect, it } from "vitest";
import { collapseExchanges } from "../src/web/log-dedup.js";
import type { LogRecord } from "../src/server/cxml/types.js";

// Minimal LogRecord factory for dedup tests.
function rec(over: Partial<LogRecord>): LogRecord {
  return {
    id: Math.random().toString(36).slice(2),
    sessionId: "s1",
    connectionId: "demo",
    direction: "out",
    docType: "SetupRequest",
    headers: {},
    body: "<cXML>x</cXML>",
    ts: "2026-06-08T10:00:00.000Z",
    ...over,
  } as LogRecord;
}

const known = new Set(["demo"]); // "demo" is a real connection; "demo-supplier" is not

describe("collapseExchanges", () => {
  it("merges the buyer-out + supplier-in copies of one exchange (ms apart)", () => {
    const out = collapseExchanges(
      [
        rec({ id: "a", direction: "out", connectionId: "demo", ts: "2026-06-08T10:00:00.000Z" }),
        rec({ id: "b", direction: "in", connectionId: "demo-supplier", ts: "2026-06-08T10:00:00.030Z" }),
      ],
      known,
    );
    expect(out).toHaveLength(1);
    // prefers the copy tied to a known connection
    expect(out[0].connectionId).toBe("demo");
  });

  it("keeps re-sends of identical bytes as separate rows (seconds apart)", () => {
    const out = collapseExchanges(
      [
        rec({ id: "a", direction: "out", connectionId: "demo", ts: "2026-06-08T10:00:00.000Z" }),
        rec({ id: "b", direction: "in", connectionId: "demo-supplier", ts: "2026-06-08T10:00:00.030Z" }),
        // re-send 7s later — same docType + body, but a distinct event
        rec({ id: "c", direction: "out", connectionId: "demo", ts: "2026-06-08T10:00:07.000Z" }),
        rec({ id: "d", direction: "in", connectionId: "demo-supplier", ts: "2026-06-08T10:00:07.040Z" }),
      ],
      known,
    );
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("never merges records with different bodies", () => {
    const out = collapseExchanges(
      [
        rec({ id: "a", body: "<cXML>1</cXML>", ts: "2026-06-08T10:00:00.000Z" }),
        rec({ id: "b", body: "<cXML>2</cXML>", ts: "2026-06-08T10:00:00.010Z" }),
      ],
      known,
    );
    expect(out).toHaveLength(2);
  });

  it("returns records in ascending timestamp order", () => {
    const out = collapseExchanges(
      [
        rec({ id: "late", body: "<cXML>2</cXML>", ts: "2026-06-08T10:00:05.000Z" }),
        rec({ id: "early", body: "<cXML>1</cXML>", ts: "2026-06-08T10:00:01.000Z" }),
      ],
      known,
    );
    expect(out.map((r) => r.id)).toEqual(["early", "late"]);
  });
});
