import { describe, expect, it } from "vitest";
import {
  applyExtrinsicTokens,
  buildOrderRequest,
  buildPunchOutOrderMessage,
  buildSetupRequest,
  escapeXml,
  makePayloadId,
} from "../src/server/cxml/build.js";

const buyer = { domain: "DUNS", identity: "111" };
const supplier = { domain: "DUNS", identity: "222" };

describe("escapeXml", () => {
  it("escapes the five XML entities", () => {
    expect(escapeXml(`<a b="c">&'`)).toBe("&lt;a b=&quot;c&quot;&gt;&amp;&apos;");
  });
  it("renders empty for null/undefined", () => {
    expect(escapeXml(undefined)).toBe("");
    expect(escapeXml(null)).toBe("");
  });
});

describe("makePayloadId", () => {
  it("has the form <unique>@<host>", () => {
    const id = makePayloadId("example.com", "2026-01-01T00:00:00.000Z");
    expect(id).toContain("@example.com");
    expect(id.startsWith("2026-01-01T00:00:00.000Z.")).toBe(true);
  });
});

describe("buildSetupRequest", () => {
  const xml = buildSetupRequest({
    from: buyer,
    to: supplier,
    sender: buyer,
    sharedSecret: "s3cret",
    buyerCookie: "cookie-1",
    browserFormPostUrl: "http://localhost:8080/punchout/return",
    payloadId: "p@h",
    timestamp: "2026-01-01T00:00:00.000Z",
    deploymentMode: "test",
  });

  it("includes the BrowserFormPost callback URL", () => {
    expect(xml).toContain("<URL>http://localhost:8080/punchout/return</URL>");
  });
  it("includes the SharedSecret in the Sender", () => {
    expect(xml).toContain("<SharedSecret>s3cret</SharedSecret>");
  });
  it("carries the BuyerCookie and deploymentMode", () => {
    expect(xml).toContain("<BuyerCookie>cookie-1</BuyerCookie>");
    expect(xml).toContain('deploymentMode="test"');
  });
});

describe("buildOrderRequest with attachments at both levels", () => {
  const xml = buildOrderRequest({
    from: buyer,
    to: supplier,
    sender: buyer,
    orderId: "PO-1",
    orderDate: "2026-01-01",
    payloadId: "p@h",
    timestamp: "2026-01-01T00:00:00.000Z",
    currency: "USD",
    total: 25,
    items: [
      { quantity: 1, supplierPartId: "A", unitPriceAmount: 10, currency: "USD", description: "Item A", uom: "EA", classification: "111", classificationDomain: "UNSPSC" },
      { quantity: 3, supplierPartId: "B", unitPriceAmount: 5, currency: "USD", description: "Item B", uom: "EA", classification: "222", classificationDomain: "UNSPSC" },
    ],
    attachments: [
      { contentId: "order-doc", scope: "order" },
      { contentId: "item-doc", scope: { itemIndex: 2 } },
    ],
  });

  it("references the order-level attachment in OrderRequestHeader/Comments", () => {
    expect(xml).toContain("<URL>cid:order-doc</URL>");
  });
  it("references the item-level attachment in the second ItemOut", () => {
    expect(xml).toContain("<URL>cid:item-doc</URL>");
    // Item-level cid must appear after the second SupplierPartID.
    const idxItem = xml.indexOf("cid:item-doc");
    const idxB = xml.indexOf("<SupplierPartID>B</SupplierPartID>");
    expect(idxItem).toBeGreaterThan(idxB);
  });
  it("emits an ItemOut per line with quantity", () => {
    expect(xml).toContain('<ItemOut quantity="1" lineNumber="1">');
    expect(xml).toContain('<ItemOut quantity="3" lineNumber="2">');
  });
});

describe("buildPunchOutOrderMessage", () => {
  it("computes the Total from line items", () => {
    const xml = buildPunchOutOrderMessage({
      from: supplier,
      to: buyer,
      sender: supplier,
      buyerCookie: "c1",
      payloadId: "p@h",
      timestamp: "2026-01-01T00:00:00.000Z",
      currency: "USD",
      items: [
        { quantity: 2, supplierPartId: "A", unitPriceAmount: 12.5, currency: "USD" },
        { quantity: 1, supplierPartId: "B", unitPriceAmount: 34, currency: "USD" },
      ],
    });
    expect(xml).toContain('<Money currency="USD">59.00</Money>');
    expect(xml).toContain("<BuyerCookie>c1</BuyerCookie>");
  });

  it("sends Total 0 when the cart mixes currencies (no fabricated cross-currency sum)", () => {
    const xml = buildPunchOutOrderMessage({
      from: supplier,
      to: buyer,
      sender: supplier,
      buyerCookie: "c1",
      payloadId: "p@h",
      timestamp: "2026-01-01T00:00:00.000Z",
      currency: "USD",
      items: [
        { quantity: 1, supplierPartId: "A", unitPriceAmount: 12.5, currency: "USD" },
        { quantity: 2, supplierPartId: "B", unitPriceAmount: 1.15, currency: "EUR" },
      ],
    });
    expect(xml).toContain('<Money currency="USD">0.00</Money>'); // header Total
    // line-level currencies are preserved
    expect(xml).toContain('<Money currency="EUR">1.15</Money>');
  });

  it("honors a custom operationAllowed and DTD version", () => {
    const xml = buildPunchOutOrderMessage({
      from: supplier, to: buyer, sender: supplier, buyerCookie: "c1",
      payloadId: "p@h", timestamp: "2026-01-01T00:00:00.000Z", currency: "USD",
      items: [], dtdVersion: "1.2.023", operationAllowed: "edit",
    });
    expect(xml).toContain("cXML/1.2.023/cXML.dtd");
    expect(xml).toContain('operationAllowed="edit"');
  });
});

describe("profile-driven cXML (version / UserAgent / operation / extrinsics)", () => {
  const base = {
    from: buyer, to: supplier, sender: buyer, sharedSecret: "s3cret",
    buyerCookie: "cookie-1", browserFormPostUrl: "http://localhost:8080/punchout/return",
    payloadId: "p@h", timestamp: "2026-01-01T00:00:00.000Z",
  };

  it("defaults to DTD 1.2.045 when no version is given (backward compatible)", () => {
    expect(buildSetupRequest(base)).toContain("cXML/1.2.045/cXML.dtd");
  });

  it("emits a per-document DTD version, UserAgent, operation and Extrinsic", () => {
    const xml = buildSetupRequest({
      ...base,
      dtdVersion: "1.2.014",
      userAgent: "Coupa Procurement",
      operation: "edit",
      extrinsics: [{ name: "User", value: "cookie-1" }],
    });
    expect(xml).toContain("cXML/1.2.014/cXML.dtd");
    expect(xml).toContain("<UserAgent>Coupa Procurement</UserAgent>");
    expect(xml).toContain('operation="edit"');
    expect(xml).toContain('<Extrinsic name="User">cookie-1</Extrinsic>');
  });
});

describe("applyExtrinsicTokens", () => {
  it("substitutes ${token} placeholders", () => {
    expect(applyExtrinsicTokens("u=${buyerCookie}", { buyerCookie: "abc" })).toBe("u=abc");
    expect(applyExtrinsicTokens("o=${orderId}", { orderId: "PO-9" })).toBe("o=PO-9");
    expect(applyExtrinsicTokens("none", {})).toBe("none");
  });
});
