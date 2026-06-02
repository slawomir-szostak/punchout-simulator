import { Hono } from "hono";
import { nanoid } from "nanoid";
import { getConnection } from "../store/config.js";
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
import { parseXml, root, text } from "../cxml/parse.js";
import {
  isMultipart,
  normalizeContentId,
  parseMultipartRelated,
} from "../cxml/multipart.js";
import { validateDocument } from "../cxml/validate.js";
import type { AttachmentRef, CartItem, CatalogItem, Connection } from "../cxml/types.js";

// Mode B (virtual-supplier / mock catalog) — spec sections 4, 10, 14. The tool
// plays the supplier: it answers a buyer's SetupRequest, serves a mock catalog,
// auto-submits a punchback, and ingests the buyer's OrderRequest. This is also
// the built-in counterparty that lets Mode A be exercised end-to-end with no
// external partner.

export const simRoute = new Hono();

const DEMO_CATALOG: CatalogItem[] = [
  {
    supplierPartId: "WIDGET-001",
    description: "Premium Steel Widget",
    unitPrice: 12.5,
    currency: "USD",
    uom: "EA",
    unspsc: "31161500",
    manufacturerPartId: "MFR-W001",
    manufacturerName: "Acme Manufacturing",
  },
  {
    supplierPartId: "BOLT-250",
    description: "M8 Hex Bolt (pack of 250)",
    unitPrice: 34.0,
    currency: "USD",
    uom: "PK",
    unspsc: "31161600",
    manufacturerPartId: "MFR-B250",
    manufacturerName: "Acme Manufacturing",
  },
  {
    supplierPartId: "TAPE-RED",
    description: "Industrial Marking Tape, Red",
    unitPrice: 5.75,
    currency: "USD",
    uom: "RL",
    unspsc: "31201500",
  },
];

function host(): string {
  try {
    return new URL(getPublicUrl()).host;
  } catch {
    return "punchout-simulator";
  }
}

// The BrowserFormPost URL is buyer-supplied (from the SetupRequest). It is later
// rendered as an auto-submitted <form action>, so a non-http(s) scheme such as
// `javascript:` would be an XSS vector — escaping HTML entities does not
// neutralize the scheme. Allow only http(s); otherwise drop it.
function safeHttpUrl(u: string | undefined): string {
  if (!u) return "";
  try {
    const parsed = new URL(u.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? u.trim() : "";
  } catch {
    return "";
  }
}

function catalogOf(conn: Connection): CatalogItem[] {
  return conn.catalog && conn.catalog.length > 0 ? conn.catalog : DEMO_CATALOG;
}

function requireSupplier(conn: Connection | undefined): string | null {
  if (!conn) return "connection not found";
  if (conn.mode !== "virtual-supplier") return "connection is not in virtual-supplier mode";
  return null;
}

// --- 1. PunchOutSetupRequest in -> PunchOutSetupResponse out ------------------

simRoute.post("/:id/punchout", async (c) => {
  const conn = getConnection(c.req.param("id"));
  const err = requireSupplier(conn);
  if (err) return c.text(err, 400);

  const reqXml = await c.req.text();
  const doc = parseXml(reqXml);
  const reqRoot = root(doc)?.Request?.PunchOutSetupRequest;
  const buyerCookie = text(reqRoot?.BuyerCookie) || `pos-${nanoid(16)}`;
  const formPost = safeHttpUrl(text(reqRoot?.BrowserFormPost?.URL));

  const reqValidation = validateDocument(reqXml, {
    connection: conn,
    forceDocType: "SetupRequest",
  });
  appendLog({
    sessionId: buyerCookie,
    connectionId: conn!.id,
    direction: "in",
    docType: "SetupRequest",
    headers: { "Content-Type": c.req.header("content-type") ?? "" },
    body: reqXml,
    validation: reqValidation,
  });

  const startPageUrl = `${getPublicUrl()}/sim/${conn!.id}/catalog?cookie=${encodeURIComponent(
    buyerCookie,
  )}&formpost=${encodeURIComponent(formPost)}`;

  const respXml = buildSetupResponse({
    payloadId: makePayloadId(host(), new Date().toISOString()),
    timestamp: new Date().toISOString(),
    startPageUrl,
    from: conn!.from,
    to: conn!.to,
    sender: conn!.sender,
  });
  appendLog({
    sessionId: buyerCookie,
    connectionId: conn!.id,
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
  const conn = getConnection(c.req.param("id"));
  const err = requireSupplier(conn);
  if (err) return c.text(err, 400);
  const cookie = c.req.query("cookie") ?? "";
  const formpost = c.req.query("formpost") ?? "";
  const items = catalogOf(conn!);

  const rows = items
    .map(
      (it, i) => `<tr>
      <td><strong>${escapeHtml(it.description)}</strong><br><small>${escapeHtml(
        it.supplierPartId,
      )} · ${escapeHtml(it.uom)} · UNSPSC ${escapeHtml(it.unspsc)}</small></td>
      <td class="price">${it.currency} ${it.unitPrice.toFixed(2)}</td>
      <td><input type="number" name="q_${i}" value="0" min="0" step="1" inputmode="numeric"></td>
    </tr>`,
    )
    .join("\n");

  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(conn!.name)} — mock catalog</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:2rem}
  .wrap{max-width:720px;margin:0 auto}
  h1{font-size:1.4rem}.sub{color:#94a3b8;margin-bottom:1.5rem}
  table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:12px;overflow:hidden}
  th,td{padding:.75rem 1rem;text-align:left;border-bottom:1px solid #334155}
  th{background:#0b1220;font-size:.8rem;text-transform:uppercase;letter-spacing:.05em;color:#94a3b8}
  .price{white-space:nowrap;color:#fbbf24}
  input[type=number]{width:5rem;background:#0b1220;border:1px solid #334155;color:#e2e8f0;
    border-radius:6px;padding:.35rem .5rem}
  button{margin-top:1.5rem;background:#6366f1;color:#fff;border:0;border-radius:8px;
    padding:.7rem 1.4rem;font-size:1rem;cursor:pointer}
  button:hover{background:#4f46e5}
</style></head><body><div class="wrap">
  <h1>${escapeHtml(conn!.name)} <small>(virtual supplier)</small></h1>
  <div class="sub">Mock catalog served by punchout-simulator. Set quantities and return the cart.</div>
  <form method="post" action="${getPublicUrl()}/sim/${conn!.id}/checkout">
    <input type="hidden" name="cookie" value="${escapeHtml(cookie)}">
    <input type="hidden" name="formpost" value="${escapeHtml(formpost)}">
    <table><thead><tr><th>Item</th><th>Price</th><th>Qty</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <button type="submit">Return cart to buyer →</button>
  </form>
</div></body></html>`);
});

// --- 3. Checkout -> auto-submit punchback ------------------------------------

simRoute.post("/:id/checkout", async (c) => {
  const conn = getConnection(c.req.param("id"));
  const err = requireSupplier(conn);
  if (err) return c.text(err, 400);

  const form = await c.req.parseBody();
  const cookie = String(form.cookie ?? `pos-${nanoid(16)}`);
  // Re-validate the scheme here too: this value round-trips through the catalog
  // page, so never trust it blind when rendering the auto-submitted form action.
  const formpost = safeHttpUrl(String(form.formpost ?? ""));
  const catalog = catalogOf(conn!);

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
    from: conn!.from,
    to: conn!.to,
    sender: conn!.sender,
    buyerCookie: cookie,
    payloadId: makePayloadId(host(), new Date().toISOString()),
    timestamp: new Date().toISOString(),
    currency,
    items,
  });

  appendLog({
    sessionId: cookie,
    connectionId: conn!.id,
    direction: "out",
    docType: "PunchOutOrderMessage",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: xml,
    validation: validateDocument(xml, { connection: conn, forceDocType: "PunchOutOrderMessage" }),
  });

  // Browser-driven auto-submit form POST of cxml-urlencoded to the buyer's
  // BrowserFormPost URL (spec sections 3 and 11).
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Returning cart…</title></head>
<body onload="document.forms[0].submit()" style="font-family:system-ui;background:#0f172a;color:#e2e8f0">
  <p style="padding:2rem">Returning cart to the buyer…</p>
  <form method="post" action="${escapeHtml(formpost)}">
    <input type="hidden" name="cxml-urlencoded" value="${escapeHtml(xml)}">
    <noscript><button type="submit">Continue</button></noscript>
  </form>
</body></html>`);
});

// --- 4. OrderRequest in -> OrderResponse out ----------------------------------

simRoute.post("/:id/order", async (c) => {
  const conn = getConnection(c.req.param("id"));
  const err = requireSupplier(conn);
  if (err) return c.text(err, 400);

  const ct = c.req.header("content-type") ?? "";
  const raw = Buffer.from(await c.req.arrayBuffer());

  let xml: string;
  const availableContentIds = new Set<string>();
  const savedRefs: AttachmentRef[] = [];

  if (isMultipart(ct)) {
    const mp = parseMultipartRelated(raw, ct);
    xml = mp.root?.body.toString("utf8") ?? "";
    for (const part of mp.parts) {
      if (part === mp.root) continue;
      const cid = normalizeContentId(part.contentId);
      if (cid) availableContentIds.add(cid);
      savedRefs.push(
        saveAttachment(part.body, {
          contentId: cid,
          contentType: part.contentType ?? "application/octet-stream",
        }),
      );
    }
  } else {
    xml = raw.toString("utf8");
  }

  const doc = parseXml(xml);
  const sessionId = findSessionForOrder(doc) ?? `order-${nanoid(8)}`;

  const validation = validateDocument(xml, {
    connection: conn,
    forceDocType: "OrderRequest",
    availableContentIds: isMultipart(ct) ? availableContentIds : undefined,
  });

  appendLog({
    sessionId,
    connectionId: conn!.id,
    direction: "in",
    docType: "OrderRequest",
    headers: { "Content-Type": ct },
    body: xml,
    contentType: ct,
    validation,
    attachments: savedRefs,
  });

  const ok = validation.ok;
  const respXml = buildResponseStatus({
    payloadId: makePayloadId(host(), new Date().toISOString()),
    timestamp: new Date().toISOString(),
    statusCode: ok ? "200" : "400",
    statusText: ok ? "OK" : "Bad Request",
    from: conn!.from,
    to: conn!.to,
    sender: conn!.sender,
  });
  appendLog({
    sessionId,
    connectionId: conn!.id,
    direction: "out",
    docType: "OrderResponse",
    headers: { "Content-Type": "text/xml; charset=UTF-8" },
    body: respXml,
    validation: validateDocument(respXml, { forceDocType: "OrderResponse" }),
  });

  c.header("Content-Type", "text/xml; charset=UTF-8");
  return c.body(respXml, ok ? 200 : 400);
});

// Best-effort: correlate an inbound OrderRequest back to a known session. cXML
// OrderRequest has no BuyerCookie, so we cannot strictly correlate — group it
// under the order's payloadID host as a stable key.
function findSessionForOrder(doc: ReturnType<typeof parseXml>): string | undefined {
  const header = root(doc)?.Request?.OrderRequest?.OrderRequestHeader;
  const orderId = header ? attrOf(header, "orderID") : undefined;
  return orderId ? `order-${orderId}` : undefined;
}

function attrOf(node: any, name: string): string | undefined {
  const v = node?.[`@_${name}`];
  return v == null ? undefined : String(v);
}

function escapeHtml(s: string): string {
  return escapeXml(s);
}
