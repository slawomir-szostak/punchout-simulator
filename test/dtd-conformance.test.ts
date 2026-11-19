import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildOrderRequest, buildProfileRequest, buildProfileResponse, buildPunchOutOrderMessage, buildResponseStatus, buildSetupRequest, buildSetupResponse, computeTax, cxmlTimestamp } from "../src/server/cxml/build.js";

// Validates every document the tool can build against the real cXML DTD.
//
// The DTD is not part of this repository (it is the cXML project's file, under
// its own licence), and validation needs a native tool the published package
// deliberately does not depend on. So this suite runs only when you point it at
// a local copy and have `xmllint` installed:
//
//   CXML_DTD=/path/to/cXML/1.2.072/cXML.dtd npm test
//
// Run it once per DTD version a platform profile declares (1.2.008 … 1.2.045)
// as well as the current one: older versions lack some attributes.
//
// Get the DTDs from https://cxml.org/downloads.html ("cXML DTDs"). Without the
// variable the suite is skipped, in CI too.

const dtd = process.env.CXML_DTD ? resolve(process.env.CXML_DTD) : "";
// The version is read from the path (…/cXML/1.2.014/cXML.dtd), so the documents
// are built for the DTD they are checked against — the builders leave out what
// an older version does not define.
const dtdVersion = /(\d+\.\d+\.\d+)[\\/]cXML\.dtd$/.exec(dtd)?.[1];
const hasXmllint = spawnSync("xmllint", ["--version"]).status === 0;
const enabled = !!dtd && existsSync(dtd) && hasXmllint;

const cred = (domain: string, identity: string) => ({ domain, identity });
const base = { from: cred("DUNS", "111"), to: cred("DUNS", "222"), sender: cred("DUNS", "111"), payloadId: "p@host", timestamp: cxmlTimestamp(), dtdVersion };
const addr = { name: "HQ", deliverTo: "Jo", street: "1 Main St", city: "Springfield", state: "CA", postalCode: "90000", countryIsoCode: "US", countryName: "United States", email: "jo@example.com", phone: "+1 415 555 0100", addressId: "A1", addressIdDomain: "buyer" };
const item = { quantity: 2, supplierPartId: "P1", supplierPartAuxiliaryId: "AUX", description: "Widget", uom: "EA", unitPriceAmount: 12.5, currency: "USD", classifications: [{ domain: "UNSPSC", value: "31161500" }, { domain: "eCl@ss", value: "27-06-01-01" }], manufacturerPartId: "M1", manufacturerName: "Acme" };
const order = { ...base, sharedSecret: "s", orderId: "PO1", orderDate: cxmlTimestamp(), currency: "USD", total: 25, items: [item, item], shipTo: addr, billTo: addr };
const pom = { from: cred("DUNS", "222"), to: cred("DUNS", "111"), sender: cred("DUNS", "222"), payloadId: "p@host", timestamp: cxmlTimestamp(), buyerCookie: "c1", currency: "USD", dtdVersion };

const documents: Record<string, string> = {
  "SetupRequest (create)": buildSetupRequest({ ...base, sharedSecret: "s", buyerCookie: "c1", browserFormPostUrl: "http://buyer/return", operation: "create" }),
  "SetupRequest (edit: extrinsics, contact, ship-to, items)": buildSetupRequest({ ...base, sharedSecret: "s", buyerCookie: "c1", browserFormPostUrl: "http://buyer/return", operation: "edit", extrinsics: [{ name: "User", value: "jo" }], shipTo: addr, contact: { ...addr, role: "endUser" }, addressMode: "both", items: [item], deploymentMode: "test" }),
  "SetupRequest (inspect)": buildSetupRequest({ ...base, sharedSecret: "s", buyerCookie: "c1", browserFormPostUrl: "http://buyer/return", operation: "inspect", items: [item] }),
  "OrderRequest (new)": buildOrderRequest(order),
  "OrderRequest (contact, extrinsics, attachments at both levels)": buildOrderRequest({ ...order, contact: { ...addr, role: "buyer" }, addressMode: "both", extrinsics: [{ name: "CostCenter", value: "42" }], attachments: [{ contentId: "a@x", scope: "order" }, { contentId: "b@x", scope: { itemIndex: 1 } }] }),
  "OrderRequest (id-only addresses)": buildOrderRequest({ ...order, addressMode: "id-only" }),
  "OrderRequest (update)": buildOrderRequest({ ...order, type: "update", orderVersion: 2, documentReferencePayloadId: "p0@host", extrinsics: [{ name: "X", value: "y" }] }),
  "OrderRequest (delete)": buildOrderRequest({ ...order, type: "delete", orderVersion: 3, documentReferencePayloadId: "p1@host" }),
  "OrderRequest (header shipping + tax, line tax, accounting distribution)": buildOrderRequest({
    ...order,
    shipping: { amount: 9.5, currency: "USD", description: "Ground" },
    tax: computeTax({ ratePercent: 8, category: "sales", description: "Sales tax" }, 50, "USD"),
    lineTax: { ratePercent: 8, category: "sales" },
    accounting: { name: "DistributionCharge", segments: [{ name: "Cost Center", id: "4711", description: "Marketing" }, { name: "G/L Account", id: "6000", description: "Supplies" }] },
    attachments: [{ contentId: "b@x", scope: { itemIndex: 1 } }],
  }),
  "OrderRequest (tax as a total only, no detail)": buildOrderRequest({ ...order, tax: { amount: 4, currency: "USD", description: "Tax" } }),
  "PunchOutOrderMessage (shipping + tax quoted)": buildPunchOutOrderMessage({
    ...pom,
    items: [item],
    operationAllowed: "edit",
    shipping: { amount: 5, currency: "USD", description: "Ground" },
    tax: computeTax({ ratePercent: 23, category: "vat", description: "VAT 23%" }, 25, "USD"),
  }),
  "ProfileRequest": buildProfileRequest({ ...base, sharedSecret: "s", deploymentMode: "test" }),
  "ProfileResponse": buildProfileResponse({
    dtdVersion,
    payloadId: "p@host",
    timestamp: cxmlTimestamp(),
    effectiveDate: cxmlTimestamp(new Date("2024-01-01T00:00:00Z")),
    lastRefresh: cxmlTimestamp(),
    options: [{ name: "Locale", value: "1" }],
    transactions: [
      { requestName: "ProfileRequest", url: "http://supplier/profile", options: [] },
      { requestName: "PunchOutSetupRequest", url: "http://supplier/punchout", options: [{ name: "operationAllowed", value: "create inspect edit" }] },
      { requestName: "OrderRequest", url: "http://supplier/order", options: [{ name: "attachments", value: "Yes" }, { name: "changes", value: "Yes" }] },
    ],
  }),
  "PunchOutSetupResponse": buildSetupResponse({ dtdVersion, payloadId: "p@host", timestamp: cxmlTimestamp(), startPageUrl: "http://supplier/catalog?cookie=c1" }),
  "OrderResponse (accepted)": buildResponseStatus({ dtdVersion, payloadId: "p@host", timestamp: cxmlTimestamp(), statusCode: "200", statusText: "OK", message: "OK. Order number SO-1 received." }),
  "OrderResponse (rejected)": buildResponseStatus({ dtdVersion, payloadId: "p@host", timestamp: cxmlTimestamp(), statusCode: "400", statusText: "Bad Request", message: "Rejected." }),
  "PunchOutOrderMessage (items)": buildPunchOutOrderMessage({ ...pom, items: [item], operationAllowed: "edit" }),
  "PunchOutOrderMessage (empty)": buildPunchOutOrderMessage({ ...pom, items: [], operationAllowed: "inspect" }),
  "PunchOutOrderMessage (cancelled, Status 204)": buildPunchOutOrderMessage({ ...pom, items: [], operationAllowed: "create", status: { code: "204", text: "No Content" } }),
};

describe.skipIf(!enabled)("documents built by the tool are valid against the cXML DTD", () => {
  const dir = enabled ? mkdtempSync(join(tmpdir(), "pos-dtd-")) : "";
  for (const [name, xml] of Object.entries(documents)) {
    it(name, () => {
      // Point the document's DOCTYPE at the local DTD so nothing is fetched.
      const local = xml.replace(/<!DOCTYPE cXML SYSTEM "[^"]*">/, `<!DOCTYPE cXML SYSTEM "file://${dtd}">`);
      const file = join(dir, `${name.replace(/[^A-Za-z0-9]+/g, "-")}.xml`);
      writeFileSync(file, local);
      let output = "";
      try {
        execFileSync("xmllint", ["--noout", "--nonet", "--valid", file], { stdio: "pipe" });
      } catch (e) {
        output = String((e as { stderr?: Buffer }).stderr ?? e);
      }
      expect(output.split("\n").filter((l) => l.includes("error")).join("\n")).toBe("");
    });
  }
});
