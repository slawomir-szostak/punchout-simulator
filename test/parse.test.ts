import { describe, expect, it } from "vitest";
import {
  collectCidReferences,
  getDocType,
  getHeaderCredentials,
  getStartPage,
  parseCart,
  parseXml,
} from "../src/server/cxml/parse.js";

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
