import { Hono } from "hono";
import { bus } from "../bus.js";
import {
  connectionForSession,
  rememberSessionConnection,
  setCart,
} from "../cart-store.js";
import { resolveConnection } from "../store/config.js";
import { appendLog } from "../store/log.js";
import { parseCart, parseXml, text, root } from "../cxml/parse.js";
import { validateDocument, type ExpectedCredentials } from "../cxml/validate.js";

// Mode A callback: receives the punchback (PunchOutOrderMessage) auto-submitted
// by the user's browser. It arrives either as a `cxml-urlencoded` form field
// (Ariba style), a `cxml-base64` field, or a raw cXML body — handle all three
// (spec section 11). Correlate by BuyerCookie.

export const punchoutReturnRoute = new Hono();

async function extractCxml(c: any): Promise<string> {
  const ct = (c.req.header("content-type") ?? "").toLowerCase();
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const form = await c.req.parseBody();
    if (typeof form["cxml-urlencoded"] === "string") return form["cxml-urlencoded"] as string;
    if (typeof form["cxml-base64"] === "string") {
      return Buffer.from(form["cxml-base64"] as string, "base64").toString("utf8");
    }
    // Some buyers post the cXML under a differently-named single field.
    const firstString = Object.values(form).find((v) => typeof v === "string");
    if (typeof firstString === "string" && firstString.includes("<cXML")) return firstString;
  }
  return c.req.text();
}

function htmlReceipt(ok: boolean, itemCount: number): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>punchout-simulator — cart received</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;
       min-height:100vh;align-items:center;justify-content:center;margin:0}
  .card{background:#1e293b;padding:2.5rem 3rem;border-radius:14px;text-align:center;
        box-shadow:0 10px 40px rgba(0,0,0,.4);max-width:420px}
  .icon{font-size:3rem}
  h1{font-size:1.25rem;margin:.5rem 0}
  p{color:#94a3b8;line-height:1.5}
  .ok{color:#34d399}.bad{color:#f87171}
</style></head><body><div class="card">
  <div class="icon ${ok ? "ok" : "bad"}">${ok ? "✓" : "⚠"}</div>
  <h1>Cart returned to punchout-simulator</h1>
  <p>${ok ? `Received ${itemCount} item(s).` : "The punchback had validation issues."}
     Switch back to the punchout-simulator tab to inspect the cart and build the OrderRequest.
     You can close this tab.</p>
</div><script>setTimeout(()=>{try{window.close()}catch(e){}},1500)</script></body></html>`;
}

punchoutReturnRoute.post("/return", async (c) => {
  const xml = await extractCxml(c);
  const doc = parseXml(xml);
  const cart = parseCart(doc);
  const sessionId =
    cart.sessionId || text(root(doc)?.Message?.PunchOutOrderMessage?.BuyerCookie) || "unknown";

  const connectionId = connectionForSession(sessionId);
  const resolved = connectionId ? resolveConnection(connectionId) : undefined;
  // From the buyer's seat, the punchback's From=supplier and To=buyer (the
  // reverse of the SetupRequest). credKnown checks membership, so listing both
  // identities validates the swap.
  const expected: ExpectedCredentials | undefined = resolved
    ? {
        from: resolved.buyer.identity,
        to: resolved.supplier.identity,
        sender: resolved.connection.senderIdentity ?? resolved.supplier.identity,
        authStyle: resolved.connection.authStyle,
      }
    : undefined;

  const validation = validateDocument(xml, {
    expected,
    expectedBuyerCookie: sessionId,
    forceDocType: "PunchOutOrderMessage",
  });

  if (connectionId) rememberSessionConnection(sessionId, connectionId);
  appendLog({
    sessionId,
    connectionId: connectionId ?? "",
    direction: "in",
    docType: "PunchOutOrderMessage",
    headers: { "Content-Type": c.req.header("content-type") ?? "" },
    body: xml,
    contentType: c.req.header("content-type") ?? undefined,
    validation,
  });

  setCart(cart);
  bus.emitCart(connectionId ?? "", cart);

  return c.html(htmlReceipt(validation.ok, cart.items.length));
});
