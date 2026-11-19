import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { buildProfileRequest, buildProfileResponse } from "../src/server/cxml/build.js";
import { getDocType, parseProfileResponse, parseXml, profileUrlFor } from "../src/server/cxml/parse.js";
import { validateDocument } from "../src/server/cxml/validate.js";
import { getSupplier, initConfig, updateSupplier } from "../src/server/store/config.js";
import { setDataDir } from "../src/server/store/paths.js";
import { setRuntime } from "../src/server/runtime.js";
import { seedDemoIfEmpty } from "../src/server/seed.js";

// The cXML Profile transaction: "the only transaction that all cXML servers
// must support". A ProfileRequest is an empty element routed by the Header; the
// ProfileResponse lists the requests the server accepts and where to send them.

const cred = (domain: string, identity: string) => ({ domain, identity });
const TS = "2026-01-01T10:00:00+01:00";
const codes = (xml: string) => validateDocument(xml).issues.map((i) => i.code);
const severityOf = (xml: string, code: string) => validateDocument(xml).issues.find((i) => i.code === code)?.severity;
const response = (o: Partial<Parameters<typeof buildProfileResponse>[0]> = {}) =>
  buildProfileResponse({
    payloadId: "p@h",
    timestamp: TS,
    effectiveDate: "2024-01-01T00:00:00+00:00",
    transactions: [
      { requestName: "PunchOutSetupRequest", url: "https://s.example/punchout", options: [] },
      { requestName: "OrderRequest", url: "https://s.example/order", options: [{ name: "attachments", value: "Yes" }, { name: "changes", value: "No" }] },
    ],
    ...o,
  });

describe("documents", () => {
  it("builds an empty ProfileRequest with a full Header, and classifies both documents", () => {
    const req = buildProfileRequest({ from: cred("DUNS", "1"), to: cred("DUNS", "2"), sender: cred("DUNS", "1"), sharedSecret: "s", payloadId: "p@h", timestamp: TS, deploymentMode: "test" });
    expect(req).toContain('<Request deploymentMode="test">\n    <ProfileRequest/>');
    expect(req).toContain("<SharedSecret>s</SharedSecret>");
    expect(getDocType(parseXml(req))).toBe("ProfileRequest");
    expect(getDocType(parseXml(response()))).toBe("ProfileResponse");
    expect(response()).not.toContain("<Header>");
  });

  it("round-trips options and transactions", () => {
    const profile = parseProfileResponse(parseXml(response({ lastRefresh: TS, options: [{ name: "Locale", value: "1" }] })))!;
    expect(profile.effectiveDate).toBe("2024-01-01T00:00:00+00:00");
    expect(profile.lastRefresh).toBe(TS);
    expect(profile.options).toEqual([{ name: "Locale", value: "1" }]);
    expect(profile.transactions.map((t) => t.requestName)).toEqual(["PunchOutSetupRequest", "OrderRequest"]);
    expect(profile.transactions[1].options).toEqual([{ name: "attachments", value: "Yes" }, { name: "changes", value: "No" }]);
    expect(validateDocument(response()).issues).toEqual([]);
  });

  it("picks the URL for a request, preferring the variation without a service option", () => {
    const profile = parseProfileResponse(
      parseXml(
        response({
          transactions: [
            { requestName: "PunchOutSetupRequest", url: "https://s.example/console", options: [{ name: "service", value: "console" }] },
            { requestName: "PunchOutSetupRequest", url: "https://s.example/punchout", options: [] },
          ],
        }),
      ),
    )!;
    expect(profileUrlFor(profile, "PunchOutSetupRequest")).toBe("https://s.example/punchout");
    expect(profileUrlFor(profile, "OrderRequest")).toBeUndefined();
  });
});

describe("validating a ProfileResponse", () => {
  it("requires effectiveDate, at least one Transaction, and a requestName and URL on each", () => {
    expect(severityOf(response().replace(/ effectiveDate="[^"]*"/, ""), "profile-missing-effectivedate")).toBe("error");
    expect(severityOf(response({ transactions: [] }), "profile-no-transactions")).toBe("error");
    expect(severityOf(response().replace(' requestName="OrderRequest"', ""), "transaction-missing-requestname")).toBe("error");
    expect(severityOf(response().replace("<URL>https://s.example/order</URL>", "<URL></URL>"), "transaction-missing-url")).toBe("error");
    expect(severityOf(response().replace("https://s.example/order", "ftp://s.example/order"), "transaction-invalid-url")).toBe("error");
  });

  it("warns about an effectiveDate in the future and an OrderRequest without its two options", () => {
    expect(codes(response({ effectiveDate: "2999-01-01T00:00:00+00:00" }))).toContain("profile-effectivedate-future");
    const noOptions = response({ transactions: [{ requestName: "OrderRequest", url: "https://s.example/order", options: [{ name: "attachments", value: "Yes" }] }] });
    const issue = validateDocument(noOptions).issues.find((i) => i.code === "profile-order-options");
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("changes");
    expect(issue?.message).not.toContain("attachments and");
  });

  it("accepts an error Status without a profile", () => {
    const rejected = `<!DOCTYPE cXML SYSTEM "http://xml.cxml.org/schemas/cXML/1.2.045/cXML.dtd"><cXML payloadID="p@h" timestamp="${TS}" xml:lang="en"><Response><Status code="401" text="Unauthorized" xml:lang="en">bad secret</Status></Response></cXML>`;
    const r = validateDocument(rejected, { forceDocType: "ProfileResponse" });
    expect(r.issues.map((i) => i.code)).toEqual(["status-error"]);
  });
});

describe("over HTTP: the tool as buyer asking the tool as supplier", () => {
  let server: ReturnType<typeof serve>;
  let base = "";
  beforeAll(async () => {
    setDataDir(mkdtempSync(join(tmpdir(), "pos-profile-")));
    await initConfig();
    await new Promise<void>((resolve) => {
      server = serve({ fetch: createApp({ quiet: true }).fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
        base = `http://127.0.0.1:${info.port}`;
        setRuntime({ port: info.port, publicUrl: base, token: undefined });
        resolve();
      });
    });
    await seedDemoIfEmpty();
  });
  afterAll(() => {
    server?.close();
  });
  const post = (path: string, body: unknown = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);
  const profileRequest = (secret: string) =>
    buildProfileRequest({ from: cred("DUNS", "123456789"), to: cred("DUNS", "987654321"), sender: cred("DUNS", "123456789"), sharedSecret: secret, payloadId: "pr@h", timestamp: TS });
  const sendTo = (path: string, xml: string) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "text/xml" }, body: xml });

  it("the mock supplier advertises its three requests, on any of its endpoints", async () => {
    for (const endpoint of ["profile", "punchout", "order"]) {
      const res = await sendTo(`/sim/demo-supplier/${endpoint}`, profileRequest("demo-secret"));
      expect(res.status).toBe(200);
      const xml = await res.text();
      const profile = parseProfileResponse(parseXml(xml))!;
      expect(profile.transactions.map((t) => t.requestName)).toEqual(["ProfileRequest", "PunchOutSetupRequest", "OrderRequest"]);
      expect(profileUrlFor(profile, "PunchOutSetupRequest")).toBe(`${base}/sim/demo-supplier/punchout`);
      expect(profileUrlFor(profile, "OrderRequest")).toBe(`${base}/sim/demo-supplier/order`);
      expect(profile.transactions[2].options).toEqual([{ name: "attachments", value: "Yes" }, { name: "changes", value: "Yes" }]);
      expect(validateDocument(xml).issues).toEqual([]);
    }
  });

  it("the advertised operations follow the supplier's operationAllowed setting", async () => {
    const s = getSupplier("demo-supplier")!;
    await updateSupplier("demo-supplier", { ...s, operationAllowed: "inspect" });
    const profile = parseProfileResponse(parseXml(await sendTo("/sim/demo-supplier/profile", profileRequest("demo-secret")).then((r) => r.text())))!;
    expect(profile.transactions[1].options).toEqual([{ name: "operationAllowed", value: "create inspect" }]);
    await updateSupplier("demo-supplier", { ...s, operationAllowed: undefined });
  });

  it("a wrong shared secret gets a cXML 401 instead of a profile", async () => {
    const res = await sendTo("/sim/demo-supplier/profile", profileRequest("not-the-secret"));
    expect(res.status).toBe(401);
    const xml = await res.text();
    expect(xml).toContain('<Status code="401" text="Unauthorized"');
    expect(parseProfileResponse(parseXml(xml))).toBeUndefined();
  });

  it("the buyer side sends a ProfileRequest and reports what the supplier supports", async () => {
    const result = await post("/api/connections/demo/profile");
    expect(result.url).toBe(`${base}/sim/demo-supplier/punchout`); // no profile URL set: the PunchOut URL
    expect(result.statusCode).toBe("200");
    expect(result.profile.transactions).toHaveLength(3);
    expect(result.differences).toEqual([]); // the demo supplier is configured with exactly these URLs
    expect(result.request.docType).toBe("ProfileRequest");
    expect(result.request.body).toContain("<SharedSecret>***</SharedSecret>"); // redacted in the log
    expect(result.response.validation.ok).toBe(true);
    // Both documents are in a session of their own.
    const log = await fetch(`${base}/api/sessions/${result.sessionId}`).then((r) => r.json() as Promise<any[]>);
    expect(log.map((r) => r.docType)).toEqual(expect.arrayContaining(["ProfileRequest", "ProfileResponse"]));
  });

  it("points out URLs that differ from the configuration — the wrong-URL case", async () => {
    // A supplier record that is the mock, but with an outdated order URL and its
    // profile URL set explicitly.
    const s = getSupplier("demo-supplier")!;
    const copy = await post("/api/suppliers", { ...s, id: undefined, name: "Demo Supplier (stale URLs)", profileUrl: `${base}/sim/demo-supplier/profile`, orderUrl: `${base}/sim/demo-supplier/orders-old` });
    const conn = await post("/api/connections", { buyerId: "demo-buyer", supplierId: copy.id, mode: "virtual-buyer", sharedSecret: "demo-secret" });
    const result = await post(`/api/connections/${conn.id}/profile`);
    expect(result.url).toBe(`${base}/sim/demo-supplier/profile`);
    expect(result.differences).toEqual([
      { field: "orderUrl", requestName: "OrderRequest", configured: `${base}/sim/demo-supplier/orders-old`, advertised: `${base}/sim/demo-supplier/order` },
    ]);
  });

  it("explains an endpoint that does not speak cXML", async () => {
    const copy = await post("/api/suppliers", { name: "Not cXML", identity: cred("DUNS", "555"), punchoutUrl: `${base}/api/health` });
    const conn = await post("/api/connections", { buyerId: "demo-buyer", supplierId: copy.id, mode: "virtual-buyer", sharedSecret: "x" });
    const result = await post(`/api/connections/${conn.id}/profile`);
    expect(result.profile).toBeUndefined();
    expect(result.statusCode).toBeUndefined();
    expect(result.response.validation.issues[0].message).toMatch(/not cXML/);
  });
});
