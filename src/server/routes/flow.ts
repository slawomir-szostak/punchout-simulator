import { Hono } from "hono";
import { nanoid } from "nanoid";
import { getConnection } from "../store/config.js";
import { appendLog } from "../store/log.js";
import { saveAttachment } from "../store/attachments.js";
import { rememberSessionConnection } from "../cart-store.js";
import { sendCxml } from "../http.js";
import { browserFormPostUrl, getPublicUrl } from "../runtime.js";
import {
  buildOrderRequest,
  buildSetupRequest,
  makePayloadId,
  type OrderAttachmentMeta,
} from "../cxml/build.js";
import { buildMultipartRelated, type MultipartAttachment } from "../cxml/multipart.js";
import { getStartPage, getStatus, parseXml } from "../cxml/parse.js";
import { validateDocument } from "../cxml/validate.js";
import type { AttachmentRef, CartItem, Connection } from "../cxml/types.js";

// Mode A (virtual-buyer): drive the SetupRequest and OrderRequest server-to-server,
// validate + log every document in both directions (spec sections 8, 10).

export const flowRoute = new Hono();

function host(): string {
  try {
    return new URL(getPublicUrl()).host;
  } catch {
    return "punchout-simulator";
  }
}

function requireVirtualBuyer(conn: Connection | undefined): string | null {
  if (!conn) return "connection not found";
  if (conn.mode !== "virtual-buyer") return "connection is not in virtual-buyer mode";
  return null;
}

// --- SetupRequest preview -----------------------------------------------------

flowRoute.get("/:id/setup/preview", (c) => {
  const conn = getConnection(c.req.param("id"));
  const err = requireVirtualBuyer(conn);
  if (err) return c.json({ error: err }, 400);
  const buyerCookie = c.req.query("buyerCookie") || `pos-${nanoid(16)}`;
  const xml = buildSetupRequest({
    from: conn!.from,
    to: conn!.to,
    sender: conn!.sender,
    sharedSecret: conn!.sharedSecret,
    buyerCookie,
    browserFormPostUrl: browserFormPostUrl(),
    payloadId: makePayloadId(host(), new Date().toISOString()),
    timestamp: new Date().toISOString(),
    deploymentMode: conn!.deploymentMode,
  });
  return c.json({ buyerCookie, xml, browserFormPostUrl: browserFormPostUrl() });
});

// --- SetupRequest send --------------------------------------------------------

flowRoute.post("/:id/setup", async (c) => {
  const conn = getConnection(c.req.param("id"));
  const err = requireVirtualBuyer(conn);
  if (err) return c.json({ error: err }, 400);

  const body = await c.req.json().catch(() => ({}));
  const buyerCookie: string = body.buyerCookie || `pos-${nanoid(16)}`;
  const xml: string =
    body.xml ||
    buildSetupRequest({
      from: conn!.from,
      to: conn!.to,
      sender: conn!.sender,
      sharedSecret: conn!.sharedSecret,
      buyerCookie,
      browserFormPostUrl: browserFormPostUrl(),
      payloadId: makePayloadId(host(), new Date().toISOString()),
      timestamp: new Date().toISOString(),
      deploymentMode: conn!.deploymentMode,
    });

  rememberSessionConnection(buyerCookie, conn!.id);

  const reqValidation = validateDocument(xml, {
    connection: conn,
    forceDocType: "SetupRequest",
  });
  const reqLog = appendLog({
    sessionId: buyerCookie,
    connectionId: conn!.id,
    direction: "out",
    docType: "SetupRequest",
    headers: { "Content-Type": "text/xml; charset=UTF-8" },
    body: xml,
    contentType: "text/xml",
    validation: reqValidation,
  });

  const res = await sendCxml(conn!.punchoutUrl!, xml);
  const respValidation = res.error
    ? undefined
    : validateDocument(res.body, { connection: conn, forceDocType: "SetupResponse" });
  const respLog = appendLog({
    sessionId: buyerCookie,
    connectionId: conn!.id,
    direction: "in",
    docType: "SetupResponse",
    status: res.status,
    headers: res.headers,
    body: res.error ? `<!-- transport error: ${res.error} -->` : res.body,
    contentType: res.contentType,
    validation: respValidation,
  });

  const startPage = res.error ? undefined : getStartPage(parseXml(res.body));
  const status = res.error ? undefined : getStatus(parseXml(res.body));

  return c.json({
    buyerCookie,
    transportError: res.error,
    httpStatus: res.status,
    startPage,
    statusCode: status?.code,
    request: reqLog,
    response: respLog,
  });
});

// --- OrderRequest send --------------------------------------------------------

interface OrderBody {
  sessionId: string;
  xml?: string;
  items?: CartItem[];
  orderId?: string;
  currency?: string;
  total?: number;
  danglingCid?: boolean;
  attachments?: Array<{
    contentId: string;
    filename?: string;
    contentType?: string;
    dataBase64: string;
    scope?: "order" | number; // number => 1-based item index
  }>;
  shipTo?: any;
  billTo?: any;
}

// Build the OrderRequest cXML from a request body. Shared by the preview and
// send endpoints so the document you edit in the UI is exactly what gets sent.
function buildOrderXml(conn: Connection, body: OrderBody): { xml: string; orderId: string } {
  const items = body.items ?? [];
  const currency = body.currency || items[0]?.currency || "USD";
  const total =
    body.total ?? items.reduce((s, it) => s + (it.unitPriceAmount ?? 0) * it.quantity, 0);
  const orderId = body.orderId || `PO-${nanoid(8)}`;
  const attMeta: OrderAttachmentMeta[] = (body.attachments ?? []).map((a) => ({
    contentId: a.contentId,
    scope: a.scope === "order" || a.scope == null ? "order" : { itemIndex: Number(a.scope) },
  }));
  const xml = buildOrderRequest({
    from: conn.from,
    to: conn.to,
    sender: conn.sender,
    sharedSecret: conn.sharedSecret,
    orderId,
    orderDate: new Date().toISOString(),
    payloadId: makePayloadId(host(), new Date().toISOString()),
    timestamp: new Date().toISOString(),
    deploymentMode: conn.deploymentMode,
    currency,
    total,
    items,
    shipTo: body.shipTo,
    billTo: body.billTo,
    attachments: attMeta,
  });
  return { xml, orderId };
}

// Preview the OrderRequest cXML (built from the cart + attachment plan) without
// sending it, so the user can edit Comments/anything before dispatch.
flowRoute.post("/:id/order/preview", async (c) => {
  const conn = getConnection(c.req.param("id"));
  const err = requireVirtualBuyer(conn);
  if (err) return c.json({ error: err }, 400);
  const body = (await c.req.json().catch(() => ({}))) as OrderBody;
  const { xml, orderId } = buildOrderXml(conn!, body);
  return c.json({ xml, orderId });
});

flowRoute.post("/:id/order", async (c) => {
  const conn = getConnection(c.req.param("id"));
  const err = requireVirtualBuyer(conn);
  if (err) return c.json({ error: err }, 400);

  const body = (await c.req.json().catch(() => ({}))) as OrderBody;
  const sessionId = body.sessionId || `pos-${nanoid(16)}`;
  const dangling = !!body.danglingCid;

  // In dangling-cid test mode the XML still references cid:<id> but the actual
  // part carries a DIFFERENT Content-ID, so a correct receiver must report the
  // attachment as missing (spec section 11).
  const inputAtts = body.attachments ?? [];

  // Use the (possibly edited) XML the client sent, otherwise build it fresh.
  const xml = body.xml || buildOrderXml(conn!, body).xml;

  // Assemble the wire body: multipart/related when there are attachments.
  let wireBody: string | Buffer = xml;
  let wireContentType = "text/xml; charset=UTF-8";
  const availableContentIds = new Set<string>();
  const savedRefs: AttachmentRef[] = [];

  if (inputAtts.length > 0) {
    const parts: MultipartAttachment[] = inputAtts.map((a) => {
      const actualCid = dangling ? `${a.contentId}-MISSING` : a.contentId;
      availableContentIds.add(actualCid);
      const data = Buffer.from(a.dataBase64, "base64");
      savedRefs.push(
        saveAttachment(data, {
          contentId: actualCid,
          filename: a.filename,
          contentType: a.contentType || "application/octet-stream",
        }),
      );
      return {
        contentId: actualCid,
        filename: a.filename,
        contentType: a.contentType || "application/octet-stream",
        data,
      };
    });
    const built = buildMultipartRelated(xml, parts);
    wireBody = built.body;
    wireContentType = built.contentType;
  }

  const reqValidation = validateDocument(xml, {
    connection: conn,
    forceDocType: "OrderRequest",
    availableContentIds: inputAtts.length > 0 ? availableContentIds : undefined,
  });

  const reqLog = appendLog({
    sessionId,
    connectionId: conn!.id,
    direction: "out",
    docType: "OrderRequest",
    headers: { "Content-Type": wireContentType },
    body: xml,
    contentType: wireContentType,
    validation: reqValidation,
    attachments: savedRefs,
    note: dangling ? "dangling-cid test" : undefined,
  });

  const res = await sendCxml(conn!.orderUrl!, wireBody, wireContentType);
  const respValidation = res.error
    ? undefined
    : validateDocument(res.body, { connection: conn, forceDocType: "OrderResponse" });
  const respLog = appendLog({
    sessionId,
    connectionId: conn!.id,
    direction: "in",
    docType: "OrderResponse",
    status: res.status,
    headers: res.headers,
    body: res.error ? `<!-- transport error: ${res.error} -->` : res.body,
    contentType: res.contentType,
    validation: respValidation,
  });

  const status = res.error ? undefined : getStatus(parseXml(res.body));
  return c.json({
    transportError: res.error,
    httpStatus: res.status,
    statusCode: status?.code,
    statusText: status?.text,
    request: reqLog,
    response: respLog,
  });
});
