import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { appendLog, deleteSession, listSessions } from "../src/server/store/log.js";
import { sessionFile, setDataDir } from "../src/server/store/paths.js";

// listSessions keeps an incremental summary cache (the SPA refetches it on
// every SSE event). These tests pin the cache's correctness across the three
// ways a session file changes: appendLog, deleteSession, and external writes.

beforeEach(() => {
  setDataDir(mkdtempSync(join(tmpdir(), "pos-log-")));
});

const record = (sessionId: string, docType = "SetupRequest", extra: object = {}) => ({
  sessionId,
  direction: "out" as const,
  docType: docType as any,
  body: `<PunchOutSetupRequest operation="create"><x/></PunchOutSetupRequest>`,
  contentType: "text/xml",
  ...extra,
});

describe("listSessions summary cache", () => {
  it("reflects appends made after the first scan", () => {
    appendLog(record("s1"));
    expect(listSessions()).toHaveLength(1); // builds the cache

    appendLog(record("s1", "SetupResponse"));
    appendLog(record("s2"));
    const summaries = listSessions();
    const s1 = summaries.find((s) => s.sessionId === "s1")!;
    expect(s1.count).toBe(2);
    expect(s1.docTypes).toEqual(["SetupRequest", "SetupResponse"]);
    expect(s1.operation).toBe("create");
    expect(summaries.find((s) => s.sessionId === "s2")?.count).toBe(1);
  });

  it("tracks hasErrors and lastTs incrementally", () => {
    appendLog(record("s1", "SetupRequest", { ts: "2026-01-01T00:00:00.000Z" }));
    expect(listSessions()[0].hasErrors).toBe(false);

    appendLog(
      record("s1", "SetupResponse", {
        ts: "2026-01-02T00:00:00.000Z",
        validation: { ok: false, issues: [] },
      }),
    );
    const [s1] = listSessions();
    expect(s1.hasErrors).toBe(true);
    expect(s1.lastTs).toBe("2026-01-02T00:00:00.000Z");
  });

  it("drops deleted sessions", () => {
    appendLog(record("s1"));
    appendLog(record("s2"));
    listSessions();
    expect(deleteSession("s1")).toBe(true);
    expect(listSessions().map((s) => s.sessionId)).toEqual(["s2"]);
  });

  it("re-parses a file changed outside appendLog (size mismatch)", () => {
    appendLog(record("s1"));
    listSessions();
    // Simulate a foreign writer (e.g. a pre-boot file growing under a second process).
    const line = JSON.stringify({ ...record("s1", "OrderRequest"), id: "x1", ts: "2026-01-03T00:00:00.000Z" });
    appendFileSync(sessionFile("s1"), line + "\n", "utf8");
    const [s1] = listSessions();
    expect(s1.count).toBe(2);
    expect(s1.docTypes).toContain("OrderRequest");
  });
});
