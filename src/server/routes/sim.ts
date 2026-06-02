import { Hono } from "hono";
import { nanoid } from "nanoid";
import {
  findConnectionBySupplierAndBuyerIdentity,
  getSupplier,
} from "../store/config.js";
import { appendLog } from "../store/log.js";
import { saveAttachment } from "../store/attachments.js";
import { getPublicUrl } from "../runtime.js";
import {
  buildPunchOutOrderMessage,
  buildResponseStatus,
  buildSetupResponse,
  escapeXml,
  makePayloadId,
} from "../cxml/build.js";
import { getHeaderCredentials, parseXml, root, text } from "../cxml/parse.js";
import {
  isMultipart,
  normalizeContentId,
  parseMultipartRelated,
} from "../cxml/multipart.js";
import { validateDocument, type ExpectedCredentials } from "../cxml/validate.js";
import type { AttachmentEncoding, AttachmentRef, CartItem, CatalogItem, Credential, Supplier } from "../cxml/types.js";

// Mode B (virtual-supplier / mock catalog) — spec sections 4, 10, 14. Endpoints
// are keyed by SUPPLIER id, because the PunchOut/Order URLs are intrinsic to the
// supplier (constant across every buyer). The buyer is discovered at runtime
// from the inbound From credential; a matching Connection (if any) supplies the
// expected shared secret for validation.

export const simRoute = new Hono();

const DEMO_CATALOG: CatalogItem[] = [
  { supplierPartId: "WIDGET-001", description: "Premium Steel Widget", unitPrice: 12.5, currency: "USD", uom: "EA", unspsc: "31161500", manufacturerPartId: "MFR-W001", manufacturerName: "Acme Manufacturing" },
  { supplierPartId: "BOLT-250", description: "M8 Hex Bolt (pack of 250)", unitPrice: 34.0, currency: "USD", uom: "PK", unspsc: "31161600", manufacturerPartId: "MFR-B250", manufacturerName: "Acme Manufacturing" },
  { supplierPartId: "TAPE-RED", description: "Industrial Marking Tape, Red", unitPrice: 5.75, currency: "USD", uom: "RL", unspsc: "31201500" },
];

function host(): string {
  try {
    return new URL(getPublicUrl()).host;
  } catch {
    return "punchout-simulator";
  }
}

const catalogOf = (s: Supplier): CatalogItem[] => (s.catalog && s.catalog.length > 0 ? s.catalog : DEMO_CATALOG);

// The BrowserFormPost URL is buyer-supplied and later rendered as an
// auto-submitted <form action>; reject non-http(s) schemes to avoid XSS.
function safeHttpUrl(u: string | undefined): string {
  if (!u) return "";
  try {
    const p = new URL(u.trim());
    return p.protocol === "http:" || p.protocol === "https:" ? u.trim() : "";
  } catch {
    return "";
  }
}

// Build the expected-credentials context for validating an inbound document,
// from a connection matching this supplier + the inbound buyer identity.
function expectedFor(supplierId: string, from: Credential | undefined): ExpectedCredentials | undefined {
  const r = findConnectionBySupplierAndBuyerIdentity(supplierId, from);
  if (!r) return undefined;
  return {
    from: r.buyer.identity,
    to: r.supplier.identity,
    sender: r.connection.senderIdentity ?? r.buyer.identity,
    sharedSecret: r.connection.sharedSecret,
    authStyle: r.connection.authStyle,
  };
}

// --- 1. PunchOutSetupRequest in -> PunchOutSetupResponse out ------------------

simRoute.post("/:id/punchout", async (c) => {
  const supplier = getSupplier(c.req.param("id"));
  if (!supplier) return c.text("supplier not found", 404);

  const reqXml = await c.req.text();
  const doc = parseXml(reqXml);
  const reqRoot = root(doc)?.Request?.PunchOutSetupRequest;
  const buyerCookie = text(reqRoot?.BuyerCookie) || `pos-${nanoid(16)}`;
  const formPost = safeHttpUrl(text(reqRoot?.BrowserFormPost?.URL));
  const from = getHeaderCredentials(doc).from;

  appendLog({
    sessionId: buyerCookie,
    connectionId: supplier.id,
    direction: "in",
    docType: "SetupRequest",
    headers: { "Content-Type": c.req.header("content-type") ?? "" },
    body: reqXml,
    validation: validateDocument(reqXml, { expected: expectedFor(supplier.id, from), forceDocType: "SetupRequest" }),
  });

  const buyerCred = from ?? { domain: "", identity: "" };
  const startPageUrl =
    `${getPublicUrl()}/sim/${supplier.id}/catalog?cookie=${encodeURIComponent(buyerCookie)}` +
    `&formpost=${encodeURIComponent(formPost)}` +
    `&bd=${encodeURIComponent(buyerCred.domain)}&bi=${encodeURIComponent(buyerCred.identity)}`;

  const respXml = buildSetupResponse({
    payloadId: makePayloadId(host(), new Date().toISOString()),
    timestamp: new Date().toISOString(),
    startPageUrl,
    from: supplier.identity,
    to: buyerCred,
    sender: supplier.identity,
  });
  appendLog({
    sessionId: buyerCookie,
    connectionId: supplier.id,
    direction: "out",
    docType: "SetupResponse",
    headers: { "Content-Type": "text/xml; charset=UTF-8" },
    body: respXml,
    validation: validateDocument(respXml, { forceDocType: "SetupResponse" }),
  });

  c.header("Content-Type", "text/xml; charset=UTF-8");
  return c.body(respXml);
});

// --- 2. Catalog UI ------------------------------------------------------------

simRoute.get("/:id/catalog", (c) => {
  const supplier = getSupplier(c.req.param("id"));
  if (!supplier) return c.text("supplier not found", 404);
  const cookie = c.req.query("cookie") ?? "";
  const formpost = safeHttpUrl(c.req.query("formpost") ?? "");
  const bd = c.req.query("bd") ?? "";
  const bi = c.req.query("bi") ?? "";
  const items = catalogOf(supplier);

  const rows = items
    .map(
      (it, i) => `<tr>
      <td><strong>${escapeXml(it.description)}</strong><br><small>${escapeXml(it.supplierPartId)} · ${escapeXml(it.uom)} · UNSPSC ${escapeXml(it.unspsc)}</small></td>
      <td class="price">${escapeXml(it.currency)} ${it.unitPrice.toFixed(2)}</td>
      <td><input type="number" name="q_${i}" value="0" min="0" step="1" inputmode="numeric"></td>
    </tr>`,
    )
    .join("\n");

  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeXml(supplier.name)} — mock catalog</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:2rem}
  .wrap{max-width:720px;margin:0 auto}
  h1{font-size:1.4rem}.sub{color:#94a3b8;margin-bottom:1.5rem}
  table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:12px;overflow:hidden}
  th,td{padding:.75rem 1rem;text-align:left;border-bottom:1px solid #334155}
  th{background:#0b1220;font-size:.8rem;text-transform:uppercase;letter-spacing:.05em;color:#94a3b8}
  .price{white-space:nowrap;color:#fbbf24}
  input[type=number]{width:5rem;background:#0b1220;border:1px solid #334155;color:#e2e8f0;border-radius:6px;padding:.35rem .5rem}
  button{margin-top:1.5rem;background:#6366f1;color:#fff;border:0;border-radius:8px;padding:.7rem 1.4rem;font-size:1rem;cursor:pointer}
  button:hover{background:#4f46e5}
</style></head><body><div class="wrap">
  <h1>${escapeXml(supplier.name)} <small>(virtual supplier)</small></h1>
  <div class="sub">Mock catalog served by punchout-simulator. Set quantities and return the cart.</div>
  <form method="post" action="${getPublicUrl()}/sim/${supplier.id}/checkout">
    <input type="hidden" name="cookie" value="${escapeXml(cookie)}">
    <input type="hidden" name="formpost" value="${escapeXml(formpost)}">
    <input type="hidden" name="bd" value="${escapeXml(bd)}">
    <input type="hidden" name="bi" value="${escapeXml(bi)}">
    <table><thead><tr><th>Item</th><th>Price</th><th>Qty</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <button type="submit">Return cart to buyer →</button>
  </form>
</div></body></html>`);
});

// --- 3. Checkout -> auto-submit punchback ------------------------------------

simRoute.post("/:id/checkout", async (c) => {
  const supplier = getSupplier(c.req.param("id"));
  if (!supplier) return c.text("supplier not found", 404);

  const form = await c.req.parseBody();
  const cookie = String(form.cookie ?? `pos-${nanoid(16)}`);
  const formpost = safeHttpUrl(String(form.formpost ?? ""));
  const buyerCred: Credential = { domain: String(form.bd ?? ""), identity: String(form.bi ?? "") };
  const catalog = catalogOf(supplier);

  const items: CartItem[] = [];
  catalog.forEach((it, i) => {
    const qty = Number(form[`q_${i}`] ?? 0);
    if (qty > 0) {
      items.push({
        quantity: qty,
        supplierPartId: it.supplierPartId,
        description: it.description,
        uom: it.uom,
        unitPriceAmount: it.unitPrice,
        currency: it.currency,
        classificationDomain: "UNSPSC",
        classification: it.unspsc,
        manufacturerPartId: it.manufacturerPartId,
        manufacturerName: it.manufacturerName,
      });
    }
  });

  const currency = items[0]?.currency ?? "USD";
  const xml = buildPunchOutOrderMessage({
    from: supplier.identity,
    to: buyerCred,
    sender: supplier.identity,
    buyerCookie: cookie,
    payloadId: makePayloadId(host(), new Date().toISOString()),
    timestamp: new Date().toISOString(),
    currency,
    items,
  });

  appendLog({
    sessionId: cookie,
    connectionId: supplier.id,
    direction: "out",
    docType: "PunchOutOrderMessage",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: xml,
    validation: validateDocument(xml, { forceDocType: "PunchOutOrderMessage" }),
  });

  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Returning cart…</title></head>
<body onload="document.forms[0].submit()" style="font-family:system-ui;background:#0f172a;color:#e2e8f0">
  <p style="padding:2rem">Returning cart to the buyer…</p>
  <form method="post" action="${escapeXml(formpost)}">
    <input type="hidden" name="cxml-urlencoded" value="${escapeXml(xml)}">
    <noscript><button type="submit">Continue</button></noscript>
  </form>
</body></html>`);
});

// --- 4. OrderRequest in -> OrderResponse out ----------------------------------

simRoute.post("/:id/order", async (c) => {
  const supplier = getSupplier(c.req.param("id"));
  if (!supplier) return c.text("supplier not found", 404);

  const ct = c.req.header("content-type") ?? "";
  const raw = Buffer.from(await c.req.arrayBuffer());

  let xml: string;
  const availableContentIds = new Set<string>();
  const savedRefs: AttachmentRef[] = [];
  let attachmentEncoding: AttachmentEncoding | undefined;

  if (isMultipart(ct)) {
    const mp = parseMultipartRelated(raw, ct);
    xml = mp.root?.body.toString("utf8") ?? "";
    for (const part of mp.parts) {
      if (part === mp.root) continue;
      const cid = normalizeContentId(part.contentId);
      if (cid) availableContentIds.add(cid);
      if ((part.headers["content-transfer-encoding"] ?? "").toLowerCase() === "base64") {
        attachmentEncoding = "base64";
      }
      // part.body is already decoded to its content bytes by the parser.
      savedRefs.push(saveAttachment(part.body, { contentId: cid, contentType: part.contentType ?? "application/octet-stream" }));
    }
    if (savedRefs.length > 0 && !attachmentEncoding) attachmentEncoding = "binary";
  } else {
    xml = raw.toString("utf8");
  }

  const doc = parseXml(xml);
  const from = getHeaderCredentials(doc).from;
  const sessionId = findSessionForOrder(doc) ?? `order-${nanoid(8)}`;

  const validation = validateDocument(xml, {
    expected: expectedFor(supplier.id, from),
    forceDocType: "OrderRequest",
    availableContentIds: isMultipart(ct) ? availableContentIds : undefined,
  });

  appendLog({
    sessionId,
    connectionId: supplier.id,
    direction: "in",
    docType: "OrderRequest",
    headers: { "Content-Type": ct },
    body: xml,
    contentType: ct,
    validation,
    attachments: savedRefs,
    attachmentEncoding,
  });

  const ok = validation.ok;
  const respXml = buildResponseStatus({
    payloadId: makePayloadId(host(), new Date().toISOString()),
    timestamp: new Date().toISOString(),
    statusCode: ok ? "200" : "400",
    statusText: ok ? "OK" : "Bad Request",
    from: supplier.identity,
    to: from ?? { domain: "", identity: "" },
    sender: supplier.identity,
  });
  appendLog({
    sessionId,
    connectionId: supplier.id,
    direction: "out",
    docType: "OrderResponse",
    headers: { "Content-Type": "text/xml; charset=UTF-8" },
    body: respXml,
    validation: validateDocument(respXml, { forceDocType: "OrderResponse" }),
  });

  c.header("Content-Type", "text/xml; charset=UTF-8");
  return c.body(respXml, ok ? 200 : 400);
});

// cXML OrderRequest has no BuyerCookie, so group it under its orderID.
function findSessionForOrder(doc: ReturnType<typeof parseXml>): string | undefined {
  const header = root(doc)?.Request?.OrderRequest?.OrderRequestHeader;
  const orderId = header?.["@_orderID"];
  return orderId ? `order-${String(orderId)}` : undefined;
}
