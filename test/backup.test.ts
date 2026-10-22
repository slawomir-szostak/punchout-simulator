import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import {
  SCHEMA_VERSION,
  getConnection,
  getProfile,
  initConfig,
  listBuyers,
  listConnections,
  listProductLists,
  updateProfile,
} from "../src/server/store/config.js";
import { setDataDir } from "../src/server/store/paths.js";
import { setRuntime } from "../src/server/runtime.js";
import { seedDemoIfEmpty } from "../src/server/seed.js";

// Config export / import (/api/config). Each test starts from a fresh data dir
// holding the seeded demo (demo-buyer, demo-supplier, demo connection).

let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  setDataDir(mkdtempSync(join(tmpdir(), "pos-backup-")));
  setRuntime({ port: 0, publicUrl: "http://localhost:0" });
  await initConfig();
  await seedDemoIfEmpty();
  app = createApp({ quiet: true });
});

const exportJson = (query = "") => app.request(`/api/config/export${query}`).then((r) => r.json());

const importJson = (body: unknown, mode?: string) =>
  app.request(`/api/config/import${mode ? `?mode=${mode}` : ""}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("export", () => {
  it("downloads every collection with an envelope", async () => {
    const res = await app.request("/api/config/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="punchout-simulator-config-\d{4}-\d{2}-\d{2}\.json"/);
    const snap = await res.json();
    expect(snap.format).toBe("punchout-simulator-config");
    expect(snap.schemaVersion).toBe(SCHEMA_VERSION);
    expect(snap.buyers.map((b: any) => b.id)).toContain("demo-buyer");
    expect(snap.suppliers.map((s: any) => s.id)).toContain("demo-supplier");
    expect(snap.connections.map((c: any) => c.id)).toContain("demo");
    expect(snap.profiles.length).toBeGreaterThan(0);
    expect(snap.productLists.length).toBeGreaterThan(0);
  });

  it("blanks shared secrets unless ?secrets=1", async () => {
    expect((await exportJson()).connections[0].sharedSecret).toBe("");
    expect((await exportJson("?secrets=1")).connections[0].sharedSecret).toBe("demo-secret");
  });
});

describe("import", () => {
  it("merge upserts by id and keeps rows not in the file", async () => {
    const snap = await exportJson();
    snap.buyers = [
      { ...snap.buyers[0], name: "Renamed Buyer" },
      { id: "b2", name: "Second Buyer", identity: { domain: "DUNS", identity: "2" } },
    ];
    delete snap.connections; // not in the file → store's connections untouched
    const res = await importJson(snap);
    expect(res.status).toBe(200);
    const summary = await res.json();
    expect(summary.mode).toBe("merge");
    expect(summary.imported.buyers).toBe(2);
    expect(listBuyers().map((b) => b.name)).toEqual(["Renamed Buyer", "Second Buyer"]);
    expect(getConnection("demo")).toBeDefined();
  });

  it("replace swaps the whole config", async () => {
    const res = await importJson(
      {
        buyers: [{ id: "x-b", name: "X", identity: { domain: "DUNS", identity: "1" } }],
        suppliers: [{ id: "x-s", name: "Y", identity: { domain: "DUNS", identity: "2" } }],
        connections: [{ id: "x", name: "X→Y", buyerId: "x-b", supplierId: "x-s", mode: "virtual-buyer", sharedSecret: "s" }],
      },
      "replace",
    );
    expect(res.status).toBe(200);
    expect(listBuyers().map((b) => b.id)).toEqual(["x-b"]);
    expect(listConnections().map((c) => c.id)).toEqual(["x"]);
    // Built-ins are re-seeded even when the file omits them.
    expect(getProfile("generic")).toBeDefined();
  });

  it("keeps the stored secret when the file's secret is blank", async () => {
    const snap = await exportJson(); // secrets blanked
    const summary = await (await importJson(snap, "replace")).json();
    expect(getConnection("demo")?.sharedSecret).toBe("demo-secret");
    expect(summary.withoutSecret).toBe(0);
  });

  it("merge does not reset edited built-ins the file omits", async () => {
    await updateProfile("ariba", { userAgent: "Edited UA" });
    const res = await importJson({ buyers: [{ id: "b3", name: "Z", identity: { domain: "DUNS", identity: "3" } }] });
    expect(res.status).toBe(200);
    expect(getProfile("ariba")?.userAgent).toBe("Edited UA");
  });

  it("migrates an older file (inline supplier catalog → product list)", async () => {
    const res = await importJson({
      schemaVersion: 1,
      suppliers: [
        { id: "old-s", name: "Old", identity: { domain: "DUNS", identity: "9" }, catalog: [{ supplierPartId: "P1", description: "Thing", unitPrice: 1, currency: "USD", uom: "EA" }] },
      ],
    });
    expect(res.status).toBe(200);
    expect(listProductLists().some((l) => l.name === "Old catalog")).toBe(true);
  });

  it("rejects dangling connection references without writing anything", async () => {
    const before = JSON.stringify(listConnections());
    const res = await importJson({ connections: [{ id: "bad", name: "Bad", buyerId: "nope", supplierId: "demo-supplier" }] });
    expect(res.status).toBe(400);
    expect((await res.json()).errors.join(" ")).toMatch(/missing buyer "nope"/);
    expect(JSON.stringify(listConnections())).toBe(before);
  });

  it("rejects malformed files", async () => {
    expect((await importJson("not json")).status).toBe(400);
    expect((await importJson([1, 2])).status).toBe(400);
    expect((await importJson({ format: "something-else", buyers: [] })).status).toBe(400);
    expect((await importJson({ foo: 1 })).status).toBe(400);
    expect((await importJson({ buyers: [{ name: "no id" }] })).status).toBe(400);
    expect((await importJson({ buyers: [{ id: "a" }, { id: "a" }] })).status).toBe(400);
    expect((await importJson({ buyers: [] }, "wipe")).status).toBe(400);
  });

  it("refuses a file from a newer schema", async () => {
    const res = await importJson({ schemaVersion: SCHEMA_VERSION + 1, buyers: [] });
    expect(res.status).toBe(400);
    expect((await res.json()).errors[0]).toMatch(/schema v\d+/);
  });
});
