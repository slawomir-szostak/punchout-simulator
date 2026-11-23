import { describe, expect, it } from "vitest";
import { buildOrderRequest } from "../src/server/cxml/build.js";
import { currencySuggestion, isCurrency, unitStatus } from "../src/server/cxml/codes.js";
import { PRODUCT_LIST_PRESETS } from "../src/server/cxml/product-list-presets.js";
import { validateDocument } from "../src/server/cxml/validate.js";

// cXML takes its units and currencies from two code lists. UnitOfMeasure "must
// conform with UN/CEFACT (Recommendation 20) Unit of Measure Common Codes"; a
// currency "must be a three-letter ISO 4217 currency code".

const cred = (domain: string, identity: string) => ({ domain, identity });
const TS = "2026-01-01T10:00:00+01:00";
const item = { quantity: 5, supplierPartId: "P1", description: "Widget", uom: "EA", unitPriceAmount: 10, currency: "USD", classifications: [{ domain: "UNSPSC", value: "31161500" }] };
const order = (over: Partial<typeof item> = {}, n = 1) =>
  buildOrderRequest({
    from: cred("DUNS", "123456789"), to: cred("DUNS", "987654321"), sender: cred("DUNS", "123456789"), sharedSecret: "demo-secret",
    orderId: "PO-1", orderDate: TS, payloadId: "p@h", timestamp: TS, currency: over.currency ?? "USD", total: 50 * n,
    items: Array.from({ length: n }, () => ({ ...item, ...over })),
    shipTo: { name: "HQ", street: "1 Main", city: "X" }, billTo: { name: "HQ", street: "1 Main", city: "X" },
  });
const found = (xml: string, code: string) => validateDocument(xml).issues.filter((i) => i.code === code);

describe("units of measure", () => {
  it("knows the Recommendation 20 codes in use", () => {
    for (const code of ["EA", "KGM", "LTR", "MTR", "HUR", "C62", "H87", "SET", "PR", "DZN"]) expect(unitStatus(code)).toEqual({ kind: "ok" });
  });

  it("takes a Recommendation 21 package code with its X prefix", () => {
    for (const code of ["XBX", "XPK", "XCT", "XBG"]) expect(unitStatus(code)).toEqual({ kind: "ok" });
  });

  it("tells a withdrawn code from an unknown one, and names its replacement", () => {
    expect(unitStatus("BX")).toEqual({ kind: "withdrawn", replacement: "XBX" });
    expect(unitStatus("PK")).toEqual({ kind: "withdrawn", replacement: "XPK" });
    expect(unitStatus("EACH")).toEqual({ kind: "unknown", suggestion: undefined });
    expect(unitStatus("PCE")).toEqual({ kind: "unknown", suggestion: undefined });
  });

  it("suggests the upper-case code when only the case is off", () => {
    expect(unitStatus("ea")).toEqual({ kind: "unknown", suggestion: "EA" });
  });
});

describe("currencies", () => {
  it("knows the ISO 4217 codes in use, and no others", () => {
    for (const code of ["USD", "EUR", "PLN", "GBP", "JPY", "CHF"]) expect(isCurrency(code)).toBe(true);
    for (const code of ["usd", "US$", "EURO", "XXZ", "DEM"]) expect(isCurrency(code)).toBe(false);
    expect(currencySuggestion("usd")).toBe("USD");
    expect(currencySuggestion("DEM")).toBeUndefined();
  });
});

describe("in a document", () => {
  it("nothing is said about codes that are on the lists", () => {
    const issues = validateDocument(order()).issues.map((i) => i.code);
    expect(issues.filter((c) => /^(uom|currency)-/.test(c))).toEqual([]);
  });

  it("an unknown unit is a warning, and the order is still acceptable", () => {
    const xml = order({ uom: "EACH" });
    const [issue] = found(xml, "uom-unknown");
    expect(issue.severity).toBe("warning");
    expect(issue.message).toContain('UnitOfMeasure "EACH" is not a UN/CEFACT unit of measure common code');
    expect(validateDocument(xml).ok).toBe(true);
  });

  it("a withdrawn unit is a note that names the current code", () => {
    const [issue] = found(order({ uom: "BX" }), "uom-withdrawn");
    expect(issue.severity).toBe("info");
    expect(issue.message).toContain('the current code is "XBX"');
  });

  it("an unknown currency is a warning, with the upper-case code when that is all it takes", () => {
    const [issue] = found(order({ currency: "usd" }), "currency-unknown");
    expect(issue.severity).toBe("warning");
    expect(issue.message).toContain('currency "usd" is not an ISO 4217 currency code — the codes are upper case: "USD"');
  });

  it("each code is reported once, with how often it is used", () => {
    const issues = found(order({ uom: "EACH" }, 3), "uom-unknown");
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("(used 3 times)");
  });

  it("what an Extrinsic holds is not checked", () => {
    const xml = order().replace("</OrderRequestHeader>", '<Extrinsic name="x"><UnitOfMeasure>whatever</UnitOfMeasure></Extrinsic></OrderRequestHeader>');
    expect(found(xml, "uom-unknown")).toEqual([]);
  });
});

describe("the tool's own catalogs", () => {
  it("use only units and currencies that are on the lists", () => {
    const products = PRODUCT_LIST_PRESETS.flatMap((p: { items: { uom: string; currency: string }[] }) => p.items);
    expect(products.length).toBeGreaterThan(5);
    for (const p of products) {
      expect(unitStatus(p.uom), p.uom).toEqual({ kind: "ok" });
      expect(isCurrency(p.currency), p.currency).toBe(true);
    }
  });
});
