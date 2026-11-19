import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { buildOrderRequest, buildPunchOutOrderMessage, computeTax } from "../src/server/cxml/build.js";
import { parseCart, parseXml } from "../src/server/cxml/parse.js";
import { validateDocument } from "../src/server/cxml/validate.js";
import { getBuyer, getConnection, getSupplier, initConfig, updateBuyer, updateSupplier } from "../src/server/store/config.js";
import { setDataDir } from "../src/server/store/paths.js";
import { setRuntime } from "../src/server/runtime.js";
import { seedDemoIfEmpty } from "../src/server/seed.js";

// Tax, Shipping and Distribution, as the cXML DTD and Reference Guide define
// them. The rule everything hangs on: a Total is the cost of the items
// "excluding any tax and shipping" — in an order and in a punchback alike.

const cred = (domain: string, identity: string) => ({ domain, identity });
const TS = "2026-01-01T10:00:00+01:00";
const codes = (xml: string, ctx = {}) => validateDocument(xml, ctx).issues.map((i) => i.code);
const severityOf = (xml: string, code: string) => validateDocument(xml).issues.find((i) => i.code === code)?.severity;
const item = { quantity: 2, supplierPartId: "P1", description: "Widget", uom: "EA", unitPriceAmount: 10, currency: "USD", classifications: [{ domain: "UNSPSC", value: "31161500" }] };
const order = {
  from: cred("DUNS", "111"), to: cred("DUNS", "222"), sender: cred("DUNS", "111"), sharedSecret: "s",
  orderId: "PO-1", orderDate: TS, payloadId: "p@h", timestamp: TS, currency: "USD", total: 20, items: [item],
  shipTo: { name: "HQ", street: "1 Main", city: "X" }, billTo: { name: "HQ", street: "1 Main", city: "X" },
};
const accounting = { name: "DistributionCharge", segments: [{ name: "Cost Center", id: "4711", description: "Marketing" }] };
const pom = { from: cred("DUNS", "222"), to: cred("DUNS", "111"), sender: cred("DUNS", "222"), buyerCookie: "c", payloadId: "p@h", timestamp: TS, currency: "USD", operationAllowed: "edit" as const };

describe("building", () => {
  it("computes tax on the taxable amount, to the cent", () => {
    expect(computeTax({ ratePercent: 8.25, category: "sales" }, 19.99, "USD")).toMatchObject({ amount: 1.65, taxableAmount: 19.99, ratePercent: 8.25, category: "sales" });
  });

  it("puts Shipping and Tax in the order header after BillTo and before Contact, leaving Total alone", () => {
    const xml = buildOrderRequest({
      ...order,
      contact: { role: "buyer", name: "Jo" },
      shipping: { amount: 5, currency: "USD", description: "Ground" },
      tax: computeTax({ ratePercent: 10, category: "vat", description: "VAT" }, 20, "USD"),
    });
    const pos = ["</BillTo>", "<Shipping>", "<Tax>", "<Contact "].map((t) => xml.indexOf(t));
    expect(pos.every((p) => p > 0)).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
    expect(xml).toContain('<Total>\n          <Money currency="USD">20</Money>');
    expect(xml).toContain('<TaxDetail purpose="tax" category="vat" percentageRate="10">');
    expect(xml).toContain('<TaxableAmount><Money currency="USD">20.00</Money></TaxableAmount>');
    expect(validateDocument(xml).issues.filter((i) => i.severity !== "info")).toEqual([]);
  });

  it("gives each line its own Tax and a Distribution charging the line amount, before Comments", () => {
    const xml = buildOrderRequest({ ...order, items: [item, { ...item, supplierPartId: "P2", quantity: 1, unitPriceAmount: 5 }], total: 25,
      tax: computeTax({ ratePercent: 10, category: "sales" }, 25, "USD"), lineTax: { ratePercent: 10, category: "sales" }, accounting,
      attachments: [{ contentId: "a@x", scope: { itemIndex: 1 } }] });
    const first = xml.slice(xml.indexOf("<ItemOut"), xml.indexOf("</ItemOut>"));
    const pos = ["</ItemDetail>", "<Tax>", "<Distribution>", "<Comments"].map((t) => first.indexOf(t));
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
    expect(first).toContain('<Accounting name="DistributionCharge">');
    expect(first).toContain('<AccountingSegment id="4711">');
    expect(first).toMatch(/<Charge>\s*<Money currency="USD">20.00<\/Money>/);
    // Line taxes (2.00 + 0.50) add up to the header tax (2.50); nothing to report.
    expect(codes(xml)).not.toContain("tax-lines-mismatch");
    expect(codes(xml)).not.toContain("distribution-sum-mismatch");
  });

  it("quotes Shipping and Tax in the punchback header and reads them back", () => {
    const xml = buildPunchOutOrderMessage({ ...pom, items: [item], shipping: { amount: 5, currency: "USD", description: "Ground" }, tax: computeTax({ ratePercent: 23, category: "vat", description: "VAT 23%" }, 20, "USD") });
    const head = xml.slice(xml.indexOf("<PunchOutOrderMessageHeader"), xml.indexOf("</PunchOutOrderMessageHeader>"));
    expect(head.indexOf("<Total>")).toBeLessThan(head.indexOf("<Shipping>"));
    expect(head.indexOf("<Shipping>")).toBeLessThan(head.indexOf("<Tax>"));
    const cart = parseCart(parseXml(xml));
    expect(cart.total).toEqual({ amount: 20, currency: "USD" });
    expect(cart.shipping).toEqual({ amount: 5, currency: "USD", description: "Ground" });
    expect(cart.tax).toEqual({ amount: 4.6, currency: "USD", description: "VAT 23%" });
    expect(validateDocument(xml).issues).toEqual([]);
  });
});

describe("validation", () => {
  const withCharges = (total: string) =>
    buildPunchOutOrderMessage({ ...pom, items: [item], shipping: { amount: 5, currency: "USD" }, tax: computeTax({ ratePercent: 10, category: "sales" }, 20, "USD") })
      .replace('<Money currency="USD">20.00</Money>\n        </Total>', `<Money currency="USD">${total}</Money>\n        </Total>`);

  it("names the classic mistake: a Total that includes tax and shipping", () => {
    expect(codes(withCharges("27.00"))).toContain("total-includes-charges");
    expect(codes(withCharges("27.00"))).not.toContain("total-mismatch");
    expect(codes(withCharges("21.00"))).toContain("total-mismatch");
    expect(codes(withCharges("20.00"))).not.toContain("total-mismatch");
  });

  it("checks an order's Total against its lines too (not for blanket orders)", () => {
    const wrong = buildOrderRequest({ ...order, total: 99 });
    expect(codes(wrong)).toContain("total-mismatch");
    expect(codes(wrong.replace('type="new"', 'type="new" orderType="blanket"'))).not.toContain("total-mismatch");
  });

  it("requires Tax and Shipping to carry Money and a Description, and TaxDetail a category", () => {
    const xml = buildOrderRequest({ ...order, shipping: { amount: 5, currency: "USD" }, tax: computeTax({ ratePercent: 10, category: "sales" }, 20, "USD") });
    expect(severityOf(xml.replace(/<Shipping>\s*<Money[^<]*<\/Money>/, "<Shipping>"), "shipping-incomplete")).toBe("error");
    expect(severityOf(xml.replace(/(<Tax>\s*<Money[^<]*<\/Money>\s*)<Description[^<]*<\/Description>/, "$1"), "tax-incomplete")).toBe("error");
    expect(severityOf(xml.replace(' category="sales"', ""), "taxdetail-missing-category")).toBe("error");
  });

  it("warns when the tax arithmetic does not hold", () => {
    const xml = buildOrderRequest({ ...order, tax: computeTax({ ratePercent: 10, category: "sales" }, 20, "USD") });
    // 10% of 20.00 is 2.00, the detail says 3.00 → rate mismatch, and the total no longer equals its details.
    const badDetail = xml.replace('<TaxAmount><Money currency="USD">2.00</Money></TaxAmount>', '<TaxAmount><Money currency="USD">3.00</Money></TaxAmount>');
    expect(codes(badDetail)).toEqual(expect.arrayContaining(["tax-rate-mismatch", "tax-detail-mismatch"]));
    const lines = buildOrderRequest({ ...order, tax: { ...computeTax({ ratePercent: 10, category: "sales" }, 20, "USD"), amount: 9, taxableAmount: undefined, ratePercent: undefined, category: undefined }, lineTax: { ratePercent: 10, category: "sales" } });
    expect(codes(lines)).toContain("tax-lines-mismatch");
  });

  it("warns when Shipping is at both levels or in another currency", () => {
    const xml = buildOrderRequest({ ...order, shipping: { amount: 5, currency: "EUR" } });
    expect(codes(xml)).toContain("charge-currency-differs");
    const both = xml.replace("</ItemDetail>", '</ItemDetail><Shipping><Money currency="USD">1</Money><Description xml:lang="en">x</Description></Shipping>');
    expect(codes(both)).toContain("shipping-at-both-levels");
  });

  it("checks a Distribution: accounting name, segments, ids, and that the charges cover the line", () => {
    const xml = buildOrderRequest({ ...order, accounting });
    expect(validateDocument(xml).issues.filter((i) => i.severity !== "info")).toEqual([]);
    expect(severityOf(xml.replace(' name="DistributionCharge"', ""), "accounting-missing-name")).toBe("error");
    expect(severityOf(xml.replace(' id="4711"', ""), "accountingsegment-missing-id")).toBe("error");
    expect(severityOf(xml.replace(/<AccountingSegment[\s\S]*?<\/AccountingSegment>/, ""), "accounting-no-segments")).toBe("error");
    expect(severityOf(xml.replace(/(<Charge>\s*<Money currency="USD">)20.00/, "$115.00"), "distribution-sum-mismatch")).toBe("warning");
    const legacy = xml.replace(/<AccountingSegment[\s\S]*?<\/AccountingSegment>/, '<Segment type="Cost Center" id="4711" description="Marketing"/>');
    expect(severityOf(legacy, "segment-deprecated")).toBe("info");
  });
});

describe("end to end (in-process)", () => {
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    setDataDir(mkdtempSync(join(tmpdir(), "pos-chg-")));
    setRuntime({ port: 0, publicUrl: "http://localhost:8080", token: undefined });
    await initConfig();
    await seedDemoIfEmpty();
    app = createApp({ quiet: true });
  });
  const form = (path: string, fields: Record<string, string>) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  const json = (path: string, body: unknown, method = "POST") =>
    app.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const punchbackOf = (html: string) => decode(/name="cxml-urlencoded" value="([\s\S]*?)">/.exec(html)![1]);
  const openSession = (cookie: string) =>
    app.request("/sim/demo-supplier/punchout", {
      method: "POST",
      headers: { "content-type": "text/xml" },
      body: `<cXML payloadID="s-${cookie}@h" timestamp="${TS}"><Header>
        <From><Credential domain="DUNS"><Identity>123456789</Identity></Credential></From>
        <To><Credential domain="DUNS"><Identity>987654321</Identity></Credential></To>
        <Sender><Credential domain="DUNS"><Identity>123456789</Identity><SharedSecret>demo-secret</SharedSecret></Credential><UserAgent>t</UserAgent></Sender>
        </Header><Request><PunchOutSetupRequest operation="create"><BuyerCookie>${cookie}</BuyerCookie>
        <BrowserFormPost><URL>http://localhost:8080/punchout/return</URL></BrowserFormPost></PunchOutSetupRequest></Request></cXML>`,
    });
  const preview = (body: unknown) => json("/api/connections/demo/order/preview", body).then((r) => r.json() as Promise<any>);

  it("saves charge settings through the API, dropping incomplete ones", async () => {
    const s = getSupplier("demo-supplier")!;
    const saved = await json("/api/suppliers/demo-supplier", { ...s, cartTax: { ratePercent: "23", category: "vat", description: "VAT 23%" }, cartShipping: { amount: 7.5, description: "Courier" } }, "PUT").then((r) => r.json() as Promise<any>);
    expect(saved.cartTax).toEqual({ ratePercent: 23, category: "vat", description: "VAT 23%" });
    expect(saved.cartShipping).toEqual({ amount: 7.5, description: "Courier" });
    const b = getBuyer("demo-buyer")!;
    const buyer = await json("/api/buyers/demo-buyer", { ...b, tax: { category: "vat" }, shipping: { amount: "" }, accounting: { name: "X", segments: [{ name: "Cost Center", id: "" }] } }, "PUT").then((r) => r.json() as Promise<any>);
    expect(buyer.tax).toBeUndefined(); // no rate
    expect(buyer.shipping).toBeUndefined(); // no amount
    expect(buyer.accounting).toBeUndefined(); // no segment with a code
  });

  it("the mock supplier quotes its tax and shipping beside a goods-only Total", async () => {
    await openSession("chg-1");
    const xml = punchbackOf(await form("/sim/demo-supplier/checkout", { cookie: "chg-1", q_0: "2" }).then((r) => r.text()));
    const cart = parseCart(parseXml(xml));
    expect(cart.total?.amount).toBe(25); // 2 × 12.50, nothing added
    expect(cart.shipping).toEqual({ amount: 7.5, currency: "USD", description: "Courier" });
    expect(cart.tax).toEqual({ amount: 5.75, currency: "USD", description: "VAT 23%" });
    expect(validateDocument(xml, { setupOperation: "create" }).issues).toEqual([]);

    // A cancelled cart has nothing to charge.
    await openSession("chg-2");
    const cancelled = punchbackOf(await form("/sim/demo-supplier/checkout", { cookie: "chg-2", action: "cancel" }).then((r) => r.text()));
    expect(cancelled).not.toContain("<Shipping>");
    expect(cancelled).not.toContain("<Tax>");

    await form("/punchout/return", { "cxml-urlencoded": xml });
    const stored = await app.request("/api/cart/chg-1").then((r) => r.json() as Promise<any>);
    expect(stored.tax.amount).toBe(5.75);
  });

  it("an order carries the supplier's quote unless the buyer computes its own", async () => {
    const items = [{ quantity: 2, supplierPartId: "WIDGET-001", description: "Premium Steel Widget", uom: "EA", unitPriceAmount: 12.5, currency: "USD", classifications: [{ domain: "UNSPSC", value: "31161500" }] }];
    // The buyer has no settings: the cart's quoted charges go into the order.
    const quoted = await preview({ sessionId: "chg-1", items, currency: "USD" });
    expect(quoted.xml).toMatch(/<Shipping>\s*<Money currency="USD">7.50<\/Money>/);
    expect(quoted.xml).toMatch(/<Tax>\s*<Money currency="USD">5.75<\/Money>/);
    expect(quoted.xml).not.toContain("<Distribution>");

    // The buyer computes tax itself, ships flat, and assigns a cost centre.
    const b = getBuyer("demo-buyer")!;
    await updateBuyer("demo-buyer", { ...b, tax: { ratePercent: 8, category: "sales", description: "Sales tax", level: "lines" }, shipping: { amount: 3, description: "Flat" }, accounting });
    const own = await preview({ sessionId: "chg-1", items, currency: "USD" });
    expect(own.xml).toMatch(/<Shipping>\s*<Money currency="USD">3.00<\/Money>/);
    expect(own.xml).toMatch(/<Tax>\s*<Money currency="USD">2.00<\/Money>/); // 8% of 25.00
    expect(own.xml).toContain('<AccountingSegment id="4711">');
    expect(own.xml).toMatch(/<Total>\s*<Money currency="USD">25<\/Money>/);
    const sent = await json("/api/connections/demo/validate", { docType: "OrderRequest", xml: own.xml }).then((r) => r.json() as Promise<any>);
    expect(sent.issues.filter((i: any) => i.severity !== "info")).toEqual([]);

    // A mixed-currency order has no single Total to charge against.
    const mixed = await preview({ sessionId: "chg-1", items: [...items, { ...items[0], currency: "EUR" }], currency: "USD" });
    expect(mixed.xml).not.toContain("<Tax>");
    expect(mixed.xml).not.toContain("<Shipping>");
    await updateBuyer("demo-buyer", b);
    await updateSupplier("demo-supplier", getSupplier("demo-supplier")!);
  });

  // Charges are agreed per customer: the connection for a buyer–supplier pair
  // overrides what the buyer and the supplier would do by default.
  describe("per connection", () => {
    const items = [{ quantity: 2, supplierPartId: "WIDGET-001", description: "Premium Steel Widget", uom: "EA", unitPriceAmount: 12.5, currency: "USD", classifications: [{ domain: "UNSPSC", value: "31161500" }] }];
    const setConnection = async (patch: Record<string, unknown>) => {
      const res = await json("/api/connections/demo", { ...getConnection("demo")!, sharedSecret: "", ...patch }, "PUT");
      expect(res.status).toBe(200);
      return res.json() as Promise<any>;
    };
    const cartFor = async (cookie: string) => {
      await openSession(cookie);
      return parseCart(parseXml(punchbackOf(await form("/sim/demo-supplier/checkout", { cookie, q_0: "2" }).then((r) => r.text()))));
    };

    it("the mock supplier quotes this buyer nothing, or its own figures, whatever the supplier's default", async () => {
      // The supplier default (set earlier): 23% VAT + 7.50 shipping.
      expect((await cartFor("pc-0")).tax?.amount).toBe(5.75);

      const saved = await setConnection({ cartCharges: { mode: "none" } });
      expect(saved.cartCharges).toEqual({ mode: "none" });
      const none = await cartFor("pc-1");
      expect(none.tax).toBeUndefined();
      expect(none.shipping).toBeUndefined();
      expect(none.total?.amount).toBe(25);

      await setConnection({ cartCharges: { mode: "custom", tax: { ratePercent: 5, category: "gst", description: "GST" } } });
      const custom = await cartFor("pc-2");
      expect(custom.tax).toEqual({ amount: 1.25, currency: "USD", description: "GST" });
      expect(custom.shipping).toBeUndefined(); // not filled in for this pair → left out

      // A buyer without a connection to this supplier still gets the default.
      await app.request("/sim/demo-supplier/punchout", {
        method: "POST",
        headers: { "content-type": "text/xml" },
        body: `<cXML payloadID="s-other@h" timestamp="${TS}"><Header>
          <From><Credential domain="DUNS"><Identity>000000001</Identity></Credential></From>
          <To><Credential domain="DUNS"><Identity>987654321</Identity></Credential></To>
          <Sender><Credential domain="DUNS"><Identity>000000001</Identity><SharedSecret>x</SharedSecret></Credential><UserAgent>t</UserAgent></Sender>
          </Header><Request><PunchOutSetupRequest operation="create"><BuyerCookie>pc-other</BuyerCookie>
          <BrowserFormPost><URL>http://localhost:8080/punchout/return</URL></BrowserFormPost></PunchOutSetupRequest></Request></cXML>`,
      });
      const other = parseCart(parseXml(punchbackOf(await form("/sim/demo-supplier/checkout", { cookie: "pc-other", q_0: "2" }).then((r) => r.text()))));
      expect(other.tax?.amount).toBe(5.75);
      await setConnection({ cartCharges: undefined });
    });

    it("an order to this supplier follows the connection: none means none, not even the supplier's quote", async () => {
      const b = getBuyer("demo-buyer")!;
      await updateBuyer("demo-buyer", { ...b, tax: { ratePercent: 8, category: "sales" }, shipping: { amount: 3 } });

      // Default: the buyer's own figures.
      expect((await preview({ sessionId: "chg-1", items, currency: "USD" })).xml).toMatch(/<Tax>\s*<Money currency="USD">2.00<\/Money>/);

      // None for this pair — and the cart for chg-1 did carry a quote, which must not be used either.
      await setConnection({ orderCharges: { mode: "none" } });
      const none = (await preview({ sessionId: "chg-1", items, currency: "USD" })).xml;
      expect(none).not.toContain("<Tax>");
      expect(none).not.toContain("<Shipping>");

      // Specific to this pair.
      await setConnection({ orderCharges: { mode: "custom", shipping: { amount: 12, description: "Express" } } });
      const custom = (await preview({ sessionId: "chg-1", items, currency: "USD" })).xml;
      expect(custom).toMatch(/<Shipping>\s*<Money currency="USD">12.00<\/Money>/);
      expect(custom).not.toContain("<Tax>");

      await setConnection({ orderCharges: undefined });
      await updateBuyer("demo-buyer", b);
    });
  });
});
