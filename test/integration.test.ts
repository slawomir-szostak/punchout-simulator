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
  it("seeds two demo connections", async () => {
    const conns = await fetch(`${base}/api/connections`).then((r) => r.json());
    expect(conns).toHaveLength(2);
  });

  it("runs setup -> browse -> punchback -> order", async () => {
    // SetupRequest
    const setup = await fetch(`${base}/api/connections/demo-buyer/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then((r) => r.json());
    expect(setup.statusCode).toBe("200");
    expect(setup.request.validation.ok).toBe(true);
    expect(setup.response.validation.ok).toBe(true);
    expect(setup.startPage).toBeTruthy();

    const cookie = setup.buyerCookie;
    const formpost = new URL(setup.startPage).searchParams.get("formpost")!;

    // Checkout -> punchback, then submit to the callback as the browser would
    const form = new URLSearchParams({ cookie, formpost, q_0: "2", q_1: "1" });
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
    const order = await fetch(`${base}/api/connections/demo-buyer/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: cookie, items: cart.items, currency: cart.total.currency }),
    }).then((r) => r.json());
    expect(order.statusCode).toBe("200");
    expect(order.request.validation.ok).toBe(true);
  });

  it("happy-path attachment resolves its cid", async () => {
    const res = await fetch(`${base}/api/connections/demo-buyer/order`, {
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

  it("dangling-cid is detected by the buyer build AND rejected by the supplier", async () => {
    const res = await fetch(`${base}/api/connections/demo-buyer/order`, {
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
