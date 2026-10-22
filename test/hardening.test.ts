import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { MAX_RESPONSE_BYTES, sendCxml } from "../src/server/http.js";
import { createSupplier, initConfig } from "../src/server/store/config.js";
import { setDataDir } from "../src/server/store/paths.js";
import { DEFAULT_MAX_DATA_MB, setMaxDataMb } from "../src/server/store/usage.js";
import { setRuntime } from "../src/server/runtime.js";
import { seedDemoIfEmpty } from "../src/server/seed.js";

// Security hardening of 0.11.3: safe ids, escaped ids in server HTML, the disk
// budget on the open inbound surface, anti-framing headers, and the cap on
// outbound response size.

let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  setDataDir(mkdtempSync(join(tmpdir(), "pos-hard-")));
  setRuntime({ port: 0, publicUrl: "http://localhost:0", token: undefined });
  setMaxDataMb(DEFAULT_MAX_DATA_MB);
  await initConfig();
  await seedDemoIfEmpty();
  app = createApp({ quiet: true });
});

const XSS_ID = `x"><img src=x onerror=alert(1)>`;

const importJson = (body: unknown) =>
  app.request("/api/config/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("ids", () => {
  it("import rejects ids outside the safe alphabet", async () => {
    for (const id of [XSS_ID, "..", ".", "a/b", "x".repeat(65)]) {
      const res = await importJson({ suppliers: [{ id, name: "S", identity: { domain: "DUNS", identity: "1" } }] });
      expect(res.status, id).toBe(400);
      expect((await res.json()).errors[0]).toMatch(/invalid id/);
    }
    // nanoid's alphabet (incl. leading "-" / "_") and dotted names stay valid.
    const ok = await importJson({ suppliers: [{ id: "-_aZ09.v2", name: "S", identity: { domain: "DUNS", identity: "1" } }] });
    expect(ok.status).toBe(200);
  });

  it("escapes the supplier id in the mock catalog page", async () => {
    // Not reachable via the API any more, but a hand-edited config.json could hold it.
    await createSupplier({ id: XSS_ID, name: "Evil", identity: { domain: "DUNS", identity: "1" } });
    const page = await (await app.request(`/sim/${encodeURIComponent(XSS_ID)}/catalog`)).text();
    expect(page).not.toContain("<img src=x");
    expect(page).toContain(`/sim/${encodeURIComponent(XSS_ID)}/checkout`);
  });
});

describe("disk budget", () => {
  it("answers 507 on inbound writes once the data dir is over budget", async () => {
    setMaxDataMb(1);
    const body = `<cXML><Request><PunchOutSetupRequest><BuyerCookie>c1</BuyerCookie></PunchOutSetupRequest></Request></cXML>`;
    const post = () => app.request("/sim/demo-supplier/punchout", { method: "POST", body });
    expect((await post()).status).toBe(200);
    // Push past 1 MB with one big inbound order.
    const big = `<cXML><Request><OrderRequest><OrderRequestHeader orderID="PO1"/>${"x".repeat(1024 * 1024)}</OrderRequest></Request></cXML>`;
    await app.request("/sim/demo-supplier/order", { method: "POST", body: big });
    const full = await post();
    expect(full.status).toBe(507);
    expect(await full.text()).toMatch(/--max-data-mb/);
    // Reads still work.
    expect((await app.request("/sim/demo-supplier/catalog")).status).toBe(200);
  });
});

describe("headers", () => {
  it("forbids framing the app and API, but not the inbound surface", async () => {
    const api = await app.request("/api/health");
    expect(api.headers.get("x-frame-options")).toBe("DENY");
    expect(api.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(api.headers.get("referrer-policy")).toBe("no-referrer");
    const sim = await app.request("/sim/demo-supplier/catalog");
    expect(sim.headers.get("x-frame-options")).toBeNull();
    expect(sim.headers.get("content-security-policy")).toBeNull();
    expect(sim.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("no longer accepts the API token from a cookie", async () => {
    setRuntime({ token: "tok" });
    const res = await app.request("/api/buyers", { headers: { cookie: "pos-api-token=tok" } });
    expect(res.status).toBe(401);
  });
});

describe("outbound response cap", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunk = Buffer.alloc(1024 * 1024, 120);
      if (req.url === "/declared") {
        res.writeHead(200, { "content-length": String(MAX_RESPONSE_BYTES + 1) });
        res.end();
        return;
      }
      // Chunked (no Content-Length): stream past the cap.
      res.writeHead(200, { "content-type": "text/xml" });
      let sent = 0;
      const pump = () => {
        while (sent <= MAX_RESPONSE_BYTES) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      pump();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());

  it("refuses a response whose Content-Length is over the cap", async () => {
    const r = await sendCxml(`${base}/declared`, "<cXML/>");
    expect(r.status).toBe(0);
    expect(r.error).toMatch(/larger than 25 MB/);
  });

  it("stops reading a streamed response once it passes the cap", async () => {
    const r = await sendCxml(`${base}/stream`, "<cXML/>");
    expect(r.status).toBe(0);
    expect(r.error).toMatch(/larger than 25 MB/);
  });
});
