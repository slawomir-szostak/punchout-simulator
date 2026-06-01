import { describe, expect, it } from "vitest";
import { validateDocument } from "../src/server/cxml/validate.js";
import type { Connection } from "../src/server/cxml/types.js";

const conn: Connection = {
  id: "c1",
  name: "Test",
  mode: "virtual-buyer",
  from: { domain: "DUNS", identity: "111" },
  to: { domain: "DUNS", identity: "222" },
  sender: { domain: "DUNS", identity: "111" },
  sharedSecret: "s3cret",
  deploymentMode: "test",
  authStyle: "SharedSecret",
  createdAt: "",
  updatedAt: "",
};

const codes = (xml: string, ctx = {}) =>
  validateDocument(xml, ctx).issues.map((i) => i.code);

describe("SetupResponse validation", () => {
  it("passes a valid response", () => {
    const xml = `<cXML payloadID="p@h" timestamp="t"><Response><Status code="200" text="OK"/><PunchOutSetupResponse><StartPage><URL>https://s/start</URL></StartPage></PunchOutSetupResponse></Response></cXML>`;
    const r = validateDocument(xml);
    expect(r.ok).toBe(true);
    expect(r.docType).toBe("SetupResponse");
  });
  it("flags a non-200 status and missing StartPage", () => {
    const xml = `<cXML payloadID="p@h" timestamp="t"><Response><Status code="500"/><PunchOutSetupResponse></PunchOutSetupResponse></Response></cXML>`;
    const c = codes(xml);
    expect(c).toContain("status-not-200");
    expect(c).toContain("missing-startpage");
  });
});

describe("punchback validation", () => {
  const base = (total: string) => `<cXML payloadID="p@h" timestamp="t"><Message><PunchOutOrderMessage>
    <BuyerCookie>cookie-1</BuyerCookie>
    <PunchOutOrderMessageHeader operationAllowed="create"><Total><Money currency="USD">${total}</Money></Total></PunchOutOrderMessageHeader>
    <ItemIn quantity="2"><ItemID><SupplierPartID>A</SupplierPartID></ItemID>
      <ItemDetail><UnitPrice><Money currency="USD">10.00</Money></UnitPrice><Description>x</Description><UnitOfMeasure>EA</UnitOfMeasure><Classification domain="UNSPSC">1</Classification></ItemDetail>
    </ItemIn></PunchOutOrderMessage></Message></cXML>`;

  it("passes a consistent cart", () => {
    const r = validateDocument(base("20.00"), { expectedBuyerCookie: "cookie-1" });
    expect(r.ok).toBe(true);
  });
  it("warns on Total mismatch", () => {
    expect(codes(base("99.00"))).toContain("total-mismatch");
  });
  it("errors on BuyerCookie mismatch", () => {
    expect(codes(base("20.00"), { expectedBuyerCookie: "other" })).toContain("buyercookie-mismatch");
  });
  it("errors when a required item field is missing", () => {
    const xml = `<cXML payloadID="p@h" timestamp="t"><Message><PunchOutOrderMessage>
      <BuyerCookie>c</BuyerCookie>
      <PunchOutOrderMessageHeader><Total><Money currency="USD">10</Money></Total></PunchOutOrderMessageHeader>
      <ItemIn quantity="1"><ItemID><SupplierPartID>A</SupplierPartID></ItemID>
        <ItemDetail><UnitPrice><Money currency="USD">10</Money></UnitPrice><UnitOfMeasure>EA</UnitOfMeasure><Classification domain="UNSPSC">1</Classification></ItemDetail>
      </ItemIn></PunchOutOrderMessage></Message></cXML>`;
    expect(codes(xml)).toContain("item-missing-description");
  });
});

describe("OrderRequest attachment validation", () => {
  const order = (cid: string) => `<cXML payloadID="p@h" timestamp="t"><Header>
    <From><Credential domain="DUNS"><Identity>111</Identity></Credential></From>
    <To><Credential domain="DUNS"><Identity>222</Identity></Credential></To>
    <Sender><Credential domain="DUNS"><Identity>111</Identity><SharedSecret>s3cret</SharedSecret></Credential></Sender>
    </Header><Request><OrderRequest>
    <OrderRequestHeader orderID="PO-1" orderDate="d"><Total><Money currency="USD">10</Money></Total>
      <ShipTo><Address><Name>x</Name></Address></ShipTo><BillTo><Address><Name>x</Name></Address></BillTo>
      <Comments><Attachment><URL>cid:${cid}</URL></Attachment></Comments>
    </OrderRequestHeader>
    <ItemOut quantity="1"><ItemID><SupplierPartID>A</SupplierPartID></ItemID><ItemDetail><UnitPrice><Money currency="USD">10</Money></UnitPrice></ItemDetail></ItemOut>
    </OrderRequest></Request></cXML>`;

  it("resolves a matching cid (no dangling error)", () => {
    const c = codes(order("doc-1"), { connection: conn, availableContentIds: new Set(["doc-1"]) });
    expect(c).not.toContain("dangling-cid");
  });
  it("flags a dangling cid", () => {
    const c = codes(order("doc-1"), { connection: conn, availableContentIds: new Set(["doc-1-MISSING"]) });
    expect(c).toContain("dangling-cid");
  });
  it("warns about an unreferenced part", () => {
    const c = codes(order("doc-1"), { connection: conn, availableContentIds: new Set(["doc-1", "extra"]) });
    expect(c).toContain("unreferenced-attachment");
  });
});

describe("credential & shared-secret checks", () => {
  it("warns on an unknown credential", () => {
    const xml = `<cXML payloadID="p@h" timestamp="t"><Header>
      <From><Credential domain="DUNS"><Identity>999</Identity></Credential></From>
      <To><Credential domain="DUNS"><Identity>222</Identity></Credential></To>
      <Sender><Credential domain="DUNS"><Identity>111</Identity><SharedSecret>s3cret</SharedSecret></Credential></Sender>
      </Header><Request><PunchOutSetupRequest operation="create"><BuyerCookie>c</BuyerCookie><BrowserFormPost><URL>http://x</URL></BrowserFormPost></PunchOutSetupRequest></Request></cXML>`;
    expect(codes(xml, { connection: conn })).toContain("credential-mismatch");
  });
  it("errors on a wrong SharedSecret", () => {
    const xml = `<cXML payloadID="p@h" timestamp="t"><Header>
      <From><Credential domain="DUNS"><Identity>111</Identity></Credential></From>
      <To><Credential domain="DUNS"><Identity>222</Identity></Credential></To>
      <Sender><Credential domain="DUNS"><Identity>111</Identity><SharedSecret>WRONG</SharedSecret></Credential></Sender>
      </Header><Request><OrderRequest><OrderRequestHeader orderID="1" orderDate="d"><Total><Money currency="USD">1</Money></Total></OrderRequestHeader><ItemOut quantity="1"><ItemID><SupplierPartID>A</SupplierPartID></ItemID><ItemDetail><UnitPrice><Money currency="USD">1</Money></UnitPrice></ItemDetail></ItemOut></OrderRequest></Request></cXML>`;
    expect(codes(xml, { connection: conn })).toContain("sharedsecret-mismatch");
  });
});

describe("well-formedness gate", () => {
  it("fails fast on malformed XML", () => {
    const r = validateDocument("<cXML><oops>");
    expect(r.wellFormed).toBe(false);
    expect(r.ok).toBe(false);
  });
});
