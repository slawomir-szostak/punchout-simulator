import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { buildSetupRequest } from "../src/server/cxml/build.js";
import { parseSetupItems, parseXml } from "../src/server/cxml/parse.js";
import { validateDocument } from "../src/server/cxml/validate.js";
import { initConfig } from "../src/server/store/config.js";
import { setDataDir } from "../src/server/store/paths.js";
import { setRuntime } from "../src/server/runtime.js";
import { seedDemoIfEmpty } from "../src/server/seed.js";

// Level 2 PunchOut. A PunchOutSetupRequest may name the catalog item the user
// punched out from (SelectedItem); "PunchOut sites can use it to determine
// which products to display" — the whole store, an aisle, or one product.

const cred = (domain: string, identity: string) => ({ domain, identity });
const TS = "2026-01-01T10:00:00+01:00";
const setup = (over: Partial<Parameters<typeof buildSetupRequest>[0]> = {}) =>
  buildSetupRequest({ from: cred("DUNS", "123456789"), to: cred("DUNS", "987654321"), sender: cred("DUNS", "123456789"), sharedSecret: "demo-secret", buyerCookie: "c", browserFormPostUrl: "http://localhost:8080/punchout/return", payloadId: "p@h", timestamp: TS, operation: "create", ...over });
const codes = (xml: string) => validateDocument(xml, { forceDocType: "SetupRequest" }).issues.map((i) => i.code);

describe("the document", () => {
  it("places SelectedItem after ShipTo and before ItemOut, and reads it back", () => {
    const item = { quantity: 1, supplierPartId: "P1", description: "x", uom: "EA", unitPriceAmount: 1, currency: "USD", classifications: [{ domain: "UNSPSC", value: "1" }] };
    const xml = setup({ operation: "edit", shipTo: { name: "HQ", street: "1 Main", city: "X" }, items: [item], selectedItem: { supplierPartId: "WIDGET-001", supplierPartAuxiliaryId: "WIDGET-001-STD" } });
    const pos = ["</ShipTo>", "<SelectedItem>", "<ItemOut "].map((t) => xml.indexOf(t));
    expect(pos.every((p) => p > 0)).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
    expect(parseSetupItems(parseXml(xml)).selectedItem).toEqual({ supplierPartId: "WIDGET-001", supplierPartAuxiliaryId: "WIDGET-001-STD" });
    expect(parseSetupItems(parseXml(setup())).selectedItem).toBeUndefined();
    expect(setup({ selectedItem: { supplierPartId: "" } })).not.toContain("<SelectedItem>");
  });

  it("requires an ItemID with a SupplierPartID, and discourages it in a source operation", () => {
    const empty = setup().replace("</BrowserFormPost>", "</BrowserFormPost><SelectedItem><ItemID><SupplierPartID></SupplierPartID></ItemID></SelectedItem>");
    expect(codes(empty)).toContain("selecteditem-missing-id");
    const sourcing = setup({ selectedItem: { supplierPartId: "P1" } }).replace('operation="create"', 'operation="source"');
    expect(codes(sourcing)).toContain("selecteditem-in-source");
    expect(codes(setup({ selectedItem: { supplierPartId: "P1" } }))).not.toContain("selecteditem-missing-id");
  });
});

describe("the mock catalog opens where the buyer asked", () => {
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    setDataDir(mkdtempSync(join(tmpdir(), "pos-sel-")));
    setRuntime({ port: 0, publicUrl: "http://localhost:8080", token: undefined });
    await initConfig();
    await seedDemoIfEmpty();
    app = createApp({ quiet: true });
  });
  const catalogFor = async (cookie: string, selectedItem?: { supplierPartId: string; supplierPartAuxiliaryId?: string }) => {
    await app.request("/sim/demo-supplier/punchout", { method: "POST", headers: { "content-type": "text/xml" }, body: setup({ buyerCookie: cookie, selectedItem }) });
    return app.request(`/sim/demo-supplier/catalog?cookie=${cookie}`).then((r) => r.text());
  };
  const focused = (html: string) => (html.match(/data-focus="1"/g) ?? []).length;

  it("the whole store when no item is named", async () => {
    const html = await catalogFor("sel-0");
    expect(html).not.toContain("punched out to");
    expect(html).toContain('id="search" value=""');
    expect(focused(html)).toBe(0);
  });

  it("one product when the ID is a part number in the catalog", async () => {
    const html = await catalogFor("sel-1", { supplierPartId: "WIDGET-001", supplierPartAuxiliaryId: "WIDGET-001-STD" });
    expect(html).toContain("The buyer punched out to <strong>WIDGET-001 / WIDGET-001-STD</strong>. Showing that product.");
    expect(html).toContain('id="search" value="WIDGET-001"');
    expect(focused(html)).toBe(1);
    expect(html).toContain("Show the whole catalog");
  });

  it("a group of products when the ID matches several", async () => {
    // "TAPE" is not a part number, but two products' part numbers contain it.
    const html = await catalogFor("sel-2", { supplierPartId: "TAPE" });
    expect(html).toMatch(/The buyer punched out to <strong>TAPE<\/strong>\. Showing the \d+ products that match\./);
    expect(html).toContain('id="search" value="TAPE"');
    expect(focused(html)).toBe(0);
  });

  it("the whole store, with a note, when nothing matches", async () => {
    const html = await catalogFor("sel-3", { supplierPartId: "NO-SUCH-ITEM" });
    expect(html).toContain("The buyer punched out to <strong>NO-SUCH-ITEM</strong>, which this catalog does not have.");
    expect(html).toContain('id="search" value=""');
  });

  it("escapes the item ID it shows", async () => {
    const html = await catalogFor("sel-4", { supplierPartId: `"><img src=x onerror=alert(1)>` });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('value=""><img');
  });

  it("the buyer side puts the chosen item into the SetupRequest it previews", async () => {
    const res = await app.request("/api/connections/demo/setup/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "create", selectedItem: { supplierPartId: " BOLT-250 ", supplierPartAuxiliaryId: "" } }),
    });
    const { xml } = (await res.json()) as { xml: string };
    expect(xml).toMatch(/<SelectedItem>\s*<ItemID>\s*<SupplierPartID>BOLT-250<\/SupplierPartID>\s*<\/ItemID>\s*<\/SelectedItem>/);
  });
});
