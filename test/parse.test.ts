import { describe, expect, it } from "vitest";
import {
  collectCidReferences,
  getDocType,
  getHeaderCredentials,
  getStartPage,
  parseCart,
  parseSetupItems,
  parseXml,
} from "../src/server/cxml/parse.js";

describe("XXE / entity-expansion defense", () => {
  it("rejects a document that defines DTD entities", () => {
    const billion = `<?xml version="1.0"?>
      <!DOCTYPE cXML [ <!ENTITY lol "ha"> ]>
      <cXML payloadID="p@h" timestamp="t"><Request/></cXML>`;
    const doc = parseXml(billion);
    expect(doc.wellFormed).toBe(false);
    expect(doc.wellFormedError).toMatch(/entity/i);
  });
  it("still accepts a normal cXML SYSTEM doctype", () => {
    const ok = `<?xml version="1.0"?>
      <!DOCTYPE cXML SYSTEM "http://xml.cxml.org/schemas/cXML/1.2.045/cXML.dtd">
      <cXML payloadID="p@h" timestamp="t"><Request/></cXML>`;
    expect(parseXml(ok).wellFormed).toBe(true);
  });
});

const punchback = `<?xml version="1.0"?>
<cXML payloadID="p@h" timestamp="2026-01-01T00:00:00Z">
  <Header>
    <From><Credential domain="DUNS"><Identity>222</Identity></Credential></From>
    <To><Credential domain="DUNS"><Identity>111</Identity></Credential></To>
    <Sender><Credential domain="DUNS"><Identity>222</Identity></Credential><UserAgent>x</UserAgent></Sender>
  </Header>
  <Message>
    <PunchOutOrderMessage>
      <BuyerCookie>cookie-9</BuyerCookie>
      <PunchOutOrderMessageHeader operationAllowed="create">
        <Total><Money currency="USD">59.00</Money></Total>
      </PunchOutOrderMessageHeader>
      <ItemIn quantity="2">
        <ItemID><SupplierPartID>WIDGET-001</SupplierPartID></ItemID>
        <ItemDetail>
          <UnitPrice><Money currency="USD">12.50</Money></UnitPrice>
          <Description xml:lang="en">Widget</Description>
          <UnitOfMeasure>EA</UnitOfMeasure>
          <Classification domain="UNSPSC">31161500</Classification>
        </ItemDetail>
      </ItemIn>
      <ItemIn quantity="1">
        <ItemID><SupplierPartID>BOLT-250</SupplierPartID></ItemID>
        <ItemDetail>
          <UnitPrice><Money currency="USD">34.00</Money></UnitPrice>
          <Description xml:lang="en">Bolts</Description>
          <UnitOfMeasure>PK</UnitOfMeasure>
          <Classification domain="UNSPSC">31161600</Classification>
        </ItemDetail>
      </ItemIn>
    </PunchOutOrderMessage>
  </Message>
</cXML>`;

describe("getDocType", () => {
  it("classifies a punchback", () => {
    expect(getDocType(parseXml(punchback))).toBe("PunchOutOrderMessage");
  });
  it("classifies a SetupResponse vs OrderResponse", () => {
    const setupResp = `<cXML><Response><Status code="200"/><PunchOutSetupResponse><StartPage><URL>http://x</URL></StartPage></PunchOutSetupResponse></Response></cXML>`;
    const orderResp = `<cXML><Response><Status code="200" text="OK"/></Response></cXML>`;
    expect(getDocType(parseXml(setupResp))).toBe("SetupResponse");
    expect(getDocType(parseXml(orderResp))).toBe("OrderResponse");
    expect(getStartPage(parseXml(setupResp))).toBe("http://x");
  });
});

describe("getHeaderCredentials", () => {
  it("extracts From/To/Sender", () => {
    const creds = getHeaderCredentials(parseXml(punchback));
    expect(creds.from).toEqual({ domain: "DUNS", identity: "222" });
    expect(creds.to).toEqual({ domain: "DUNS", identity: "111" });
  });
});

describe("parseCart", () => {
  it("parses items and total", () => {
    const cart = parseCart(parseXml(punchback));
    expect(cart.sessionId).toBe("cookie-9");
    expect(cart.items).toHaveLength(2);
    expect(cart.items[0]).toMatchObject({
      quantity: 2,
      supplierPartId: "WIDGET-001",
      unitPriceAmount: 12.5,
      currency: "USD",
      uom: "EA",
      classification: "31161500",
      classificationDomain: "UNSPSC",
    });
    expect(cart.total).toEqual({ amount: 59, currency: "USD" });
  });
});

describe("parseSetupItems", () => {
  it("defaults to create with no items", () => {
    const xml = `<cXML><Request><PunchOutSetupRequest operation="create"><BuyerCookie>x</BuyerCookie></PunchOutSetupRequest></Request></cXML>`;
    expect(parseSetupItems(parseXml(xml))).toEqual({ operation: "create", items: [] });
  });

  it("parses the operation and carried ItemOut blocks (edit/inspect)", () => {
    const xml = `<cXML><Request><PunchOutSetupRequest operation="edit">
      <BuyerCookie>x</BuyerCookie>
      <ItemOut quantity="3" lineNumber="1">
        <ItemID><SupplierPartID>WIDGET-001</SupplierPartID><SupplierPartAuxiliaryID>WIDGET-001-STD</SupplierPartAuxiliaryID></ItemID>
        <ItemDetail>
          <UnitPrice><Money currency="USD">12.50</Money></UnitPrice>
          <Description xml:lang="en">Premium Steel Widget</Description>
          <UnitOfMeasure>EA</UnitOfMeasure>
          <Classification domain="UNSPSC">31161500</Classification>
        </ItemDetail>
      </ItemOut>
    </PunchOutSetupRequest></Request></cXML>`;
    const { operation, items } = parseSetupItems(parseXml(xml));
    expect(operation).toBe("edit");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      quantity: 3,
      supplierPartId: "WIDGET-001",
      supplierPartAuxiliaryId: "WIDGET-001-STD",
      unitPriceAmount: 12.5,
      currency: "USD",
      uom: "EA",
      classification: "31161500",
      classificationDomain: "UNSPSC",
    });
  });
});

describe("collectCidReferences", () => {
  it("finds cid references at both order and item levels", () => {
    const order = `<cXML><Request><OrderRequest>
      <OrderRequestHeader orderID="1" orderDate="d"><Total><Money currency="USD">1</Money></Total>
        <Comments><Attachment><URL>cid:order-doc</URL></Attachment></Comments>
      </OrderRequestHeader>
      <ItemOut quantity="1"><ItemID><SupplierPartID>A</SupplierPartID></ItemID>
        <ItemDetail><Comments><Attachment><URL>cid:item-doc</URL></Attachment></Comments></ItemDetail>
      </ItemOut>
    </OrderRequest></Request></cXML>`;
    const refs = collectCidReferences(parseXml(order));
    expect(refs).toHaveLength(2);
    expect(refs.find((r) => r.level === "order")?.cid).toBe("order-doc");
    const item = refs.find((r) => r.level === "item");
    expect(item?.cid).toBe("item-doc");
    expect(item?.itemIndex).toBe(1);
  });

  it("flags external (https) attachment URLs", () => {
    const order = `<cXML><Request><OrderRequest>
      <OrderRequestHeader orderID="1" orderDate="d"><Total><Money currency="USD">1</Money></Total>
        <Comments><Attachment><URL>https://files.example.com/x.pdf</URL></Attachment></Comments>
      </OrderRequestHeader>
      <ItemOut quantity="1"><ItemID><SupplierPartID>A</SupplierPartID></ItemID><ItemDetail/></ItemOut>
    </OrderRequest></Request></cXML>`;
    const refs = collectCidReferences(parseXml(order));
    expect(refs[0].external).toBe(true);
  });
});

describe("parseXml well-formedness", () => {
  it("reports malformed XML", () => {
    const doc = parseXml("<cXML><unclosed></cXML>");
    expect(doc.wellFormed).toBe(false);
  });
});
