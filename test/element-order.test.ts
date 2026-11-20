import { describe, expect, it } from "vitest";
import { buildOrderRequest, buildProfileRequest, buildSetupRequest } from "../src/server/cxml/build.js";
import { ELEMENT_ORDER } from "../src/server/cxml/element-order.js";
import { findOrderIssues } from "../src/server/cxml/order.js";
import { validateDocument } from "../src/server/cxml/validate.js";

// The DTD fixes the order of an element's children — "(From, To, Sender, …)" —
// and a receiver that validates against it rejects a document that breaks it.
// Many receivers do not validate, so the tool warns rather than rejects.

const cred = (domain: string, identity: string) => ({ domain, identity });
const TS = "2026-01-01T10:00:00+01:00";
const item = { quantity: 5, supplierPartId: "P1", description: "Widget", uom: "EA", unitPriceAmount: 10, currency: "USD", classifications: [{ domain: "UNSPSC", value: "31161500" }] };
const parties = { from: cred("DUNS", "123456789"), to: cred("DUNS", "987654321"), sender: cred("DUNS", "123456789"), sharedSecret: "demo-secret" };
const order = (items = [item]) =>
  buildOrderRequest({
    ...parties, orderId: "PO-1", orderDate: TS, payloadId: "p@h", timestamp: TS, currency: "USD", total: 50, items,
    shipTo: { name: "HQ", street: "1 Main", city: "X" }, billTo: { name: "HQ", street: "1 Main", city: "X" },
  });
/** Moves the first <tag>…</tag> block to just before the first <anchor …>. */
const moveBefore = (xml: string, tag: string, anchor: string): string => {
  const block = new RegExp(`[ \\t]*<${tag}[ >][\\s\\S]*?</${tag}>\\n`).exec(xml)![0];
  const rest = xml.replace(block, "");
  const at = rest.search(new RegExp(`[ \\t]*<${anchor}[ >]`));
  return rest.slice(0, at) + block + rest.slice(at);
};
const orderIssues = (xml: string) => validateDocument(xml).issues.filter((i) => i.code === "element-order");

describe("the order table", () => {
  it("carries the orders the DTD states for the documents the tool exchanges", () => {
    expect(ELEMENT_ORDER.Header).toBe("From,To,Sender,Path,OriginalDocument");
    expect(ELEMENT_ORDER.PunchOutSetupRequest).toBe("BuyerCookie,Extrinsic,BrowserFormPost,Contact,SupplierSetup,ShipTo,SelectedItem,ItemOut");
    expect(ELEMENT_ORDER.PunchOutOrderMessage).toBe("BuyerCookie,PunchOutOrderMessageHeader,ItemIn");
    expect(ELEMENT_ORDER.ItemID).toMatch(/^SupplierPartID,SupplierPartAuxiliaryID/);
  });

  it("gives the alternatives of a choice one position", () => {
    expect(ELEMENT_ORDER.cXML).toBe("Header|Response,Message|Request,ds:Signature");
    expect(ELEMENT_ORDER.ItemOut).toContain("ItemDetail|BlanketItemDetail");
  });

  it("has no entry for elements whose content the DTD does not order", () => {
    expect(ELEMENT_ORDER.Extrinsic).toBeUndefined(); // ANY
    expect(ELEMENT_ORDER.Money).toBeUndefined(); // text
  });
});

describe("documents the tool builds", () => {
  it("raise no order warning", () => {
    const withSchedule = { ...item, comments: "handle with care", scheduleLines: [{ quantity: 2, requestedDeliveryDate: "2030-01-10" }, { quantity: 3, requestedDeliveryDate: "2030-01-17" }] };
    const setup = buildSetupRequest({
      ...parties, buyerCookie: "c1", browserFormPostUrl: "http://localhost/return", payloadId: "p@h", timestamp: TS,
      operation: "edit", items: [item], selectedItem: { supplierPartId: "P1" },
      shipTo: { name: "HQ", street: "1 Main", city: "X" }, extrinsics: [{ name: "User", value: "jdoe" }],
    } as Parameters<typeof buildSetupRequest>[0]);
    const profile = buildProfileRequest({ ...parties, payloadId: "p@h", timestamp: TS } as Parameters<typeof buildProfileRequest>[0]);
    for (const xml of [order(), order([withSchedule, item]), setup, profile]) {
      expect(findOrderIssues(xml)).toEqual([]);
    }
  });
});

describe("a document with children out of order", () => {
  it("is warned about, not rejected", () => {
    const xml = moveBefore(order(), "BillTo", "ShipTo");
    const result = validateDocument(xml);
    const [issue] = orderIssues(xml);
    expect(issue.severity).toBe("warning");
    expect(issue.message).toContain("<ShipTo> comes after <BillTo> in <OrderRequestHeader>");
    expect(issue.path).toBe("cXML/Request/OrderRequest/OrderRequestHeader");
    expect(result.ok).toBe(true);
  });

  it("is told the order the DTD wants, for the children that are present", () => {
    const [issue] = findOrderIssues(moveBefore(order(), "To", "From"));
    expect(issue).toMatchObject({ parent: "Header", child: "From", before: "To", expected: ["From", "To", "Sender"] });
  });

  it("gets one warning per element, each in its own place", () => {
    const xml = moveBefore(moveBefore(order(), "To", "From"), "BillTo", "ShipTo");
    expect(orderIssues(xml).map((i) => i.path)).toEqual(["cXML/Header", "cXML/Request/OrderRequest/OrderRequestHeader"]);
  });

  it("names which of several repeated elements is affected", () => {
    const xml = order([item, { ...item, supplierPartId: "P2" }]);
    const second = xml.lastIndexOf("<ItemOut");
    const broken = xml.slice(0, second) + moveBefore(xml.slice(second), "ItemDetail", "ItemID");
    expect(findOrderIssues(broken).map((i) => i.path)).toEqual(["cXML/Request/OrderRequest/ItemOut[2]"]);
  });
});

describe("what is left alone", () => {
  it("repeated elements and elements the DTD does not know", () => {
    const xml = order([item, item, item]).replace("<ItemOut ", "<VendorNote>hello</VendorNote>\n<ItemOut ");
    expect(findOrderIssues(xml)).toEqual([]);
  });

  it("whatever an Extrinsic holds", () => {
    const inside = '<Extrinsic name="x"><Header><To/><From/></Header></Extrinsic>';
    const xml = order().replace("</OrderRequestHeader>", `${inside}</OrderRequestHeader>`);
    expect(findOrderIssues(xml)).toEqual([]);
  });

  it("a body that is not XML", () => {
    expect(findOrderIssues("Page not found")).toEqual([]);
  });
});
