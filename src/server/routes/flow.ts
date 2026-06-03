import { Hono } from "hono";
import { nanoid } from "nanoid";
import {
  dtdVersionFor,
  effectiveProfile,
  resolveConnection,
  type EffectiveProfile,
} from "../store/config.js";
import { appendLog } from "../store/log.js";
import { saveAttachment } from "../store/attachments.js";
import { rememberSessionConnection } from "../cart-store.js";
import { sendCxml } from "../http.js";
import { browserFormPostUrl, getPublicUrl } from "../runtime.js";
import {
  applyExtrinsicTokens,
  buildOrderRequest,
  buildSetupRequest,
  lineItemsTotal,
  makePayloadId,
  type ExtrinsicVal,
  type OrderAttachmentMeta,
} from "../cxml/build.js";
import { buildMultipartRelated, type MultipartAttachment } from "../cxml/multipart.js";
import { getStartPage, getStatus, parseXml } from "../cxml/parse.js";
import { validateDocument, type ExpectedCredentials } from "../cxml/validate.js";
import type { AttachmentEncoding, AttachmentRef, CartItem, Credential, ResolvedConnection } from "../cxml/types.js";

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

/** The cXML credentials/endpoints derived from a resolved virtual-buyer connection. */
interface BuyerContext {
  from: Credential; // buyer.identity
  to: Credential; // supplier.identity
  sender: Credential; // connection.senderIdentity ?? buyer.identity
  sharedSecret: string;
  punchoutUrl?: string;
  orderUrl?: string;
  deploymentMode: string;
  connectionId: string;
  attachmentEncoding: AttachmentEncoding;
  /** Effective platform profile (buyer profile layered with connection overrides). */
  eff: EffectiveProfile;
  expected: ExpectedCredentials;
  /** Whether the target supplier tolerates multi-currency documents. */
  allowMixedCurrency: boolean;
}

function buyerContext(r: ResolvedConnection): BuyerContext {
  const { connection, buyer, supplier } = r;
  const from = buyer.identity;
  const to = supplier.identity;
  const sender = connection.senderIdentity ?? buyer.identity;
  const eff = effectiveProfile(connection, buyer);
  return {
    from,
    to,
    sender,
    sharedSecret: connection.sharedSecret,
    punchoutUrl: supplier.punchoutUrl,
    orderUrl: supplier.orderUrl,
    deploymentMode: connection.deploymentMode,
    connectionId: connection.id,
    attachmentEncoding: eff.attachmentEncoding,
    eff,
    expected: { from, to, sender, sharedSecret: connection.sharedSecret },
    allowMixedCurrency: supplier.allowMixedCurrency ?? false,
  };
}

/** Setup-scoped profile extrinsics with ${buyerCookie} substituted. */
function setupExtrinsics(ctx: BuyerContext, buyerCookie: string): ExtrinsicVal[] {
  return ctx.eff.extrinsics
    .filter((e) => e.scope === "setup")
    .map((e) => ({ name: e.name, value: applyExtrinsicTokens(e.value, { buyerCookie }) }));
}

/** Order-scoped profile extrinsics with ${orderId} substituted. */
function orderExtrinsics(ctx: BuyerContext, orderId: string): ExtrinsicVal[] {
  return ctx.eff.extrinsics
    .filter((e) => e.scope === "order")
    .map((e) => ({ name: e.name, value: applyExtrinsicTokens(e.value, { orderId }) }));
}

type Resolved = { ctx: BuyerContext } | { error: string };

function resolveVirtualBuyer(id: string): Resolved {
  const r = resolveConnection(id);
  if (!r) return { error: "connection not found (or its buyer/supplier is missing)" };
  if (r.connection.mode !== "virtual-buyer") return { error: "connection is not in virtual-buyer mode" };
  return { ctx: buyerContext(r) };
}

// --- SetupRequest preview -----------------------------------------------------

flowRoute.get("/:id/setup/preview", (c) => {
  const r = resolveVirtualBuyer(c.req.param("id"));
  if ("error" in r) return c.json({ error: r.error }, 400);
  const { ctx } = r;
  const buyerCookie = c.req.query("buyerCookie") || `pos-${nanoid(16)}`;
  const xml = buildSetupRequest({
    from: ctx.from,
    to: ctx.to,
    sender: ctx.sender,
    sharedSecret: ctx.sharedSecret,
    buyerCookie,
    browserFormPostUrl: browserFormPostUrl(),
    payloadId: makePayloadId(host(), new Date().toISOString()),
    timestamp: new Date().toISOString(),
    deploymentMode: ctx.deploymentMode,
    operation: ctx.eff.setupOperation,
    dtdVersion: dtdVersionFor(ctx.eff, "SetupRequest"),
    userAgent: ctx.eff.userAgent,
    extrinsics: setupExtrinsics(ctx, buyerCookie),
  });
  return c.json({ buyerCookie, xml, browserFormPostUrl: browserFormPostUrl() });
});

// --- SetupRequest send --------------------------------------------------------

flowRoute.post("/:id/setup", async (c) => {
  const r = resolveVirtualBuyer(c.req.param("id"));
  if ("error" in r) return c.json({ error: r.error }, 400);
  const { ctx } = r;

  const body = await c.req.json().catch(() => ({}));
  const buyerCookie: string = body.buyerCookie || `pos-${nanoid(16)}`;
  const xml: string =
    body.xml ||
    buildSetupRequest({
      from: ctx.from,
      to: ctx.to,
      sender: ctx.sender,
      sharedSecret: ctx.sharedSecret,
      buyerCookie,
      browserFormPostUrl: browserFormPostUrl(),
      payloadId: makePayloadId(host(), new Date().toISOString()),
      timestamp: new Date().toISOString(),
      deploymentMode: ctx.deploymentMode,
      operation: ctx.eff.setupOperation,
      dtdVersion: dtdVersionFor(ctx.eff, "SetupRequest"),
      userAgent: ctx.eff.userAgent,
      extrinsics: setupExtrinsics(ctx, buyerCookie),
    });

  rememberSessionConnection(buyerCookie, ctx.connectionId);

  const reqValidation = validateDocument(xml, { expected: ctx.expected, forceDocType: "SetupRequest" });
  const reqLog = appendLog({
    sessionId: buyerCookie,
    connectionId: ctx.connectionId,
    direction: "out",
    docType: "SetupRequest",
    headers: { "Content-Type": "text/xml; charset=UTF-8" },
    body: xml,
    contentType: "text/xml",
    validation: reqValidation,
  });

  if (!ctx.punchoutUrl) return c.json({ error: "supplier has no punchoutUrl configured" }, 400);
  const res = await sendCxml(ctx.punchoutUrl, xml);
  const respValidation = res.error
    ? undefined
    : validateDocument(res.body, { expected: ctx.expected, forceDocType: "SetupResponse" });
  const respLog = appendLog({
    sessionId: buyerCookie,
    connectionId: ctx.connectionId,
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

// --- OrderRequest -------------------------------------------------------------

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
function buildOrderXml(ctx: BuyerContext, body: OrderBody): { xml: string; orderId: string } {
  const items = body.items ?? [];
  const currency = body.currency || items[0]?.currency || "USD";
  // Mixed-currency carts can't have a meaningful single Total — lineItemsTotal
  // returns 0 in that case (see build.ts), matching the mock supplier and
  // tripping the mixed-currency validation rather than fabricating a sum.
  const total = body.total ?? lineItemsTotal(items, currency);
  const orderId = body.orderId || `PO-${nanoid(8)}`;
  const attMeta: OrderAttachmentMeta[] = (body.attachments ?? []).map((a) => ({
    contentId: a.contentId,
    scope: a.scope === "order" || a.scope == null ? "order" : { itemIndex: Number(a.scope) },
  }));
  const xml = buildOrderRequest({
    from: ctx.from,
    to: ctx.to,
    sender: ctx.sender,
    sharedSecret: ctx.sharedSecret,
    orderId,
    orderDate: new Date().toISOString(),
    payloadId: makePayloadId(host(), new Date().toISOString()),
    timestamp: new Date().toISOString(),
    deploymentMode: ctx.deploymentMode,
    currency,
    total,
    items,
    shipTo: body.shipTo,
    billTo: body.billTo,
    attachments: attMeta,
    dtdVersion: dtdVersionFor(ctx.eff, "OrderRequest"),
    userAgent: ctx.eff.userAgent,
    extrinsics: orderExtrinsics(ctx, orderId),
  });
  return { xml, orderId };
}

// Preview the OrderRequest cXML (built from the cart + attachment plan) without
// sending it, so the user can edit Comments/anything before dispatch.
flowRoute.post("/:id/order/preview", async (c) => {
  const r = resolveVirtualBuyer(c.req.param("id"));
  if ("error" in r) return c.json({ error: r.error }, 400);
  const body = (await c.req.json().catch(() => ({}))) as OrderBody;
  const { xml, orderId } = buildOrderXml(r.ctx, body);
  return c.json({ xml, orderId });
});

flowRoute.post("/:id/order", async (c) => {
  const r = resolveVirtualBuyer(c.req.param("id"));
  if ("error" in r) return c.json({ error: r.error }, 400);
  const { ctx } = r;

  const body = (await c.req.json().catch(() => ({}))) as OrderBody;
  const sessionId = body.sessionId || `pos-${nanoid(16)}`;
  const dangling = !!body.danglingCid;
  const inputAtts = body.attachments ?? [];

  // Use the (possibly edited) XML the client sent, otherwise build it fresh.
  const xml = body.xml || buildOrderXml(ctx, body).xml;

  // Assemble the wire body: multipart/related when there are attachments. In
  // dangling-cid test mode the part carries a DIFFERENT Content-ID than the XML
  // references, so a correct receiver must report the attachment as missing.
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
    const built = buildMultipartRelated(xml, parts, { attachmentEncoding: ctx.attachmentEncoding });
    wireBody = built.body;
    wireContentType = built.contentType;
  }

  const reqValidation = validateDocument(xml, {
    expected: ctx.expected,
    forceDocType: "OrderRequest",
    availableContentIds: inputAtts.length > 0 ? availableContentIds : undefined,
    allowMixedCurrency: ctx.allowMixedCurrency,
  });

  const reqLog = appendLog({
    sessionId,
    connectionId: ctx.connectionId,
    direction: "out",
    docType: "OrderRequest",
    headers: { "Content-Type": wireContentType },
    body: xml,
    contentType: wireContentType,
    validation: reqValidation,
    attachments: savedRefs,
    attachmentEncoding: inputAtts.length > 0 ? ctx.attachmentEncoding : undefined,
    note: dangling ? "dangling-cid test" : undefined,
  });

  if (!ctx.orderUrl) return c.json({ error: "supplier has no orderUrl configured" }, 400);
  const res = await sendCxml(ctx.orderUrl, wireBody, wireContentType);
  const respValidation = res.error
    ? undefined
    : validateDocument(res.body, { expected: ctx.expected, forceDocType: "OrderResponse" });
  const respLog = appendLog({
    sessionId,
    connectionId: ctx.connectionId,
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
