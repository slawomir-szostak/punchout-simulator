import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { connectionForSession, getCart } from "../src/server/cart-store.js";
import { appendLog } from "../src/server/store/log.js";
import { setDataDir } from "../src/server/store/paths.js";

// Simulates the post-restart case: the in-memory cart/connection maps are empty
// (this process never called setCart/rememberSessionConnection for the session),
// but the punchback is durably in the log. Both lookups must re-derive it.

const punchback = `<?xml version="1.0"?>
<cXML payloadID="p@h" timestamp="2026-01-01T00:00:00Z">
  <Header>
    <From><Credential domain="DUNS"><Identity>222</Identity></Credential></From>
    <To><Credential domain="DUNS"><Identity>111</Identity></Credential></To>
    <Sender><Credential domain="DUNS"><Identity>222</Identity></Credential><UserAgent>x</UserAgent></Sender>
  </Header>
  <Message>
    <PunchOutOrderMessage>
      <BuyerCookie>cookie-restart</BuyerCookie>
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
    </PunchOutOrderMessage>
  </Message>
</cXML>`;

beforeAll(() => {
  setDataDir(mkdtempSync(join(tmpdir(), "pos-cart-")));
  // A SetupRequest carrying the connection id, then the inbound punchback.
  appendLog({
    sessionId: "cookie-restart",
    connectionId: "conn-42",
    direction: "out",
    docType: "SetupRequest",
    body: "<cXML/>",
  });
  appendLog({
    sessionId: "cookie-restart",
    connectionId: "conn-42",
    direction: "in",
    docType: "PunchOutOrderMessage",
    body: punchback,
  });
});

describe("cart-store log-derived fallback (post-restart)", () => {
  it("rebuilds the cart from the logged PunchOutOrderMessage", () => {
    const cart = getCart("cookie-restart");
    expect(cart).toBeDefined();
    expect(cart!.sessionId).toBe("cookie-restart");
    expect(cart!.items).toHaveLength(1);
    expect(cart!.items[0].supplierPartId).toBe("WIDGET-001");
    expect(cart!.items[0].quantity).toBe(2);
  });

  it("recovers the connection id from the first logged record", () => {
    expect(connectionForSession("cookie-restart")).toBe("conn-42");
  });

  it("returns undefined for a session with no log", () => {
    expect(getCart("nope")).toBeUndefined();
    expect(connectionForSession("nope")).toBeUndefined();
  });
});
