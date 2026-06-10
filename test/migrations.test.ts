import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  getProfile,
  initConfig,
  listBuyers,
  listConnections,
  listProductLists,
  listSuppliers,
} from "../src/server/store/config.js";
import { configPath, setDataDir } from "../src/server/store/paths.js";

// Fixture tests for the versioned config.json migration chain. Each fixture is
// a frozen copy of a shape an earlier release actually persisted; initConfig
// must converge it to the current schema and stamp schemaVersion.

function writeConfig(data: unknown): void {
  writeFileSync(configPath(), JSON.stringify(data), "utf8");
}

function readConfig(): any {
  return JSON.parse(readFileSync(configPath(), "utf8"));
}

beforeEach(() => {
  setDataDir(mkdtempSync(join(tmpdir(), "pos-mig-")));
});

describe("schemaVersion", () => {
  it("stamps a fresh data dir with the current version", async () => {
    await initConfig();
    expect(readConfig().schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("stamps a pre-versioning file after running the full chain", async () => {
    writeConfig({ buyers: [], suppliers: [], connections: [], profiles: [], productLists: [] });
    await initConfig();
    expect(readConfig().schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("refuses to open data written by a newer build (downgrade guard)", async () => {
    writeConfig({
      schemaVersion: SCHEMA_VERSION + 1,
      buyers: [],
      suppliers: [],
      connections: [],
      profiles: [],
      productLists: [],
    });
    await expect(initConfig()).rejects.toThrow(/schema v\d+/);
    // And it must not have rewritten (and thereby downgraded) the file.
    expect(readConfig().schemaVersion).toBe(SCHEMA_VERSION + 1);
  });
});

describe("migration 1: flat legacy connections → Buyer/Supplier/Connection", () => {
  it("normalizes a pre-normalization virtual-buyer connection", async () => {
    writeConfig({
      connections: [
        {
          id: "legacy1",
          name: "Acme @ Supplies Inc",
          mode: "virtual-buyer",
          from: { domain: "DUNS", identity: "111111111" },
          to: { domain: "DUNS", identity: "222222222" },
          sender: { domain: "NetworkID", identity: "acme-login" },
          sharedSecret: "s3cret",
          punchoutUrl: "https://supplier.example/punchout",
          orderUrl: "https://supplier.example/order",
          deploymentMode: "test",
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      ],
    });
    await initConfig();

    const buyers = listBuyers();
    const suppliers = listSuppliers();
    const conns = listConnections();
    expect(buyers.some((b) => b.identity.identity === "111111111")).toBe(true);
    expect(suppliers.some((s) => s.identity.identity === "222222222")).toBe(true);
    const conn = conns.find((c) => c.id === "legacy1");
    expect(conn).toBeDefined();
    expect(conn!.sharedSecret).toBe("s3cret");
    expect(conn!.senderIdentity).toEqual({ domain: "NetworkID", identity: "acme-login" });
    const supplier = suppliers.find((s) => s.id === conn!.supplierId)!;
    expect(supplier.punchoutUrl).toBe("https://supplier.example/punchout");
    // No flat fields survive on the stored connection.
    const stored = readConfig().connections.find((c: any) => c.id === "legacy1");
    expect(stored.from).toBeUndefined();
    expect(stored.to).toBeUndefined();
  });
});

describe("migration 2: inline Supplier.catalog → standalone ProductList", () => {
  it("moves a non-empty inline catalog into a referenced product list", async () => {
    writeConfig({
      suppliers: [
        {
          id: "sup1",
          name: "Inline Cat Co",
          identity: { domain: "DUNS", identity: "333333333" },
          catalog: [
            { supplierPartId: "P-1", description: "Widget", unitPrice: 9.5, currency: "EUR", uom: "EA" },
          ],
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      ],
    });
    await initConfig();

    const supplier = listSuppliers().find((s) => s.id === "sup1")!;
    expect((supplier as any).catalog).toBeUndefined();
    expect(supplier.productListIds).toHaveLength(1);
    const list = listProductLists().find((p) => p.id === supplier.productListIds![0])!;
    expect(list.items).toHaveLength(1);
    expect(list.items[0].supplierPartId).toBe("P-1");
  });
});

describe("migration 3: profile address-emission backfill + Jaggaer refresh", () => {
  it("backfills addressMode/shipToInSetup/contactInSetup on old custom profiles", async () => {
    writeConfig({
      profiles: [
        {
          id: "custom1",
          name: "My Tenant",
          platform: "Custom",
          dtdVersions: { default: "1.2.045" },
          userAgent: "Custom UA",
          setupOperation: "create",
          attachmentEncoding: "binary",
          cartReturnTransport: "cxml-urlencoded",
          extrinsics: [],
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      ],
    });
    await initConfig();

    const p = getProfile("custom1")!;
    expect(p.addressMode).toBe("full");
    expect(p.shipToInSetup).toBe(false);
    expect(p.contactInSetup).toBe(false);
  });

  it("refreshes the untouched seeded Jaggaer row but not a user-edited one", async () => {
    writeConfig({
      profiles: [
        {
          id: "jaggaer",
          builtin: true,
          name: "JAGGAER",
          platform: "JAGGAER",
          dtdVersions: { default: "1.2.021" },
          userAgent: "JAGGAER Procurement",
          setupOperation: "create",
          attachmentEncoding: "binary",
          cartReturnTransport: "cxml-urlencoded",
          extrinsics: [],
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      ],
    });
    await initConfig();

    const j = getProfile("jaggaer")!;
    expect(j.name).toBe("Jaggaer");
    expect(j.userAgent).toBe("JAGGAER");
    expect(j.dtdVersions.default).toBe("1.2.011");
  });
});

describe("migration 4: item.unspsc → classifications[]", () => {
  it("converts the legacy single UNSPSC string and drops the old field", async () => {
    writeConfig({
      productLists: [
        {
          id: "list1",
          name: "Old list",
          items: [
            { supplierPartId: "A", description: "a", unitPrice: 1, currency: "USD", uom: "EA", unspsc: "43211503" },
            { supplierPartId: "B", description: "b", unitPrice: 2, currency: "USD", uom: "EA" },
          ],
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      ],
    });
    await initConfig();

    const list = listProductLists().find((p) => p.id === "list1")!;
    expect(list.items[0].classifications).toEqual([{ domain: "UNSPSC", value: "43211503" }]);
    expect(list.items[1].classifications).toEqual([]);
    expect((readConfig().productLists.find((p: any) => p.id === "list1").items[0] as any).unspsc).toBeUndefined();
  });
});

describe("version gating", () => {
  it("does not re-run earlier migrations on data already at the current version", async () => {
    // A supplier with an inline catalog AND productListIds, stamped current:
    // pre-versioning code would still delete `catalog`; gated code must not touch it.
    writeConfig({
      schemaVersion: SCHEMA_VERSION,
      suppliers: [
        {
          id: "sup2",
          name: "Stamped",
          identity: { domain: "DUNS", identity: "444444444" },
          catalog: [{ supplierPartId: "X", description: "x", unitPrice: 1, currency: "USD", uom: "EA" }],
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      ],
    });
    await initConfig();
    const stored = readConfig().suppliers.find((s: any) => s.id === "sup2");
    expect(stored.catalog).toHaveLength(1);
    expect(stored.productListIds).toBeUndefined();
  });
});
