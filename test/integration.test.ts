import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { initConfig } from "../src/server/store/config.js";
import { setDataDir } from "../src/server/store/paths.js";
import { setRuntime } from "../src/server/runtime.js";
import { seedDemoIfEmpty } from "../src/server/seed.js";

// Full Mode A roundtrip against the built-in mock supplier, over real HTTP
// (the flow uses fetch() to reach the supplier endpoints).

let base = "";
let server: ReturnType<typeof serve>;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "pos-it-"));
  setDataDir(dir);
  await initConfig();

  await new Promise<void>((resolve) => {
    const app = createApp({ quiet: true });
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      base = `http://localhost:${info.port}`;
      setRuntime({ port: info.port, publicUrl: base });
      resolve();
    });
  });
  await seedDemoIfEmpty();
});

afterAll(() => {
  server?.close();
});

function decodeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

describe("Mode A loopback", () => {
  it("seeds a demo buyer, supplier, and connection", async () => {
    const conns = await fetch(`${base}/api/connections`).then((r) => r.json());
    expect(conns).toHaveLength(1);
    expect(conns[0].buyer?.name).toBe("Demo Buyer");
    expect(conns[0].supplier?.name).toContain("Demo Supplier");
    const buyers = await fetch(`${base}/api/buyers`).then((r) => r.json());
    const suppliers = await fetch(`${base}/api/suppliers`).then((r) => r.json());
    expect(buyers).toHaveLength(1);
    expect(suppliers).toHaveLength(1);
    // The shared secret is write-only over the API: masked on read, presence flagged.
    expect(conns[0].sharedSecret).toBe("");
    expect(conns[0].hasSharedSecret).toBe(true);
  });

  it("runs setup -> browse -> punchback -> order", async () => {
    // SetupRequest
    const setup = await fetch(`${base}/api/connections/demo/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then((r) => r.json());
    expect(setup.statusCode).toBe("200");
    expect(setup.request.validation.ok).toBe(true);
    expect(setup.response.validation.ok).toBe(true);
    expect(setup.startPage).toBeTruthy();
    // The logged request body must not leak the shared secret.
    expect(setup.request.body).not.toContain("demo-secret");
    expect(setup.request.body).toContain("<SharedSecret>***</SharedSecret>");

    const cookie = setup.buyerCookie;
    const formpost = new URL(setup.startPage).searchParams.get("formpost")!;

    // Checkout -> punchback, then submit to the callback as the browser would
    const form = new URLSearchParams({ cookie, formpost, bd: "DUNS", bi: "123456789", q_0: "2", q_1: "1" });
    const checkoutHtml = await fetch(`${base}/sim/demo-supplier/checkout`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }).then((r) => r.text());
    const m = /name="cxml-urlencoded" value="([\s\S]*?)">/.exec(checkoutHtml)!;
    const punchbackXml = decodeHtml(m[1]);
    await fetch(`${base}/punchout/return`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ "cxml-urlencoded": punchbackXml }).toString(),
    });

    // Cart
    const cart = await fetch(`${base}/api/cart/${encodeURIComponent(cookie)}`).then((r) => r.json());
    expect(cart.items).toHaveLength(2);
    expect(cart.total.amount).toBeCloseTo(12.5 * 2 + 34, 2);

    // OrderRequest (happy path)
    const order = await fetch(`${base}/api/connections/demo/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: cookie, items: cart.items, currency: cart.total.currency }),
    }).then((r) => r.json());
    expect(order.statusCode).toBe("200");
    expect(order.request.validation.ok).toBe(true);
  });

  it("happy-path attachment resolves its cid", async () => {
    const res = await fetch(`${base}/api/connections/demo/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "att-ok",
        items: [{ quantity: 1, supplierPartId: "A", unitPriceAmount: 1, currency: "USD", description: "x", uom: "EA", classification: "1", classificationDomain: "UNSPSC" }],
        currency: "USD",
        attachments: [{ contentId: "doc", filename: "d.txt", contentType: "text/plain", dataBase64: Buffer.from("hi").toString("base64"), scope: "order" }],
      }),
    }).then((r) => r.json());
    const c = res.request.validation.issues.map((i: any) => i.code);
    expect(c).not.toContain("dangling-cid");
    expect(res.statusCode).toBe("200");
  });

  const twoItems = [
    { quantity: 1, supplierPartId: "AAA", unitPriceAmount: 10, currency: "USD", description: "a", uom: "EA", classification: "1", classificationDomain: "UNSPSC" },
    { quantity: 2, supplierPartId: "BBB", unitPriceAmount: 5, currency: "USD", description: "b", uom: "EA", classification: "2", classificationDomain: "UNSPSC" },
  ];

  it("order/preview places an item-level attachment cid in the right ItemOut", async () => {
    const preview = await fetch(`${base}/api/connections/demo/order/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: twoItems,
        currency: "USD",
        attachments: [{ contentId: "item-doc", scope: 2 }],
      }),
    }).then((r) => r.json());
    expect(preview.xml).toContain("cid:item-doc");
    // The cid must appear after the second item's SupplierPartID, not the first.
    expect(preview.xml.indexOf("cid:item-doc")).toBeGreaterThan(
      preview.xml.indexOf("<SupplierPartID>BBB</SupplierPartID>"),
    );
  });

  it("item-level attachment resolves; item-level dangling cid is detected", async () => {
    const ok = await fetch(`${base}/api/connections/demo/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "item-att-ok",
        items: twoItems,
        currency: "USD",
        attachments: [{ contentId: "item-doc", scope: 2, contentType: "text/plain", dataBase64: Buffer.from("x").toString("base64") }],
      }),
    }).then((r) => r.json());
    expect(ok.request.validation.issues.map((i: any) => i.code)).not.toContain("dangling-cid");

    const bad = await fetch(`${base}/api/connections/demo/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "item-att-bad",
        items: twoItems,
        currency: "USD",
        danglingCid: true,
        attachments: [{ contentId: "item-doc", scope: 2, contentType: "text/plain", dataBase64: Buffer.from("x").toString("base64") }],
      }),
    }).then((r) => r.json());
    expect(bad.request.validation.issues.map((i: any) => i.code)).toContain("dangling-cid");
    expect(bad.statusCode).toBe("400");
  });

  it("rejects a cookie-less checkout without minting a phantom session", async () => {
    const before = (await fetch(`${base}/api/sessions`).then((r) => r.json())).length;
    const res = await fetch(`${base}/sim/demo-supplier/checkout`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "",
    });
    expect(res.status).toBe(400);
    const after = (await fetch(`${base}/api/sessions`).then((r) => r.json())).length;
    expect(after).toBe(before);
  });

  it("deletes a session (log file + list entry)", async () => {
    await fetch(`${base}/api/connections/demo/setup`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ buyerCookie: "del-me-1" }),
    });
    const before = await fetch(`${base}/api/sessions`).then((r) => r.json());
    expect(before.some((s: any) => s.sessionId === "del-me-1")).toBe(true);

    const del = await fetch(`${base}/api/sessions/del-me-1`, { method: "DELETE" });
    expect(del.status).toBe(200);

    const after = await fetch(`${base}/api/sessions`).then((r) => r.json());
    expect(after.some((s: any) => s.sessionId === "del-me-1")).toBe(false);
    expect((await fetch(`${base}/api/sessions/missing-xyz`, { method: "DELETE" })).status).toBe(404);
  });

  it("validates a request on demand without sending it", async () => {
    const preview = await fetch(`${base}/api/connections/demo/setup/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.json());
    const good = await fetch(`${base}/api/connections/demo/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docType: "SetupRequest", xml: preview.xml }),
    }).then((r) => r.json());
    expect(good.docType).toBe("SetupRequest");
    expect(good.ok).toBe(true);

    const bad = await fetch(`${base}/api/connections/demo/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docType: "SetupRequest", xml: "<cXML timestamp=\"t\"><Request><PunchOutSetupRequest operation=\"create\"><BuyerCookie>x</BuyerCookie></PunchOutSetupRequest></Request></cXML>" }),
    }).then((r) => r.json());
    expect(bad.ok).toBe(false);
    expect(bad.issues.map((i: any) => i.code)).toContain("missing-payloadID");
  });

  it("sends an edited OrderRequest cXML verbatim (retry path)", async () => {
    const preview = await fetch(`${base}/api/connections/demo/order/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: twoItems, currency: "USD" }),
    }).then((r) => r.json());
    const edited = preview.xml.replace("</OrderRequest>", "<!-- edited by user --></OrderRequest>");
    const res = await fetch(`${base}/api/connections/demo/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "edited-1", xml: edited, items: twoItems, currency: "USD" }),
    }).then((r) => r.json());
    expect(res.request.body).toContain("edited by user");
    expect(res.statusCode).toBe("200");
  });

  it("rejects a non-http(s) BrowserFormPost URL (no javascript: XSS)", async () => {
    const setupXml = `<cXML payloadID="p@h" timestamp="t"><Header>
      <From><Credential domain="DUNS"><Identity>123456789</Identity></Credential></From>
      <To><Credential domain="DUNS"><Identity>987654321</Identity></Credential></To>
      <Sender><Credential domain="DUNS"><Identity>123456789</Identity><SharedSecret>demo-secret</SharedSecret></Credential></Sender>
      </Header><Request><PunchOutSetupRequest operation="create">
        <BuyerCookie>evil-1</BuyerCookie>
        <BrowserFormPost><URL>javascript:alert(document.cookie)</URL></BrowserFormPost>
      </PunchOutSetupRequest></Request></cXML>`;
    const respXml = await fetch(`${base}/sim/demo-supplier/punchout`, {
      method: "POST",
      headers: { "content-type": "text/xml" },
      body: setupXml,
    }).then((r) => r.text());
    const startPage = decodeHtml(/<URL>([\s\S]*?)<\/URL>/.exec(respXml)![1]);
    const formpost = new URL(startPage).searchParams.get("formpost");
    expect(formpost).toBe(""); // dropped, not the javascript: URL

    // And the checkout page must never render a javascript: action.
    const checkoutHtml = await fetch(`${base}/sim/demo-supplier/checkout`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ cookie: "x", formpost: "javascript:alert(1)", q_0: "1" }).toString(),
    }).then((r) => r.text());
    expect(checkoutHtml).not.toContain("javascript:");
  });

  it("base64 connection: supplier accepts the order and the raw view shows the encoded envelope", async () => {
    // A connection that sends attachments as Content-Transfer-Encoding: base64.
    const conn = await fetch(`${base}/api/connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "B64 Buyer → Supplier",
        buyerId: "demo-buyer",
        supplierId: "demo-supplier",
        mode: "virtual-buyer",
        sharedSecret: "demo-secret",
        attachmentEncoding: "base64",
      }),
    }).then((r) => r.json());
    expect(conn.attachmentEncoding).toBe("base64");

    const res = await fetch(`${base}/api/connections/${conn.id}/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "b64-1",
        items: [{ quantity: 1, supplierPartId: "A", unitPriceAmount: 1, currency: "USD", description: "x", uom: "EA", classification: "1", classificationDomain: "UNSPSC" }],
        currency: "USD",
        attachments: [{ contentId: "doc", filename: "d.txt", contentType: "text/plain", dataBase64: Buffer.from("hello base64").toString("base64"), scope: "order" }],
      }),
    }).then((r) => r.json());

    // The supplier (Mode B) must decode the base64 part, resolve the cid, accept.
    expect(res.request.validation.issues.map((i: any) => i.code)).not.toContain("dangling-cid");
    expect(res.statusCode).toBe("200");
    expect(res.request.attachmentEncoding).toBe("base64");

    // The raw view reconstructs the base64-encoded multipart envelope.
    const raw = await fetch(
      `${base}/api/sessions/${encodeURIComponent("b64-1")}/records/${res.request.id}/raw`,
    ).then((r) => r.text());
    expect(raw).toContain("multipart/related");
    expect(raw).toContain("Content-Transfer-Encoding: base64");
    expect(raw).toContain(Buffer.from("hello base64").toString("base64"));
    expect(raw).toContain("cid:doc"); // the XML still references the attachment
  });

  it("emits the buyer's platform profile cXML (Coupa demo buyer: DTD 1.2.014 + UserAgent)", async () => {
    const setup = await fetch(`${base}/api/connections/demo/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then((r) => r.json());
    expect(setup.request.body).toContain("cXML/1.2.014/cXML.dtd");
    expect(setup.request.body).toContain("<UserAgent>Coupa Procurement</UserAgent>");
  });

  it("returns the cart using the buyer profile's transport (base64 for an SAP profile)", async () => {
    // A buyer on the sap-srm preset (cartReturnTransport: cxml-base64) wired to the demo supplier.
    const buyer = await fetch(`${base}/api/buyers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "SAP Buyer", identity: { domain: "DUNS", identity: "55555" }, profileId: "sap-srm" }),
    }).then((r) => r.json());
    await fetch(`${base}/api/connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ buyerId: buyer.id, supplierId: "demo-supplier", mode: "virtual-buyer", sharedSecret: "demo-secret" }),
    });

    const checkoutHtml = await fetch(`${base}/sim/demo-supplier/checkout`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ cookie: "sap-1", formpost: `${base}/punchout/return`, bd: "DUNS", bi: "55555", q_0: "1" }).toString(),
    }).then((r) => r.text());
    expect(checkoutHtml).toContain('name="cxml-base64"');
    expect(checkoutHtml).not.toContain('name="cxml-urlencoded"');
  });

  it("dangling-cid is detected by the buyer build AND rejected by the supplier", async () => {
    const res = await fetch(`${base}/api/connections/demo/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "att-bad",
        items: [{ quantity: 1, supplierPartId: "A", unitPriceAmount: 1, currency: "USD", description: "x", uom: "EA", classification: "1", classificationDomain: "UNSPSC" }],
        currency: "USD",
        danglingCid: true,
        attachments: [{ contentId: "doc", filename: "d.txt", contentType: "text/plain", dataBase64: Buffer.from("hi").toString("base64"), scope: "order" }],
      }),
    }).then((r) => r.json());
    const c = res.request.validation.issues.map((i: any) => i.code);
    expect(c).toContain("dangling-cid");
    expect(res.statusCode).toBe("400");
  });
});
