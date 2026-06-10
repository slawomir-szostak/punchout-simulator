import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import {
  catalogForSupplier,
  createProductList,
  createSupplier,
  deleteProductList,
  getProductList,
  getSupplier,
  initConfig,
  listProductLists,
  listSuppliers,
} from "../src/server/store/config.js";
import { setDataDir } from "../src/server/store/paths.js";
import type { CatalogItem, Supplier } from "../src/server/cxml/types.js";

const item = (over: Partial<CatalogItem> = {}): CatalogItem => ({
  supplierPartId: "P", description: "d", unitPrice: 1, currency: "USD", uom: "EA",
  classifications: [{ domain: "UNSPSC", value: "1" }], ...over,
});

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  setDataDir(mkdtempSync(join(tmpdir(), "pos-products-")));
  await initConfig();
  app = createApp({ quiet: true });
});

describe("built-in sample list seeding", () => {
  it("seeds the sample assortment on init (idempotent)", () => {
    const ids = listProductLists().map((p) => p.id);
    expect(ids).toContain("sample");
    const sample = getProductList("sample")!;
    expect(sample.items.length).toBeGreaterThanOrEqual(20);
    // a divisible-UoM item opts into fractional quantities
    expect(sample.items.some((it) => it.allowFractional)).toBe(true);
  });
});

describe("catalogForSupplier", () => {
  it("concatenates the items of all referenced lists, in order, skipping missing ids", async () => {
    const a = await createProductList({ name: "A", items: [item({ supplierPartId: "A1" })] });
    const b = await createProductList({ name: "B", items: [item({ supplierPartId: "B1" }), item({ supplierPartId: "B2" })] });
    const s = await createSupplier({
      name: "S", identity: { domain: "DUNS", identity: "1" },
      productListIds: [a.id, "nope", b.id],
    });
    const parts = catalogForSupplier(getSupplier(s.id)!).map((it) => it.supplierPartId);
    expect(parts).toEqual(["A1", "B1", "B2"]);
  });

  it("returns an empty array when the supplier references no lists", async () => {
    const s = await createSupplier({ name: "Empty", identity: { domain: "DUNS", identity: "2" } });
    expect(catalogForSupplier(getSupplier(s.id)!)).toEqual([]);
  });
});

describe("products route", () => {
  it("CRUD round-trips a custom list and coerces allowFractional", async () => {
    const createRes = await app.request("/api/product-lists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "My List", items: [{ supplierPartId: "X", description: "x", unitPrice: 2.5, allowFractional: true }] }),
    });
    const created = await createRes.json();
    expect(created.id).toBeTruthy();
    expect(created.items[0].allowFractional).toBe(true);
    expect(created.items[0].unitPrice).toBe(2.5);

    const got = await (await app.request(`/api/product-lists/${created.id}`)).json();
    expect(got.name).toBe("My List");

    const del = await app.request(`/api/product-lists/${created.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
  });

  it("exposes the built-in preset library", async () => {
    const presets = await (await app.request("/api/product-list-presets")).json();
    expect(presets.map((p: any) => p.id)).toContain("sample");
  });

  it("rejects a malformed JSON body with 400 instead of coercing to {}", async () => {
    const res = await app.request("/api/product-lists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not valid json",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not valid json/i);
  });

  it("still accepts an empty body as defaults", async () => {
    const res = await app.request("/api/product-lists", { method: "POST" });
    // empty body -> {} -> name defaults, so creation succeeds (201)
    expect(res.status).toBe(201);
  });

  it("blocks deleting a list referenced by a supplier (409)", async () => {
    const list = await createProductList({ name: "Referenced", items: [item()] });
    await createSupplier({ name: "Ref Supplier", identity: { domain: "DUNS", identity: "9" }, productListIds: [list.id] });

    await expect(deleteProductList(list.id)).rejects.toThrow(/referenced by a supplier/);

    const res = await app.request(`/api/product-lists/${list.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
  });
});

describe("fractional quantities (Mode B)", () => {
  it("renders step=\"any\" for fractional items and step=\"1\" otherwise", async () => {
    const list = await createProductList({
      name: "Frac", items: [item({ supplierPartId: "FRAC", allowFractional: true }), item({ supplierPartId: "WHOLE" })],
    });
    const s = await createSupplier({ name: "FracCo", identity: { domain: "DUNS", identity: "31" }, productListIds: [list.id] });
    const html = await (await app.request(`/sim/${s.id}/catalog`)).text();
    expect(html).toContain('name="q_0" value="0" min="0" step="any"');
    expect(html).toContain('name="q_1" value="0" min="0" step="1"');
  });

  it("preserves a fractional qty but floors a non-fractional one at checkout", async () => {
    const list = await createProductList({
      name: "Frac2", items: [item({ supplierPartId: "FRAC", allowFractional: true }), item({ supplierPartId: "WHOLE" })],
    });
    const s = await createSupplier({ name: "FracCo2", identity: { domain: "DUNS", identity: "32" }, productListIds: [list.id] });
    const html = await (
      await app.request(`/sim/${s.id}/checkout`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ cookie: "f1", q_0: "1.5", q_1: "2.7" }).toString(),
      })
    ).text();
    const xml = /name="cxml-urlencoded" value="([\s\S]*?)">/.exec(html)![1]
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    expect(xml).toContain('<ItemIn quantity="1.5">'); // fractional preserved
    expect(xml).toContain('<ItemIn quantity="2">'); // non-fractional floored from 2.7
  });
});

describe("aux ID & multiple classifications (Mode B → punchback)", () => {
  it("emits SupplierPartAuxiliaryID and every Classification for a checked-out item", async () => {
    const list = await createProductList({
      name: "Rich", items: [item({
        supplierPartId: "RICH-1",
        supplierPartAuxiliaryId: "RICH-1-AUX",
        classifications: [{ domain: "UNSPSC", value: "31161500" }, { domain: "eCl@ss", value: "27-06-01-01" }],
      })],
    });
    const s = await createSupplier({ name: "RichCo", identity: { domain: "DUNS", identity: "41" }, productListIds: [list.id] });
    const html = await (
      await app.request(`/sim/${s.id}/checkout`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ cookie: "r1", q_0: "1" }).toString(),
      })
    ).text();
    const xml = /name="cxml-urlencoded" value="([\s\S]*?)">/.exec(html)![1]
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    expect(xml).toContain("<SupplierPartAuxiliaryID>RICH-1-AUX</SupplierPartAuxiliaryID>");
    expect(xml).toContain('<Classification domain="UNSPSC">31161500</Classification>');
    expect(xml).toContain('<Classification domain="eCl@ss">27-06-01-01</Classification>');
  });
});

describe("legacy inline-catalog migration", () => {
  it("converts a supplier's inline catalog into a generated list and clears the inline field", async () => {
    // Simulate a hand-edited config.json with a legacy inline catalog by writing
    // through createSupplier (SupplierInput still accepts `catalog`), then re-init.
    const legacy = await createSupplier({
      name: "Legacy Co", identity: { domain: "DUNS", identity: "77" },
      catalog: [item({ supplierPartId: "LEG-1" })],
    } as Supplier);

    await initConfig(); // migration runs on init

    const migrated = listSuppliers().find((s) => s.id === legacy.id)!;
    expect(migrated.catalog).toBeUndefined();
    expect(migrated.productListIds?.length).toBe(1);
    const list = getProductList(migrated.productListIds![0])!;
    expect(list.name).toBe("Legacy Co catalog");
    expect(list.items[0].supplierPartId).toBe("LEG-1");
  });
});
