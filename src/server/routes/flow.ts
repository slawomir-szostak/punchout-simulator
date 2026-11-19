import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { nanoid } from "nanoid";
import { readJsonBody } from "./json-body.js";
import { resolveCharges } from "./charges.js";
import {
  dtdVersionFor,
  effectiveProfile,
  resolveConnection,
  type EffectiveProfile,
} from "../store/config.js";
import { appendLog, readSession } from "../store/log.js";
import { saveAttachment } from "../store/attachments.js";
import { getCart, rememberOrderSession, rememberSessionConnection } from "../cart-store.js";
import { sendCxml } from "../http.js";
import { browserFormPostUrl, getPublicUrl } from "../runtime.js";
import {
  applyExtrinsicTokens,
  buildOrderRequest,
  buildProfileRequest,
  buildSetupRequest,
  lineItemsTotal,
  makePayloadId,
  computeTax,
  cxmlTimestamp,
  type ExtrinsicVal,
  type OrderAttachmentMeta,
  type OrderType,
} from "../cxml/build.js";
import { buildMultipartRelated, type MultipartAttachment } from "../cxml/multipart.js";
import { getOrderInfo, getStartPage, getStatus, parseProfileResponse, parseXml, profileUrlFor } from "../cxml/parse.js";
import { validateDocument, type ExpectedCredentials } from "../cxml/validate.js";
import type { Address, AddressMode, AttachmentEncoding, AttachmentRef, CartItem, Contact, Credential, DocType, ResolvedConnection, SetupOperation, AccountingSettings, ShippingSettings, TaxSettings, ChargeAmount, SelectedItem } from "../cxml/types.js";
import type { OrderResult, ProfileResult, SetupResult } from "./dto.js";

const coerceOperation = (v: unknown): SetupOperation | undefined =>
  v === "create" || v === "edit" || v === "inspect" ? v : undefined;
// The catalog item to punch out from (SelectedItem): kept when it names a part.
const selectedItem = (body: any): SelectedItem | undefined => {
  const part = typeof body?.selectedItem?.supplierPartId === "string" ? body.selectedItem.supplierPartId.trim() : "";
  if (!part) return undefined;
  const aux = typeof body.selectedItem.supplierPartAuxiliaryId === "string" ? body.selectedItem.supplierPartAuxiliaryId.trim() : "";
  return { supplierPartId: part, supplierPartAuxiliaryId: aux || undefined };
};
const setupItems = (body: any): CartItem[] | undefined =>
  Array.isArray(body?.items) && body.items.length > 0 ? (body.items as CartItem[]) : undefined;

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
  /**
   * Where a ProfileRequest goes. The standard has it sent to a server's "root"
   * URL, from which the URLs of the other requests are learned; when the
   * supplier has no such URL configured the PunchOut (else the order) URL is
   * tried, which works for a supplier with one cXML endpoint for everything.
   */
  profileUrl?: string;
  profileUrlSource: "profileUrl" | "punchoutUrl" | "orderUrl";
  deploymentMode: string;
  connectionId: string;
  attachmentEncoding: AttachmentEncoding;
  /** Effective platform profile (buyer profile layered with connection overrides). */
  eff: EffectiveProfile;
  expected: ExpectedCredentials;
  /** Whether the target supplier tolerates multi-currency documents. */
  allowMixedCurrency: boolean;
  /** The buyer's default addresses/contact (pre-fill orders; sent in setup if profile-gated). */
  shipTo?: Address;
  billTo?: Address;
  contact?: Contact;
  /** Tax and shipping on orders to this supplier: the connection's override, else the buyer's. */
  tax?: TaxSettings;
  shipping?: ShippingSettings;
  /**
   * True when tax/shipping came from the buyer's defaults, so an order with
   * none may still carry the supplier's quote. A connection that says "none"
   * or sets its own figures has decided, and the quote is not used.
   */
  chargesInherited: boolean;
  accounting?: AccountingSettings;
}

function buyerContext(r: ResolvedConnection): BuyerContext {
  const { connection, buyer, supplier } = r;
  const from = buyer.identity;
  const to = supplier.identity;
  const sender = connection.senderIdentity ?? buyer.identity;
  const eff = effectiveProfile(connection, buyer);
  const orderCharges = resolveCharges(connection.orderCharges, { tax: buyer.tax, shipping: buyer.shipping });
  return {
    from,
    to,
    sender,
    sharedSecret: connection.sharedSecret,
    punchoutUrl: supplier.punchoutUrl,
    orderUrl: supplier.orderUrl,
    profileUrl: supplier.profileUrl || supplier.punchoutUrl || supplier.orderUrl,
    profileUrlSource: supplier.profileUrl ? "profileUrl" : supplier.punchoutUrl ? "punchoutUrl" : "orderUrl",
    deploymentMode: connection.deploymentMode,
    connectionId: connection.id,
    attachmentEncoding: eff.attachmentEncoding,
    eff,
    expected: { from, to, sender, sharedSecret: connection.sharedSecret },
    allowMixedCurrency: supplier.allowMixedCurrency ?? false,
    shipTo: buyer.shipTo,
    billTo: buyer.billTo,
    contact: buyer.contact,
    tax: orderCharges.tax,
    shipping: orderCharges.shipping,
    chargesInherited: orderCharges.inherited,
    accounting: buyer.accounting,
  };
}

// Addresses carried in the SetupRequest, gated by the buyer's profile (Ariba-style
// ShipTo-in-setup; Contact-in-setup). Returns undefined fields when not gated on.
function setupAddresses(ctx: BuyerContext): { shipTo?: Address; contact?: Contact; addressMode: AddressMode } {
  return {
    shipTo: ctx.eff.shipToInSetup ? ctx.shipTo : undefined,
    contact: ctx.eff.contactInSetup ? ctx.contact : undefined,
    addressMode: ctx.eff.addressMode,
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

// --- ProfileRequest -------------------------------------------------------------
//
// Ask the supplier what it supports and where: "To obtain information about
// where to send any document, send a ProfileRequest document to the server."
// It is also the cheapest way to check that an endpoint is reachable and that
// the credentials are accepted, before a session is opened.

flowRoute.post("/:id/profile", async (c) => {
  const r = resolveVirtualBuyer(c.req.param("id"));
  if ("error" in r) return c.json({ error: r.error }, 400);
  const { ctx } = r;
  if (!ctx.profileUrl) return c.json({ error: "supplier has no profile, PunchOut or order URL configured" }, 400);

  const xml = buildProfileRequest({
    from: ctx.from,
    to: ctx.to,
    sender: ctx.sender,
    sharedSecret: ctx.sharedSecret,
    payloadId: makePayloadId(host(), new Date().toISOString()),
    timestamp: cxmlTimestamp(),
    deploymentMode: ctx.deploymentMode,
    dtdVersion: dtdVersionFor(ctx.eff, "SetupRequest"),
    userAgent: ctx.eff.userAgent,
  });
  const sessionId = `profile-${nanoid(10)}`;
  rememberSessionConnection(sessionId, ctx.connectionId);
  const request = appendLog({
    sessionId,
    connectionId: ctx.connectionId,
    direction: "out",
    docType: "ProfileRequest",
    url: ctx.profileUrl,
    headers: { "Content-Type": "text/xml; charset=UTF-8" },
    body: xml,
    contentType: "text/xml",
    validation: validateDocument(xml, { expected: ctx.expected, forceDocType: "ProfileRequest" }),
  });

  const res = await sendCxml(ctx.profileUrl, xml);
  const response = appendLog({
    sessionId,
    connectionId: ctx.connectionId,
    direction: "in",
    docType: "ProfileResponse",
    status: res.status,
    url: ctx.profileUrl,
    headers: res.headers,
    body: res.error ? `<!-- transport error: ${res.error} -->` : res.body,
    contentType: res.contentType,
    validation: res.error
      ? undefined
      : validateDocument(res.body, {
          forceDocType: "ProfileResponse",
          http: { status: res.status, contentType: res.contentType, location: res.headers.location, url: ctx.profileUrl },
        }),
  });

  const doc = res.error ? undefined : parseXml(res.body);
  const status = doc ? getStatus(doc) : undefined;
  const profile = doc ? parseProfileResponse(doc) : undefined;
  // Where the supplier says to send a request versus where this tool would.
  const differences: ProfileResult["differences"] = [];
  if (profile) {
    for (const [field, requestName, configured] of [
      ["punchoutUrl", "PunchOutSetupRequest", ctx.punchoutUrl],
      ["orderUrl", "OrderRequest", ctx.orderUrl],
    ] as const) {
      const advertised = profileUrlFor(profile, requestName);
      if (advertised && advertised !== configured) differences.push({ field, requestName, configured, advertised });
    }
  }
  const result: ProfileResult = {
    sessionId,
    url: ctx.profileUrl,
    urlSource: ctx.profileUrlSource,
    transportError: res.error,
    httpStatus: res.status,
    statusCode: status?.code,
    statusMessage: status?.message,
    profile,
    differences,
    request,
    response,
  };
  return c.json(result);
});

// --- SetupRequest preview -----------------------------------------------------

flowRoute.post("/:id/setup/preview", async (c) => {
  const r = resolveVirtualBuyer(c.req.param("id"));
  if ("error" in r) return c.json({ error: r.error }, 400);
  const { ctx } = r;
  const body = await readJsonBody(c);
  const buyerCookie = body.buyerCookie || `pos-${nanoid(16)}`;
  const xml = buildSetupRequest({
    from: ctx.from,
    to: ctx.to,
    sender: ctx.sender,
    sharedSecret: ctx.sharedSecret,
    buyerCookie,
    browserFormPostUrl: browserFormPostUrl(),
    payloadId: makePayloadId(host(), new Date().toISOString()),
    timestamp: cxmlTimestamp(),
    deploymentMode: ctx.deploymentMode,
    operation: coerceOperation(body.operation) ?? ctx.eff.setupOperation,
    dtdVersion: dtdVersionFor(ctx.eff, "SetupRequest"),
    userAgent: ctx.eff.userAgent,
    extrinsics: setupExtrinsics(ctx, buyerCookie),
    ...setupAddresses(ctx),
    items: setupItems(body),
    selectedItem: selectedItem(body),
  });
  return c.json({ buyerCookie, xml, browserFormPostUrl: browserFormPostUrl() });
});

// --- SetupRequest send --------------------------------------------------------

flowRoute.post("/:id/setup", async (c) => {
  const r = resolveVirtualBuyer(c.req.param("id"));
  if ("error" in r) return c.json({ error: r.error }, 400);
  const { ctx } = r;

  const body = await readJsonBody(c);
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
      timestamp: cxmlTimestamp(),
      deploymentMode: ctx.deploymentMode,
      operation: coerceOperation(body.operation) ?? ctx.eff.setupOperation,
      dtdVersion: dtdVersionFor(ctx.eff, "SetupRequest"),
      userAgent: ctx.eff.userAgent,
      extrinsics: setupExtrinsics(ctx, buyerCookie),
      ...setupAddresses(ctx),
      items: setupItems(body),
      selectedItem: selectedItem(body),
    });

  rememberSessionConnection(buyerCookie, ctx.connectionId);

  const reqValidation = validateDocument(xml, { expected: ctx.expected, forceDocType: "SetupRequest" });
  const reqLog = appendLog({
    sessionId: buyerCookie,
    connectionId: ctx.connectionId,
    direction: "out",
    docType: "SetupRequest",
    url: ctx.punchoutUrl,
    headers: { "Content-Type": "text/xml; charset=UTF-8" },
    body: xml,
    contentType: "text/xml",
    validation: reqValidation,
  });

  if (!ctx.punchoutUrl) return c.json({ error: "supplier has no punchoutUrl configured" }, 400);
  const res = await sendCxml(ctx.punchoutUrl, xml);
  const respValidation = res.error
    ? undefined
    : validateDocument(res.body, { expected: ctx.expected, forceDocType: "SetupResponse", http: { status: res.status, contentType: res.contentType, location: res.headers.location, url: ctx.punchoutUrl } });
  const respLog = appendLog({
    sessionId: buyerCookie,
    connectionId: ctx.connectionId,
    direction: "in",
    docType: "SetupResponse",
    status: res.status,
    url: ctx.punchoutUrl,
    headers: res.headers,
    body: res.error ? `<!-- transport error: ${res.error} -->` : res.body,
    contentType: res.contentType,
    validation: respValidation,
  });

  const startPage = res.error ? undefined : getStartPage(parseXml(res.body));
  const status = res.error ? undefined : getStatus(parseXml(res.body));

  const result: SetupResult = {
    buyerCookie,
    transportError: res.error,
    httpStatus: res.status,
    startPage,
    statusCode: status?.code,
    statusMessage: status?.message,
    request: reqLog,
    response: respLog,
  };
  return c.json(result);
});

// --- On-demand validation (validate-before-send) ------------------------------
// Validate the current (possibly hand-edited) cXML against its document rules,
// using the connection's expected credentials — without sending anything.
flowRoute.post("/:id/validate", async (c) => {
  const r = resolveVirtualBuyer(c.req.param("id"));
  if ("error" in r) return c.json({ error: r.error }, 400);
  const { ctx } = r;
  const body = await readJsonBody(c);
  const xml = String(body.xml ?? "");
  const docType = (body.docType as DocType) ?? "Unknown";
  return c.json(
    validateDocument(xml, {
      expected: ctx.expected,
      forceDocType: docType,
      allowMixedCurrency: ctx.allowMixedCurrency,
    }),
  );
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
  shipTo?: Address;
  billTo?: Address;
  contact?: Contact;
  /**
   * `update` or `delete` builds a change order / cancellation of the order this
   * session last sent: same orderID, the next orderVersion, and a
   * DocumentReference to that OrderRequest's payloadID.
   */
  orderType?: OrderType;
}

const coerceOrderType = (v: unknown): OrderType => (v === "update" || v === "delete" ? v : "new");

/** An OrderRequest this session already sent, as a later change must reference it. */
interface SentOrder {
  orderId?: string;
  payloadId?: string;
  orderVersion: number;
}

// The OrderRequests a session sent, oldest first, read back from its log (the
// payloadID survives secret redaction). An original order without an explicit
// orderVersion counts as version 1.
function sentOrders(sessionId: string, connectionId: string): SentOrder[] {
  const out: SentOrder[] = [];
  for (const r of readSession(sessionId)) {
    if (r.direction !== "out" || r.docType !== "OrderRequest" || r.connectionId !== connectionId) continue;
    const info = getOrderInfo(parseXml(r.body));
    const version = Number(info.orderVersion);
    out.push({ orderId: info.orderId, payloadId: info.payloadId, orderVersion: Number.isFinite(version) && info.orderVersion != null ? version : 1 });
  }
  return out;
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
  const type = coerceOrderType(body.orderType);
  // A change or cancellation continues the order this session last sent.
  const previous = type === "new" ? undefined : sentOrders(body.sessionId, ctx.connectionId).at(-1);
  if (type !== "new" && !previous) {
    throw new HTTPException(400, { message: "this session has not sent an OrderRequest yet — there is no order to change or cancel" });
  }
  const orderId = previous?.orderId || body.orderId || `PO-${nanoid(8)}`;
  // Shipping and tax: what the buyer computes itself wins; otherwise the order
  // carries what the supplier quoted with the cart. Tax is charged on the goods
  // (the Total), which excludes tax and shipping. A mixed-currency order has no
  // single Total to charge against, so it gets neither.
  const mixed = new Set(items.map((it) => it.currency || currency)).size > 1;
  const quoted = ctx.chargesInherited && body.sessionId ? getCart(body.sessionId) : undefined;
  const shipping: ChargeAmount | undefined = mixed
    ? undefined
    : ctx.shipping
      ? { amount: ctx.shipping.amount, currency, description: ctx.shipping.description }
      : quoted?.shipping;
  const tax = mixed ? undefined : ctx.tax ? computeTax(ctx.tax, total, currency) : quoted?.tax;
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
    orderDate: cxmlTimestamp(),
    payloadId: makePayloadId(host(), new Date().toISOString()),
    timestamp: cxmlTimestamp(),
    deploymentMode: ctx.deploymentMode,
    currency,
    total,
    items,
    // Order addresses default to the buyer's configured defaults when the body
    // doesn't override them (the UI pre-fills from the buyer, editable per order).
    shipTo: body.shipTo ?? ctx.shipTo,
    billTo: body.billTo ?? ctx.billTo,
    contact: body.contact ?? ctx.contact,
    addressMode: ctx.eff.addressMode,
    attachments: attMeta,
    dtdVersion: dtdVersionFor(ctx.eff, "OrderRequest"),
    userAgent: ctx.eff.userAgent,
    extrinsics: orderExtrinsics(ctx, orderId),
    shipping,
    tax,
    lineTax: !mixed && ctx.tax?.level === "lines" ? ctx.tax : undefined,
    accounting: ctx.accounting,
    type,
    orderVersion: previous ? previous.orderVersion + 1 : undefined,
    documentReferencePayloadId: previous?.payloadId,
  });
  return { xml, orderId };
}

// Preview the OrderRequest cXML (built from the cart + attachment plan) without
// sending it, so the user can edit Comments/anything before dispatch.
flowRoute.post("/:id/order/preview", async (c) => {
  const r = resolveVirtualBuyer(c.req.param("id"));
  if ("error" in r) return c.json({ error: r.error }, 400);
  const body = (await readJsonBody(c)) as OrderBody;
  const { xml, orderId } = buildOrderXml(r.ctx, body);
  return c.json({ xml, orderId });
});

flowRoute.post("/:id/order", async (c) => {
  const r = resolveVirtualBuyer(c.req.param("id"));
  if ("error" in r) return c.json({ error: r.error }, 400);
  const { ctx } = r;

  const body = (await readJsonBody(c)) as OrderBody;
  const sessionId = body.sessionId || `pos-${nanoid(16)}`;
  const dangling = !!body.danglingCid;
  const inputAtts = body.attachments ?? [];

  // Use the (possibly edited) XML the client sent, otherwise build it fresh.
  const xml = body.xml || buildOrderXml(ctx, body).xml;
  // Let a loopback mock supplier correlate the inbound order to this session.
  const sentOrderId = /<OrderRequestHeader[^>]*\borderID="([^"]*)"/.exec(xml)?.[1];
  if (sentOrderId) rememberOrderSession(sentOrderId, sessionId);

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

  // For a change order: the previous OrderRequest this session sent for the
  // same order (a re-send of the very same document is not its own predecessor).
  const sending = getOrderInfo(parseXml(xml));
  const earlier = sentOrders(sessionId, ctx.connectionId).filter(
    (o) => o.orderId === sending.orderId && o.payloadId !== sending.payloadId,
  );
  const reqValidation = validateDocument(xml, {
    expected: ctx.expected,
    forceDocType: "OrderRequest",
    availableContentIds: inputAtts.length > 0 ? availableContentIds : undefined,
    allowMixedCurrency: ctx.allowMixedCurrency,
    priorOrder: earlier.at(-1) ?? null,
  });

  const reqLog = appendLog({
    sessionId,
    connectionId: ctx.connectionId,
    direction: "out",
    docType: "OrderRequest",
    url: ctx.orderUrl,
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
    : validateDocument(res.body, { expected: ctx.expected, forceDocType: "OrderResponse", http: { status: res.status, contentType: res.contentType, location: res.headers.location, url: ctx.orderUrl } });
  const respLog = appendLog({
    sessionId,
    connectionId: ctx.connectionId,
    direction: "in",
    docType: "OrderResponse",
    status: res.status,
    url: ctx.orderUrl,
    headers: res.headers,
    body: res.error ? `<!-- transport error: ${res.error} -->` : res.body,
    contentType: res.contentType,
    validation: respValidation,
  });

  const status = res.error ? undefined : getStatus(parseXml(res.body));
  const result: OrderResult = {
    transportError: res.error,
    httpStatus: res.status,
    statusCode: status?.code,
    statusText: status?.text,
    statusMessage: status?.message,
    request: reqLog,
    response: respLog,
  };
  return c.json(result);
});
