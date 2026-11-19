import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { buildOrderRequest, buildPunchOutOrderMessage, buildResponseStatus, buildSetupRequest, buildSetupResponse, cxmlTimestamp, splitPhone } from "../src/server/cxml/build.js";
import { getHeaderCredentials, parseXml } from "../src/server/cxml/parse.js";
import { validateDocument, type ExpectedCredentials } from "../src/server/cxml/validate.js";
import { initConfig, updateSupplier, getSupplier } from "../src/server/store/config.js";
import { setDataDir } from "../src/server/store/paths.js";
import { setRuntime } from "../src/server/runtime.js";
import { seedDemoIfEmpty } from "../src/server/seed.js";

// Behaviour taken from the cXML 1.2.072 DTD and the cXML Reference Guide:
// change and cancel orders, cancelled punchout sessions, operationAllowed,
// multiple credentials per party, and the format rules.

const cred = (domain: string, identity: string) => ({ domain, identity });
const TS = "2026-01-01T10:00:00+01:00";
const codes = (xml: string, ctx = {}) => validateDocument(xml, ctx).issues.map((i) => i.code);
const severityOf = (xml: string, code: string, ctx = {}) =>
  validateDocument(xml, ctx).issues.find((i) => i.code === code)?.severity;

const item = { quantity: 2, supplierPartId: "P1", description: "Widget", uom: "EA", unitPriceAmount: 10, currency: "USD", classifications: [{ domain: "UNSPSC", value: "31161500" }] };
const orderBase = {
  from: cred("DUNS", "111"), to: cred("DUNS", "222"), sender: cred("DUNS", "111"), sharedSecret: "s",
  orderId: "PO-1", orderDate: TS, payloadId: "p2@h", timestamp: TS, currency: "USD", total: 20, items: [item],
  shipTo: { name: "HQ", street: "1 Main", city: "X" }, billTo: { name: "HQ", street: "1 Main", city: "X" },
};

describe("dates and times", () => {
  it("emits local time with a numeric UTC offset, never the Z designator", () => {
    expect(cxmlTimestamp()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(cxmlTimestamp(new Date("2026-03-05T04:05:06Z"))).not.toContain("Z");
    // Round-trips to the same instant.
    const d = new Date("2026-03-05T04:05:06Z");
    expect(new Date(cxmlTimestamp(d)).getTime()).toBe(d.getTime());
  });

  it("grades the timestamp: unparseable is an error, a missing zone or Z a warning", () => {
    const doc = (ts: string) => `<!DOCTYPE cXML SYSTEM "http://xml.cxml.org/schemas/cXML/1.2.045/cXML.dtd"><cXML payloadID="p@h" timestamp="${ts}" xml:lang="en"><Response><Status code="200" text="OK" xml:lang="en"/></Response></cXML>`;
    expect(severityOf(doc("yesterday"), "timestamp-format")).toBe("error");
    expect(severityOf(doc("2026-13-40T10:00:00+01:00"), "timestamp-format")).toBe("error");
    expect(severityOf(doc("2026-01-01T10:00:00"), "timestamp-no-timezone")).toBe("warning");
    expect(severityOf(doc("2026-01-01T10:00:00Z"), "timestamp-utc-designator")).toBe("warning");
    expect(validateDocument(doc("2026-01-01T10:00:00.250-08:00")).issues).toEqual([]);
  });

  it("applies the same rule to OrderRequestHeader/@orderDate", () => {
    const xml = buildOrderRequest({ ...orderBase, orderDate: "2026-01-01" });
    expect(severityOf(xml, "orderdate-format")).toBe("error");
  });
});

describe("DOCTYPE and xml:lang", () => {
  const body = `<cXML payloadID="p@h" timestamp="${TS}" xml:lang="en"><Response><Status code="200" text="OK" xml:lang="en"/></Response></cXML>`;
  it("warns when the DOCTYPE is missing or does not name a cXML DTD", () => {
    expect(codes(body)).toContain("missing-doctype");
    expect(codes(`<!DOCTYPE cXML SYSTEM "http://example.com/my.dtd">${body}`)).toContain("doctype-unrecognized");
    expect(codes(`<!DOCTYPE cXML SYSTEM "http://xml.cxml.org/schemas/cXML/1.2.014/cXML.dtd">${body}`)).not.toContain("missing-doctype");
  });
  it("notes a DTD version other than the one the platform profile uses", () => {
    const xml = `<!DOCTYPE cXML SYSTEM "http://xml.cxml.org/schemas/cXML/1.2.014/cXML.dtd">${body}`;
    expect(severityOf(xml, "dtd-version-differs", { expectedDtdVersion: "1.2.045" })).toBe("info");
    expect(codes(xml, { expectedDtdVersion: "1.2.014" })).not.toContain("dtd-version-differs");
  });
  it("requires xml:lang on Description and Name, and only recommends it elsewhere", () => {
    const xml = buildOrderRequest(orderBase).replace(/ xml:lang="en"/g, "");
    expect(severityOf(xml, "description-missing-xml-lang")).toBe("error");
    expect(severityOf(xml, "name-missing-xml-lang")).toBe("error");
    const noRoot = buildOrderRequest(orderBase).replace(' xml:lang="en-US"', "");
    expect(severityOf(noRoot, "xml-lang-recommended")).toBe("info");
    expect(validateDocument(noRoot).ok).toBe(true);
  });
});

describe("the tool's own documents follow the DTD's structure", () => {
  it("orders the PunchOutSetupRequest children: BuyerCookie, Extrinsic*, BrowserFormPost, Contact*, ShipTo, ItemOut*", () => {
    const xml = buildSetupRequest({
      from: cred("DUNS", "1"), to: cred("DUNS", "2"), sender: cred("DUNS", "1"), buyerCookie: "c", browserFormPostUrl: "http://b/r",
      payloadId: "p@h", timestamp: TS, operation: "edit", extrinsics: [{ name: "U", value: "jo" }],
      shipTo: { name: "HQ", street: "1 Main", city: "X" }, contact: { role: "endUser", name: "Jo" }, items: [item],
    });
    const order = ["<BuyerCookie>", "<Extrinsic ", "<BrowserFormPost>", "<Contact ", "<ShipTo>", "<ItemOut "].map((t) => xml.indexOf(t));
    expect(order.every((p) => p > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("puts item-level Comments in ItemOut after ItemDetail, not inside it", () => {
    const xml = buildOrderRequest({ ...orderBase, attachments: [{ contentId: "a@x", scope: { itemIndex: 1 } }] });
    expect(xml.indexOf("</ItemDetail>")).toBeLessThan(xml.indexOf("<Comments"));
    expect(xml.indexOf("<Comments")).toBeLessThan(xml.indexOf("</ItemOut>"));
  });
  it("sends responses without a Header", () => {
    expect(buildSetupResponse({ payloadId: "p@h", timestamp: TS, startPageUrl: "http://s/c" })).not.toContain("<Header>");
    expect(buildResponseStatus({ payloadId: "p@h", timestamp: TS })).not.toContain("<Header>");
  });
  it("splits a phone number into country code, area code and number", () => {
    expect(splitPhone("+48 12 345 67 89")).toEqual({ countryCode: "48", areaCode: "12", number: "3456789" });
    expect(splitPhone("+1 (415) 555-0100")).toEqual({ countryCode: "1", areaCode: "415", number: "5550100" });
    expect(splitPhone("555 0100")).toEqual({ countryCode: "", areaCode: "", number: "555 0100" });
  });
});

describe("change and cancel orders", () => {
  it("builds an update with orderVersion and a DocumentReference before the Extrinsics", () => {
    const xml = buildOrderRequest({ ...orderBase, type: "update", orderVersion: 2, documentReferencePayloadId: "p1@h", extrinsics: [{ name: "X", value: "y" }] });
    expect(xml).toContain('type="update" orderVersion="2"');
    expect(xml).toContain('<DocumentReference payloadID="p1@h"/>');
    expect(xml.indexOf("<DocumentReference")).toBeLessThan(xml.indexOf("<Extrinsic"));
    expect(validateDocument(xml, { priorOrder: { payloadId: "p1@h", orderVersion: 1 } }).issues.filter((i) => i.severity !== "info")).toEqual([]);
  });
  it("rejects an update or delete without a DocumentReference, and an unknown type", () => {
    expect(severityOf(buildOrderRequest({ ...orderBase, type: "delete", orderVersion: 2 }), "order-missing-documentreference")).toBe("error");
    expect(severityOf(buildOrderRequest(orderBase).replace('type="new"', 'type="amend"'), "order-invalid-type")).toBe("error");
  });
  it("warns when the reference is stale, the version does not rise, or there is no order to change", () => {
    const xml = buildOrderRequest({ ...orderBase, type: "update", orderVersion: 2, documentReferencePayloadId: "old@h" });
    expect(codes(xml, { priorOrder: { payloadId: "newer@h", orderVersion: 2 } })).toEqual(
      expect.arrayContaining(["order-documentreference-stale", "order-version"]),
    );
    expect(codes(xml, { priorOrder: null })).toContain("order-no-prior");
  });
});

describe("multiple credentials per party", () => {
  const expected: ExpectedCredentials = { from: cred("DUNS", "111"), to: cred("DUNS", "222"), sender: cred("DUNS", "111"), sharedSecret: "s" };
  const withFrom = (creds: string) =>
    buildOrderRequest(orderBase).replace(/<From>[\s\S]*?<\/From>/, `<From>${creds}</From>`);
  const c = (domain: string, id: string) => `<Credential domain="${domain}"><Identity>${id}</Identity></Credential>`;

  it("reads every credential and finds the shared secret on whichever carries it", () => {
    const xml = buildOrderRequest(orderBase).replace(
      /<Sender>[\s\S]*?<UserAgent>/,
      `<Sender>${c("NetworkID", "AN01")}<Credential domain="DUNS"><Identity>111</Identity><SharedSecret>s</SharedSecret></Credential><UserAgent>`,
    );
    const creds = getHeaderCredentials(parseXml(xml));
    expect(creds.senderAll).toEqual([cred("NetworkID", "AN01"), cred("DUNS", "111")]);
    expect(creds.sharedSecret).toBe("s");
  });
  it("accepts a party whose known-domain credential matches, whatever else it sends", () => {
    expect(codes(withFrom(c("NetworkID", "AN01") + c("DUNS", "111")), { expected })).not.toContain("credential-mismatch");
  });
  it("flags a credential in a known domain that does not match", () => {
    expect(codes(withFrom(c("NetworkID", "AN01") + c("DUNS", "999")), { expected })).toContain("credential-mismatch");
  });
  it("rejects two credentials of the same domain with different identities", () => {
    expect(severityOf(withFrom(c("DUNS", "111") + c("DUNS", "112")), "credential-domain-conflict", { expected })).toBe("error");
  });
});

describe("punchback: operationAllowed, cancelled sessions", () => {
  const pomBase = { from: cred("DUNS", "222"), to: cred("DUNS", "111"), sender: cred("DUNS", "222"), buyerCookie: "c", payloadId: "p@h", timestamp: TS, currency: "USD" };
  it("requires a valid operationAllowed", () => {
    const xml = buildPunchOutOrderMessage({ ...pomBase, items: [item], operationAllowed: "edit" });
    expect(validateDocument(xml).ok).toBe(true);
    expect(severityOf(xml.replace(' operationAllowed="edit"', ""), "pom-invalid-operationallowed")).toBe("error");
    expect(severityOf(xml.replace('operationAllowed="edit"', 'operationAllowed="all"'), "pom-invalid-operationallowed")).toBe("error");
  });
  it("treats an empty cart as valid and explains what it means for the session", () => {
    const empty = buildPunchOutOrderMessage({ ...pomBase, items: [], operationAllowed: "edit" });
    const cancelled = buildPunchOutOrderMessage({ ...pomBase, items: [], operationAllowed: "edit", status: { code: "204", text: "No Content" } });
    expect(cancelled).toContain('<Status code="204" text="No Content"');
    const msg = (xml: string, op: string) => validateDocument(xml, { setupOperation: op }).issues.find((i) => i.code === "empty-cart");
    expect(msg(empty, "create")?.severity).toBe("info");
    expect(msg(empty, "create")?.message).toContain("cancelled");
    expect(msg(empty, "edit")?.message).toContain("deleted");
    expect(msg(cancelled, "edit")?.message).toContain("keeps its items");
    expect(validateDocument(empty, { setupOperation: "create" }).ok).toBe(true);
  });
  it("warns about items on an inspect session or beside a 204, and about a secret in a Message", () => {
    const full = buildPunchOutOrderMessage({ ...pomBase, items: [item], operationAllowed: "edit" });
    expect(codes(full, { setupOperation: "inspect" })).toContain("inspect-returned-items");
    const with204 = buildPunchOutOrderMessage({ ...pomBase, items: [item], operationAllowed: "edit", status: { code: "204", text: "No Content" } });
    expect(codes(with204)).toContain("status-204-with-items");
    const withSecret = full.replace("</Identity>\n      </Credential>\n      <UserAgent>", "</Identity>\n        <SharedSecret>s</SharedSecret>\n      </Credential>\n      <UserAgent>");
    expect(codes(withSecret)).toContain("sharedsecret-in-message");
  });
});

describe("mock supplier and buyer, end to end (in-process)", () => {
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    setDataDir(mkdtempSync(join(tmpdir(), "pos-std-")));
    setRuntime({ port: 0, publicUrl: "http://localhost:8080", token: undefined });
    await initConfig();
    await seedDemoIfEmpty();
    app = createApp({ quiet: true });
  });
  const form = (path: string, fields: Record<string, string>) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const punchbackOf = (html: string) => decode(/name="cxml-urlencoded" value="([\s\S]*?)">/.exec(html)![1]);
  // The mock supplier answers a SetupRequest sent to it directly (no HTTP hop in-process).
  const openSession = async (cookie: string, operation = "create", items = "") => {
    await app.request("/sim/demo-supplier/punchout", {
      method: "POST",
      headers: { "content-type": "text/xml" },
      body: `<cXML payloadID="s-${cookie}@h" timestamp="${TS}"><Header>
        <From><Credential domain="NetworkID"><Identity>AN-BUYER</Identity></Credential><Credential domain="DUNS"><Identity>123456789</Identity></Credential></From>
        <To><Credential domain="DUNS"><Identity>987654321</Identity></Credential></To>
        <Sender><Credential domain="DUNS"><Identity>123456789</Identity><SharedSecret>demo-secret</SharedSecret></Credential><UserAgent>t</UserAgent></Sender>
        </Header><Request><PunchOutSetupRequest operation="${operation}"><BuyerCookie>${cookie}</BuyerCookie>
        <BrowserFormPost><URL>http://localhost:8080/punchout/return</URL></BrowserFormPost>${items}</PunchOutSetupRequest></Request></cXML>`,
    });
  };
  const returnCart = (xml: string) => form("/punchout/return", { "cxml-urlencoded": xml });
  const cartOf = (cookie: string) => app.request(`/api/cart/${cookie}`).then((r) => r.json() as Promise<any>);
  const itemOut = `<ItemOut quantity="3" lineNumber="1"><ItemID><SupplierPartID>WIDGET-001</SupplierPartID><SupplierPartAuxiliaryID>WIDGET-001-STD</SupplierPartAuxiliaryID></ItemID><ItemDetail><UnitPrice><Money currency="USD">12.50</Money></UnitPrice><Description xml:lang="en">Premium Steel Widget</Description><UnitOfMeasure>EA</UnitOfMeasure><Classification domain="UNSPSC">31161500</Classification></ItemDetail></ItemOut>`;

  it("matches the connection on the buyer's second credential and replies to it", async () => {
    await openSession("mc-1");
    const log = await app.request("/api/sessions/mc-1").then((r) => r.json() as Promise<any[]>);
    const setup = log.find((r) => r.docType === "SetupRequest");
    expect(setup.validation.issues.map((i: any) => i.code)).not.toContain("credential-mismatch");
    const html = await form("/sim/demo-supplier/checkout", { cookie: "mc-1", q_0: "1" }).then((r) => r.text());
    // The punchback addresses the buyer by the identity the connection knows.
    expect(punchbackOf(html)).toMatch(/<To>\s*<Credential domain="DUNS">\s*<Identity>123456789<\/Identity>/);
  });

  it("Cancel ends a create session with an empty cart and Status 204", async () => {
    await openSession("cancel-1");
    const catalog = await app.request("/sim/demo-supplier/catalog?cookie=cancel-1").then((r) => r.text());
    expect(catalog).toContain('name="action" value="cancel"');
    const xml = punchbackOf(await form("/sim/demo-supplier/checkout", { cookie: "cancel-1", action: "cancel", q_0: "5" }).then((r) => r.text()));
    expect(xml).toContain('<Status code="204" text="No Content"');
    expect(xml).not.toContain("<ItemIn");
    await returnCart(xml);
    const cart = await cartOf("cancel-1");
    expect(cart.outcome).toBe("cancelled");
    expect(cart.items).toEqual([]);
  });

  it("reads an empty edit cart as 'delete the items' and a 204 as 'leave them'", async () => {
    await openSession("edit-empty", "edit", itemOut);
    await returnCart(punchbackOf(await form("/sim/demo-supplier/checkout", { cookie: "edit-empty", q_0: "0" }).then((r) => r.text())));
    expect((await cartOf("edit-empty")).outcome).toBe("emptied");
    expect((await cartOf("edit-empty")).items).toEqual([]);

    await openSession("edit-204", "edit", itemOut);
    await returnCart(punchbackOf(await form("/sim/demo-supplier/checkout", { cookie: "edit-204", action: "cancel" }).then((r) => r.text())));
    const kept = await cartOf("edit-204");
    expect(kept.outcome).toBe("unchanged");
    expect(kept.items).toHaveLength(1);
    expect(kept.items[0].quantity).toBe(3);
  });

  it("returns carts with the supplier's configured operationAllowed (edit by default)", async () => {
    await openSession("oa-1");
    const dflt = punchbackOf(await form("/sim/demo-supplier/checkout", { cookie: "oa-1", q_0: "1" }).then((r) => r.text()));
    expect(dflt).toContain('operationAllowed="edit"');

    const s = getSupplier("demo-supplier")!;
    await updateSupplier("demo-supplier", { ...s, operationAllowed: "create" });
    await openSession("oa-2");
    const limited = punchbackOf(await form("/sim/demo-supplier/checkout", { cookie: "oa-2", q_0: "1" }).then((r) => r.text()));
    expect(limited).toContain('operationAllowed="create"');
    // A later edit against that supplier is flagged: it never permitted one.
    await openSession("oa-3", "edit", itemOut);
    const log = await app.request("/api/sessions/oa-3").then((r) => r.json() as Promise<any[]>);
    expect(log[0].validation.issues.map((i: any) => i.code)).toContain("setup-operation-not-allowed");
    await updateSupplier("demo-supplier", { ...s, operationAllowed: undefined });
  });

  it("a supplier accepts a change order and a cancellation that reference the previous document", async () => {
    const order = (payloadId: string, attrs: string, docRef = "") =>
      app.request("/sim/demo-supplier/order", {
        method: "POST",
        headers: { "content-type": "text/xml" },
        body: buildOrderRequest({ ...orderBase, from: cred("DUNS", "123456789"), to: cred("DUNS", "987654321"), sender: cred("DUNS", "123456789"), sharedSecret: "demo-secret", orderId: "PO-CHG", payloadId })
          .replace('type="new"', attrs)
          .replace("</OrderRequestHeader>", `${docRef}</OrderRequestHeader>`),
      });
    const first = await order("o1@h", 'type="new"');
    expect(first.status).toBe(200);
    const so = /Order number (SO-[A-Z0-9]{8}) received/.exec(await first.text())![1];

    const change = await order("o2@h", 'type="update" orderVersion="2"', '<DocumentReference payloadID="o1@h"/>');
    expect(change.status).toBe(200);
    expect(await change.text()).toContain(`Order number ${so} updated to version 2 for PO PO-CHG`);

    const cancel = await order("o3@h", 'type="delete" orderVersion="3"', '<DocumentReference payloadID="o2@h"/>');
    expect(await cancel.text()).toContain(`Order number ${so} cancelled for PO PO-CHG`);

    // No DocumentReference: rejected, as the standard requires one.
    const bad = await order("o4@h", 'type="update" orderVersion="4"');
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("DocumentReference");

    // A stale reference is accepted but recorded as a warning.
    await order("o5@h", 'type="update" orderVersion="4"', '<DocumentReference payloadID="o1@h"/>');
    const log = await app.request("/api/sessions/order-PO-CHG").then((r) => r.json() as Promise<any[]>);
    const last = log.filter((r) => r.docType === "OrderRequest").at(-1);
    expect(last.validation.issues.map((i: any) => i.code)).toContain("order-documentreference-stale");
  });

  it("the buyer side refuses to build a change for a session that sent no order", async () => {
    const none = await app.request("/api/connections/demo/order/preview", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "buyer-chg", items: [item], orderType: "update" }),
    });
    expect(none.status).toBe(400);
    expect((await none.json()).error).toContain("no order to change");
  });
});
