import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { buildOrderRequest } from "../src/server/cxml/build.js";
import { getHeaderCredentials, parseXml } from "../src/server/cxml/parse.js";
import { identitiesOf } from "../src/server/cxml/types.js";
import { validateDocument } from "../src/server/cxml/validate.js";
import { createBuyer, createConnection, findConnectionBySupplierAndBuyerIdentity, initConfig } from "../src/server/store/config.js";
import { setDataDir } from "../src/server/store/paths.js";
import { setRuntime } from "../src/server/runtime.js";
import { seedDemoIfEmpty } from "../src/server/seed.js";

// Reference Guide, "Multiple Credentials": "The From, To, and Sender elements
// can each optionally contain multiple Credential elements. The purpose of
// supplying multiple credentials is to identify a single organization using
// different domains. For example, an organization might be identified by
// including both a DUNS number and a NetworkId number."

const cred = (domain: string, identity: string) => ({ domain, identity });
const TS = "2026-01-01T10:00:00+01:00";
const item = { quantity: 5, supplierPartId: "P1", description: "Widget", uom: "EA", unitPriceAmount: 10, currency: "USD", classifications: [{ domain: "UNSPSC", value: "31161500" }] };
const buyerIds = [cred("DUNS", "123456789"), cred("NetworkID", "AN01000000001")];
const supplierIds = [cred("DUNS", "987654321"), cred("NetworkID", "AN01000000002")];
const order = (from: typeof buyerIds | (typeof buyerIds)[0] = buyerIds, to: typeof supplierIds | (typeof supplierIds)[0] = supplierIds) =>
  buildOrderRequest({
    from, to, sender: buyerIds[0], sharedSecret: "demo-secret",
    orderId: "PO-1", orderDate: TS, payloadId: "p@h", timestamp: TS, currency: "USD", total: 50, items: [item],
    shipTo: { name: "HQ", street: "1 Main", city: "X" }, billTo: { name: "HQ", street: "1 Main", city: "X" },
  });
const expected = { from: buyerIds, to: supplierIds, sender: buyerIds[0], sharedSecret: "demo-secret" };
const credentialIssues = (xml: string, exp = expected) =>
  validateDocument(xml, { expected: exp }).issues.filter((i) => i.code.startsWith("credential")).map((i) => i.code);

describe("building", () => {
  it("lists a party's identities main one first", () => {
    expect(identitiesOf({ identity: buyerIds[0], additionalIdentities: [buyerIds[1]] })).toEqual(buyerIds);
    expect(identitiesOf({ identity: buyerIds[0] })).toEqual([buyerIds[0]]);
  });

  it("writes one Credential per identity, in order, in From and To", () => {
    const creds = getHeaderCredentials(parseXml(order()));
    expect(creds.fromAll).toEqual(buyerIds);
    expect(creds.toAll).toEqual(supplierIds);
    expect(creds.senderAll).toEqual([buyerIds[0]]);
  });

  it("still writes a single Credential for a single identity", () => {
    expect(order(buyerIds[0], supplierIds[0]).match(/<Credential /g)).toHaveLength(3);
  });
});

describe("validating", () => {
  it("accepts every identity the parties are set up with", () => {
    expect(credentialIssues(order())).toEqual([]);
  });

  it("accepts a document that names a party by its additional identity alone", () => {
    expect(credentialIssues(order(buyerIds[1], supplierIds[1]))).toEqual([]);
  });

  it("flags an identity that is wrong in a domain the party is known in", () => {
    const xml = order([buyerIds[0], cred("NetworkID", "AN09999999999")]);
    expect(credentialIssues(xml)).toEqual(["credential-mismatch"]);
  });

  it("leaves a credential in a domain nobody configured alone", () => {
    expect(credentialIssues(order([...buyerIds, cred("VendorPortalID", "x-17")]))).toEqual([]);
  });
});

describe("over HTTP", () => {
  let server: ReturnType<typeof serve>;
  let base = "";
  beforeAll(async () => {
    setDataDir(mkdtempSync(join(tmpdir(), "pos-creds-")));
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
  const send = (method: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("a party cannot be saved with two different identities in one domain", async () => {
    const res = await send("POST", "/api/buyers", { name: "Twice", identity: cred("DUNS", "1"), additionalIdentities: [cred("DUNS", "2")] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).errors[0]).toContain('two identities in domain "DUNS"');
    const half = await send("POST", "/api/buyers", { name: "Half", identity: cred("DUNS", "1"), additionalIdentities: [cred("NetworkID", "")] });
    expect(half.status).toBe(400);
  });

  it("empty rows are dropped, and a party without extras stores none", async () => {
    const res = await send("POST", "/api/buyers", { name: "Plain", identity: cred("DUNS", "5"), additionalIdentities: [cred("", "")] });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).additionalIdentities).toBeUndefined();
  });

  it("an order names both parties by all their identities, and the mock supplier accepts it", async () => {
    const buyer = await createBuyer({ name: "Two names", identity: cred("DUNS", "515151515"), additionalIdentities: [cred("NetworkID", "AN01000000001")], profileId: "generic" });
    const conn = await createConnection({ name: "Two names → Demo", buyerId: buyer.id, supplierId: "demo-supplier", mode: "virtual-buyer", sharedSecret: "demo-secret", deploymentMode: "test" });
    const supplier = (await (await fetch(`${base}/api/suppliers/demo-supplier`)).json()) as any;
    const put = await send("PUT", "/api/suppliers/demo-supplier", { ...supplier, additionalIdentities: [cred("NetworkID", "AN01000000002")] });
    expect(put.status).toBe(200);

    const res = (await (
      await send("POST", `/api/connections/${conn.id}/order`, {
        sessionId: "creds-1",
        items: [{ quantity: 1, supplierPartId: "WIDGET-001", description: "Premium Steel Widget", uom: "EA", unitPriceAmount: 12.5, currency: "USD", classifications: [{ domain: "UNSPSC", value: "31161500" }] }],
        currency: "USD",
      })
    ).json()) as any;
    const creds = getHeaderCredentials(parseXml(res.request.body));
    expect(creds.fromAll).toEqual([cred("DUNS", "515151515"), cred("NetworkID", "AN01000000001")]);
    expect(creds.toAll.map((c) => c.domain)).toEqual(["DUNS", "NetworkID"]);
    expect(res.statusCode).toBe("200");
    expect(res.request.validation.issues.filter((i: any) => i.code.startsWith("credential"))).toEqual([]);

    // The mock supplier knows this buyer by either identity.
    expect(findConnectionBySupplierAndBuyerIdentity("demo-supplier", [cred("NetworkID", "AN01000000001")])?.buyer.id).toBe(buyer.id);
    expect(findConnectionBySupplierAndBuyerIdentity("demo-supplier", [cred("NetworkID", "AN00000000000")])).toBeUndefined();
  });
});
