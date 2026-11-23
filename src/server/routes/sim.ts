import { identitiesOf } from "../cxml/types.js";
import { Hono, type Context } from "hono";
import { sessionForOrder } from "../cart-store.js";
import { nanoid } from "nanoid";
import {
  catalogForSupplier,
  dtdVersionFor,
  effectiveProfile,
  findConnectionBySupplierAndBuyerIdentity,
  getSupplier,
  type EffectiveProfile,
} from "../store/config.js";
import { appendLog, readSession } from "../store/log.js";
import { saveAttachment } from "../store/attachments.js";
import { getPublicUrl, getToken } from "../runtime.js";
import { authClientKey, authThrottle } from "../rate-limit.js";
import { resolveCharges } from "./charges.js";
import { catalogPage, rowMatches, type CatalogFocus, type CatalogRow } from "./catalog-page.js";
import {
  buildProfileResponse,
  buildPunchOutOrderMessage,
  buildResponseStatus,
  buildSetupResponse,
  computeTax,
  cxmlTimestamp,
  lineItemsTotal,
  escapeXml,
  makePayloadId,
  type OperationAllowed,
} from "../cxml/build.js";
import { getDocType, getHeaderCredentials, getOrderInfo, orderDeliveries, parseSetupItems, parseXml, root, text, type OrderDelivery, type ParsedDoc, type SetupItems } from "../cxml/parse.js";
import {
  isMultipart,
  normalizeContentId,
  parseMultipartRelated,
} from "../cxml/multipart.js";
import { validateDocument, type ExpectedCredentials } from "../cxml/validate.js";
import type { AttachmentEncoding, AttachmentRef, CartItem, CatalogItem, Credential, ProfileTransaction, Supplier } from "../cxml/types.js";

// Mode B (virtual-supplier / mock catalog) — spec sections 4, 10, 14. Endpoints
// are keyed by SUPPLIER id, because the PunchOut/Order URLs are intrinsic to the
// supplier (constant across every buyer). The buyer is discovered at runtime
// from the inbound From credential; a matching Connection (if any) supplies the
// expected shared secret for validation.

export const simRoute = new Hono();

const DEMO_CATALOG: CatalogItem[] = [
  { supplierPartId: "WIDGET-001", description: "Premium Steel Widget", unitPrice: 12.5, currency: "USD", uom: "EA", classifications: [{ domain: "UNSPSC", value: "31161500" }], manufacturerPartId: "MFR-W001", manufacturerName: "Acme Manufacturing" },
  { supplierPartId: "BOLT-250", description: "M8 Hex Bolt (pack of 250)", unitPrice: 34.0, currency: "USD", uom: "XPK", classifications: [{ domain: "UNSPSC", value: "31161600" }], manufacturerPartId: "MFR-B250", manufacturerName: "Acme Manufacturing" },
  { supplierPartId: "TAPE-RED", description: "Industrial Marking Tape, Red", unitPrice: 5.75, currency: "USD", uom: "XRL", classifications: [{ domain: "UNSPSC", value: "31201500" }] },
];

function host(): string {
  try {
    return new URL(getPublicUrl()).host;
  } catch {
    return "punchout-simulator";
  }
}

// The supplier's served catalog: the union of its assigned product lists, or the
// built-in demo catalog when it references none (or they resolve empty).
const catalogOf = (s: Supplier): CatalogItem[] => {
  const items = catalogForSupplier(s);
  return items.length > 0 ? items : DEMO_CATALOG;
};

// What a session's PunchOutSetupRequest established: the operation and carried
// items (edit/inspect), where the cart goes back to, and who the buyer is.
interface SetupContext extends SetupItems {
  /** False when no SetupRequest for this cookie + supplier is on record. */
  found: boolean;
  /** The buyer's BrowserFormPost URL (http/https only), or "". */
  formPost: string;
  /** The buyer's From credential(s) — one organization, possibly in several domains. */
  buyerAll: Credential[];
}

const NO_SETUP: SetupContext = {
  found: false,
  operation: "create",
  items: [],
  formPost: "",
  buyerAll: [],
};

// The operation the mock supplier allows on the carts it returns. It can reopen
// carts, so the honest default is "edit"; a supplier can be configured lower to
// test that the buyer respects it.
const operationAllowedOf = (s: Supplier): OperationAllowed => s.operationAllowed ?? "edit";

// Which of the buyer's credentials to address a reply to: the one a configured
// connection knows, else the first one sent.
function buyerCredential(supplierId: string, all: Credential[]): Credential {
  const known = findConnectionBySupplierAndBuyerIdentity(supplierId, all)?.buyer.identity;
  return known ?? all[0] ?? { domain: "", identity: "" };
}

// Re-parsed from the latest inbound PunchOutSetupRequest this supplier logged
// for the session. The append-only log is the source of truth, so the catalog
// GET and the checkout POST recompute the same thing (no extra mutable server
// state). In particular the return URL and buyer identity come from here and
// NOT from the catalog link or the checkout form: those are in the hands of
// whoever opens the page, and a crafted link could otherwise make the catalog
// post the cart to an arbitrary site.
function setupContextFor(cookie: string, supplierId: string): SetupContext {
  if (!cookie) return NO_SETUP;
  const records = readSession(cookie);
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.direction === "in" && r.docType === "SetupRequest" && r.connectionId === supplierId) {
      const doc = parseXml(r.body);
      return {
        found: true,
        ...parseSetupItems(doc),
        formPost: safeHttpUrl(text(root(doc)?.Request?.PunchOutSetupRequest?.BrowserFormPost?.URL)),
        buyerAll: getHeaderCredentials(doc).fromAll,
      };
    }
  }
  return NO_SETUP;
}

// Two cart lines refer to the same product when their SupplierPartID (and aux id,
// when present) match — used to merge a carried edit cart onto the catalog.
function sameProduct(a: { supplierPartId?: string; supplierPartAuxiliaryId?: string }, b: { supplierPartId?: string; supplierPartAuxiliaryId?: string }): boolean {
  return (
    !!a.supplierPartId &&
    a.supplierPartId === b.supplierPartId &&
    (a.supplierPartAuxiliaryId ?? "") === (b.supplierPartAuxiliaryId ?? "")
  );
}

// The BrowserFormPost URL is buyer-supplied and later rendered as an
// auto-submitted <form action>; reject non-http(s) schemes to avoid XSS.
function safeHttpUrl(u: string | undefined): string {
  if (!u) return "";
  try {
    const p = new URL(u.trim());
    // Return the *normalized* href (percent-encodes <, >, " etc.) — not the raw
    // input — so the value is safe to embed in an HTML attribute or a <script>.
    return p.protocol === "http:" || p.protocol === "https:" ? p.href : "";
  } catch {
    return "";
  }
}

// JSON safe to embed inside an inline <script>: JSON.stringify does NOT escape
// </script> or the U+2028/U+2029 line separators, so we escape them ourselves.
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// Build the expected-credentials context for validating an inbound document,
// from a connection matching this supplier + the inbound buyer identity.
function expectedFor(supplierId: string, from: Credential | Credential[] | undefined): ExpectedCredentials | undefined {
  const r = findConnectionBySupplierAndBuyerIdentity(supplierId, from);
  if (!r) return undefined;
  return {
    from: identitiesOf(r.buyer),
    to: identitiesOf(r.supplier),
    sender: r.connection.senderIdentity ?? r.buyer.identity,
    sharedSecret: r.connection.sharedSecret,
  };
}

// Effective platform profile of the buyer talking to this supplier (if a
// matching connection exists). Lets the mock supplier mirror the buyer's
// platform when emitting its responses/punchback (DTD version, cart transport).
function effFor(supplierId: string, from: Credential | Credential[] | undefined): EffectiveProfile | undefined {
  const r = findConnectionBySupplierAndBuyerIdentity(supplierId, from);
  return r ? effectiveProfile(r.connection, r.buyer) : undefined;
}

// The SharedSecret check answers "was this secret right?", which makes any
// endpoint that performs it a way to test guesses at a connection's secret.
// When the tool is exposed, bound that the same way as /api token guesses: a
// client that keeps sending a wrong secret is refused for the rest of the
// minute. (On a plain localhost run every client is the operator, and "send a
// bad secret" is a legitimate thing to test repeatedly.)
const wrongSecret = authThrottle();

// --- 0. ProfileRequest in -> ProfileResponse out --------------------------------
//
// "The Profile transaction is the only transaction that all cXML servers must
// support", and it doubles as a ping. The answer lists the requests this
// supplier accepts and where to send them. A hub posts the request to whatever
// URL it knows for the supplier, so besides the dedicated /profile endpoint the
// punchout and order endpoints answer it too.

function profileOf(supplier: Supplier): ProfileTransaction[] {
  const base = `${getPublicUrl()}/sim/${encodeURIComponent(supplier.id)}`;
  // operationAllowed here mirrors what the supplier grants on returned carts.
  const granted = operationAllowedOf(supplier);
  const operations = granted === "edit" ? "create inspect edit" : granted === "inspect" ? "create inspect" : "create";
  return [
    { requestName: "ProfileRequest", url: `${base}/profile`, options: [] },
    { requestName: "PunchOutSetupRequest", url: `${base}/punchout`, options: [{ name: "operationAllowed", value: operations }] },
    // "When OrderRequest is returned as a supported transaction, two options
    // must be specified: attachments and changes." The mock accepts both.
    { requestName: "OrderRequest", url: `${base}/order`, options: [{ name: "attachments", value: "Yes" }, { name: "changes", value: "Yes" }] },
  ];
}

async function answerProfileRequest(c: Context, supplier: Supplier, reqXml: string, doc: ParsedDoc): Promise<Response> {
  const exposed = !!getToken();
  const client = authClientKey(c);
  const wait = exposed ? wrongSecret.blockedFor(client) : 0;
  if (wait > 0) {
    c.header("Retry-After", String(wait));
    return c.text("too many requests with a wrong SharedSecret — wait and retry", 429);
  }

  const from = getHeaderCredentials(doc).fromAll;
  const eff = effFor(supplier.id, from);
  const sessionId = `profile-${nanoid(10)}`;
  const validation = validateDocument(reqXml, {
    expected: expectedFor(supplier.id, from),
    forceDocType: "ProfileRequest",
    expectedDtdVersion: eff ? dtdVersionFor(eff, "SetupRequest") : undefined,
  });
  appendLog({
    sessionId,
    connectionId: supplier.id,
    direction: "in",
    docType: "ProfileRequest",
    url: c.req.url,
    headers: { "Content-Type": c.req.header("content-type") ?? "" },
    body: reqXml,
    validation,
  });
  const wrong = validation.issues.some((i) => i.code === "sharedsecret-mismatch");
  if (exposed && wrong) wrongSecret.recordFailure(client);

  const dtdVersion = eff ? dtdVersionFor(eff, "SetupResponse") : undefined;
  const firstError = validation.issues.find((i) => i.severity === "error")?.message;
  const respXml = validation.ok
    ? buildProfileResponse({
        payloadId: makePayloadId(host(), new Date().toISOString()),
        timestamp: cxmlTimestamp(),
        // "When these services were first available" — the supplier's creation.
        effectiveDate: cxmlTimestamp(new Date(supplier.createdAt)),
        transactions: profileOf(supplier),
        dtdVersion,
      })
    : buildResponseStatus({
        payloadId: makePayloadId(host(), new Date().toISOString()),
        timestamp: cxmlTimestamp(),
        statusCode: wrong ? "401" : "400",
        statusText: wrong ? "Unauthorized" : "Bad Request",
        message: firstError,
        dtdVersion,
      });
  appendLog({
    sessionId,
    connectionId: supplier.id,
    direction: "out",
    docType: "ProfileResponse",
    url: c.req.url,
    headers: { "Content-Type": "text/xml; charset=UTF-8" },
    body: respXml,
    validation: validateDocument(respXml, { forceDocType: "ProfileResponse" }),
  });
  c.header("Content-Type", "text/xml; charset=UTF-8");
  return c.body(respXml, validation.ok ? 200 : wrong ? 401 : 400);
}

simRoute.post("/:id/profile", async (c) => {
  const supplier = getSupplier(c.req.param("id"));
  if (!supplier) return c.text("supplier not found", 404);
  const reqXml = await c.req.text();
  return answerProfileRequest(c, supplier, reqXml, parseXml(reqXml));
});

// --- 1. PunchOutSetupRequest in -> PunchOutSetupResponse out ------------------

simRoute.post("/:id/punchout", async (c) => {
  const supplier = getSupplier(c.req.param("id"));
  if (!supplier) return c.text("supplier not found", 404);

  const reqXml = await c.req.text();
  const doc = parseXml(reqXml);
  if (doc.wellFormed && getDocType(doc) === "ProfileRequest") return answerProfileRequest(c, supplier, reqXml, doc);
  const reqRoot = root(doc)?.Request?.PunchOutSetupRequest;
  const buyerCookie = text(reqRoot?.BuyerCookie) || `pos-${nanoid(16)}`;
  const from = getHeaderCredentials(doc).fromAll;
  const eff = effFor(supplier.id, from);

  appendLog({
    sessionId: buyerCookie,
    connectionId: supplier.id,
    direction: "in",
    docType: "SetupRequest",
    url: c.req.url,
    headers: { "Content-Type": c.req.header("content-type") ?? "" },
    body: reqXml,
    validation: validateDocument(reqXml, {
      expected: expectedFor(supplier.id, from),
      forceDocType: "SetupRequest",
      expectedDtdVersion: eff ? dtdVersionFor(eff, "SetupRequest") : undefined,
      supplierOperationAllowed: operationAllowedOf(supplier),
    }),
  });

  // The StartPage carries only the BuyerCookie; everything else about the
  // session is read back from the SetupRequest just logged (setupContextFor).
  const startPageUrl = `${getPublicUrl()}/sim/${encodeURIComponent(supplier.id)}/catalog?cookie=${encodeURIComponent(buyerCookie)}`;

  const respXml = buildSetupResponse({
    payloadId: makePayloadId(host(), new Date().toISOString()),
    timestamp: cxmlTimestamp(),
    startPageUrl,
    dtdVersion: eff ? dtdVersionFor(eff, "SetupResponse") : undefined,
  });
  appendLog({
    sessionId: buyerCookie,
    connectionId: supplier.id,
    direction: "out",
    docType: "SetupResponse",
    url: c.req.url,
    headers: { "Content-Type": "text/xml; charset=UTF-8" },
    body: respXml,
    validation: validateDocument(respXml, { forceDocType: "SetupResponse" }),
  });

  c.header("Content-Type", "text/xml; charset=UTF-8");
  return c.body(respXml);
});

// --- 2. Catalog UI ------------------------------------------------------------
//
// The page itself lives in catalog-page.ts; this builds its lines from the
// supplier's catalog and, for edit / inspect, from the cart the buyer carried in.

const classificationLabel = (list?: { domain: string; value: string }[]): string | undefined =>
  list && list.length > 0 ? list.map((c) => `${c.domain} ${c.value}`).join(", ") : undefined;

const catalogRow = (it: CatalogItem, field: string, quantity: number): CatalogRow => ({
  field,
  description: it.description ?? "",
  partId: it.supplierPartId ?? "",
  auxId: it.supplierPartAuxiliaryId,
  manufacturer: it.manufacturerName,
  uom: it.uom ?? "EA",
  currency: it.currency ?? "USD",
  price: it.unitPrice ?? 0,
  classification: classificationLabel(it.classifications),
  quantity,
  fractional: !!it.allowFractional,
});

// A line taken from the buyer's cart rather than from this catalog.
const carriedRow = (it: CartItem, field: string | undefined, tag?: string): CatalogRow => ({
  field,
  description: it.description ?? "",
  partId: it.supplierPartId ?? "",
  auxId: it.supplierPartAuxiliaryId,
  manufacturer: it.manufacturerName,
  uom: it.uom ?? "EA",
  currency: it.currency ?? "USD",
  price: it.unitPriceAmount ?? 0,
  classification: classificationLabel(it.classifications),
  quantity: it.quantity,
  fractional: true,
  tag,
});

simRoute.get("/:id/catalog", (c) => {
  const supplier = getSupplier(c.req.param("id"));
  if (!supplier) return c.text("supplier not found", 404);
  const cookie = c.req.query("cookie") ?? "";
  const items = catalogOf(supplier);
  const ctx = setupContextFor(cookie, supplier.id);

  // The charges this buyer will be quoted, so the cart can show them before
  // the cart is returned (the same resolution the checkout uses).
  const charges = resolveCharges(findConnectionBySupplierAndBuyerIdentity(supplier.id, ctx.buyerAll)?.connection.cartCharges, {
    tax: supplier.cartTax,
    shipping: supplier.cartShipping,
  });
  const buyer = ctx.found ? buyerCredential(supplier.id, ctx.buyerAll) : undefined;
  const page = (operation: string, rows: CatalogRow[], focus?: CatalogFocus) =>
    c.html(
      catalogPage({
        focus,
        supplierName: supplier.name,
        checkoutUrl: `${getPublicUrl()}/sim/${encodeURIComponent(supplier.id)}/checkout`,
        cookie,
        operation,
        hasSession: ctx.found,
        buyerLabel: buyer?.identity ? `${buyer.domain} ${buyer.identity}`.trim() : undefined,
        rows,
        quote: {
          taxRatePercent: charges.tax?.ratePercent,
          taxLabel: charges.tax?.description,
          shippingAmount: charges.shipping?.amount,
          shippingLabel: charges.shipping?.description,
        },
      }),
    );

  // inspect: the buyer wants to look at the carried item(s). They are shown
  // read-only, and nothing is sent back. (Falls through to the catalog if none
  // were carried.)
  if (ctx.operation === "inspect" && ctx.items.length > 0) {
    return page("inspect", ctx.items.map((it) => carriedRow(it, undefined)));
  }

  // create / edit. For edit, pre-fill quantities from the carried cart and add
  // any carried items the catalog doesn't list as extra editable lines.
  const isEdit = ctx.operation === "edit";
  const prefill = (it: CatalogItem): number =>
    isEdit ? (ctx.items.find((p) => sameProduct(p, it))?.quantity ?? 0) : 0;
  const extras = isEdit ? ctx.items.filter((p) => !items.some((it) => sameProduct(p, it))) : [];
  const rows = items.map((it, i) => catalogRow(it, `q_${i}`, prefill(it)));

  // Level 2 PunchOut. "PunchOut sites can use [SelectedItem] to determine which
  // products to display"; what an item ID stands for is the supplier's call. An
  // ID that is one of this catalog's part numbers opens on that product; one
  // that matches several products (a shared prefix, a maker, a classification
  // code) opens on those — an aisle; anything else gets the whole store, with a
  // note that the item was not found.
  let focus: CatalogFocus | undefined;
  const selected = ctx.selectedItem;
  if (selected) {
    const label = selected.supplierPartAuxiliaryId ? `${selected.supplierPartId} / ${selected.supplierPartAuxiliaryId}` : selected.supplierPartId;
    const exact = rows.filter(
      (r) => r.partId === selected.supplierPartId && (!selected.supplierPartAuxiliaryId || r.auxId === selected.supplierPartAuxiliaryId),
    );
    if (exact.length > 0) {
      for (const r of exact) r.focused = true;
      focus = { level: "product", label, term: selected.supplierPartId, matches: exact.length };
    } else {
      const matches = rows.filter((r) => rowMatches(r, selected.supplierPartId)).length;
      focus = matches > 0 ? { level: "aisle", label, term: selected.supplierPartId, matches } : { level: "none", label, term: "", matches: 0 };
    }
  }
  return page(isEdit ? "edit" : "create", [...rows, ...extras.map((p, j) => carriedRow(p, `qx_${j}`, "from cart"))], focus);
});

// --- 3. Checkout -> auto-submit punchback ------------------------------------

simRoute.post("/:id/checkout", async (c) => {
  const supplier = getSupplier(c.req.param("id"));
  if (!supplier) return c.text("supplier not found", 404);

  const form = await c.req.parseBody();
  // A legitimate checkout always carries the BuyerCookie from the StartPage. A
  // cookie-less POST (a stray/direct hit) must NOT mint a phantom session — that
  // produced floods of empty punchback sessions. Require it.
  const cookie = typeof form.cookie === "string" ? form.cookie.trim() : "";
  if (!cookie) {
    return c.text("missing BuyerCookie — open the catalog from a SetupResponse StartPage", 400);
  }
  const catalog = catalogOf(supplier);
  const ctx = setupContextFor(cookie, supplier.id);
  // The cart can only go back to the BrowserFormPost URL the buyer's own
  // SetupRequest named; a session we never saw a setup for has nowhere to go.
  if (!ctx.found) {
    return c.text("no PunchOutSetupRequest is on record for this BuyerCookie — start from a SetupResponse StartPage", 400);
  }
  if (!ctx.formPost) {
    return c.text("the PunchOutSetupRequest for this session carried no http(s) BrowserFormPost URL, so there is nowhere to return the cart", 400);
  }
  const formpost = ctx.formPost;
  const buyerCred = buyerCredential(supplier.id, ctx.buyerAll);
  // "Cancel" ends the session without change: an empty PunchOutOrderMessage
  // with Status 204 (Reference Guide, "Cancelling PunchOut").
  const cancelled = form.action === "cancel";

  let items: CartItem[] = [];
  if (cancelled || ctx.operation === "inspect") {
    // Nothing goes back. For inspect the standard is explicit: "The supplier
    // site should return no ItemIn elements" — the buyer must ignore the item
    // list of an inspect session anyway.
  } else {
    catalog.forEach((it, i) => {
      let qty = Number(form[`q_${i}`] ?? 0);
      // Mirror the input's step server-side: whole numbers unless the item opts in.
      if (!it.allowFractional) qty = Math.floor(qty);
      if (qty > 0) {
        items.push({
          quantity: qty,
          supplierPartId: it.supplierPartId,
          supplierPartAuxiliaryId: it.supplierPartAuxiliaryId,
          description: it.description,
          uom: it.uom,
          unitPriceAmount: it.unitPrice,
          currency: it.currency,
          classifications: it.classifications,
          // Keep the legacy single fields populated from the first classification
          // for back-compat display (CartView) and any single-domain consumer.
          classificationDomain: it.classifications[0]?.domain,
          classification: it.classifications[0]?.value,
          manufacturerPartId: it.manufacturerPartId,
          manufacturerName: it.manufacturerName,
        });
      }
    });
    // Carried edit-cart items the catalog doesn't list: same set/order as the
    // catalog's extra rows (recomputed from the log), with quantities from the form.
    if (ctx.operation === "edit") {
      const extras = ctx.items.filter((p) => !catalog.some((it) => sameProduct(p, it)));
      extras.forEach((p, j) => {
        const qty = Number(form[`qx_${j}`] ?? p.quantity);
        if (qty > 0) items.push({ ...p, quantity: qty });
      });
    }
  }

  const currency = items[0]?.currency ?? "USD";
  const eff = effFor(supplier.id, buyerCred);
  // Shipping and tax "computed on the remote website", quoted in the header
  // beside a Total that excludes them. Only for a cart that has goods in one
  // currency: an empty or mixed-currency cart has nothing to charge against.
  // Which charges this buyer gets is a per-customer decision: the connection
  // for this buyer overrides the supplier's defaults (some buyers want no tax
  // in the cart at all).
  const goods = lineItemsTotal(items, currency);
  const chargeable = items.length > 0 && goods > 0;
  const quote = resolveCharges(findConnectionBySupplierAndBuyerIdentity(supplier.id, ctx.buyerAll)?.connection.cartCharges, {
    tax: supplier.cartTax,
    shipping: supplier.cartShipping,
  });
  const shipping =
    chargeable && quote.shipping ? { amount: quote.shipping.amount, currency, description: quote.shipping.description } : undefined;
  const tax = chargeable && quote.tax ? computeTax(quote.tax, goods, currency) : undefined;
  const xml = buildPunchOutOrderMessage({
    from: identitiesOf(supplier),
    to: buyerCred,
    sender: supplier.identity,
    buyerCookie: cookie,
    payloadId: makePayloadId(host(), new Date().toISOString()),
    timestamp: cxmlTimestamp(),
    currency,
    items,
    dtdVersion: eff ? dtdVersionFor(eff, "PunchOutOrderMessage") : undefined,
    operationAllowed: operationAllowedOf(supplier),
    shipping,
    tax,
    status: cancelled ? { code: "204", text: "No Content" } : undefined,
  });

  appendLog({
    sessionId: cookie,
    connectionId: supplier.id,
    direction: "out",
    docType: "PunchOutOrderMessage",
    url: formpost || undefined,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: xml,
    validation: validateDocument(xml, {
      forceDocType: "PunchOutOrderMessage",
      allowMixedCurrency: supplier.allowMixedCurrency,
      setupOperation: ctx.operation,
    }),
  });

  // The buyer's platform dictates how the browser returns the cart. Default
  // (and <noscript> fallback) is the urlencoded hidden field; base64 swaps the
  // field; raw POSTs the cXML as a text/xml body (needs JS — a plain form can't).
  const transport = eff?.cartReturnTransport ?? "cxml-urlencoded";
  return c.html(cartReturnPage(formpost, xml, transport));
});

// Build the auto-submit page that returns the punchback to the buyer's callback.
function cartReturnPage(
  formpost: string,
  xml: string,
  transport: "cxml-urlencoded" | "cxml-base64" | "raw",
): string {
  const shell = (inner: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Returning cart…</title></head>
<body style="font-family:system-ui;background:#0f172a;color:#e2e8f0">
  <p style="padding:2rem">Returning cart to the buyer…</p>
${inner}
</body></html>`;

  if (transport === "raw") {
    // No <input> can carry a raw text/xml body from a form, so post via fetch
    // and fall back to a urlencoded form for no-JS clients.
    return shell(`  <form method="post" action="${escapeXml(formpost)}">
    <input type="hidden" name="cxml-urlencoded" value="${escapeXml(xml)}">
    <noscript><button type="submit">Continue</button></noscript>
  </form>
  <script>
    fetch(${jsonForScript(formpost)}, { method: "POST",
      headers: { "Content-Type": "text/xml; charset=UTF-8" },
      body: ${jsonForScript(xml)} })
      .then(function () {
        document.body.replaceChildren();
        var p = document.createElement("p");
        p.style.padding = "2rem";
        p.textContent = "Cart returned to the buyer. You can close this tab.";
        document.body.appendChild(p);
      })
      .catch(function () { document.forms[0].submit(); });
  </script>`);
  }

  const field = transport === "cxml-base64" ? "cxml-base64" : "cxml-urlencoded";
  const value = transport === "cxml-base64" ? Buffer.from(xml, "utf8").toString("base64") : xml;
  return shell(`  <form method="post" action="${escapeXml(formpost)}">
    <input type="hidden" name="${field}" value="${escapeXml(value)}">
    <noscript><button type="submit">Continue</button></noscript>
  </form>
  <script>document.forms[0].submit()</script>`);
}

// --- 4. OrderRequest in -> OrderResponse out ----------------------------------

simRoute.post("/:id/order", async (c) => {
  const supplier = getSupplier(c.req.param("id"));
  if (!supplier) return c.text("supplier not found", 404);

  const exposed = !!getToken();
  const client = authClientKey(c);
  const wait = exposed ? wrongSecret.blockedFor(client) : 0;
  if (wait > 0) {
    c.header("Retry-After", String(wait));
    return c.text("too many OrderRequests with a wrong SharedSecret — wait and retry", 429);
  }

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
  if (doc.wellFormed && getDocType(doc) === "ProfileRequest") return answerProfileRequest(c, supplier, xml, doc);
  const from = getHeaderCredentials(doc).fromAll;
  const sessionId = findSessionForOrder(doc) ?? `order-${nanoid(8)}`;
  const eff = effFor(supplier.id, from);
  // What this supplier already holds for the order: a change or cancellation
  // must reference the most recent OrderRequest for it.
  const order = getOrderInfo(doc);
  const history = orderHistory(sessionId, supplier.id, order.orderId);

  const validation = validateDocument(xml, {
    expected: expectedFor(supplier.id, from),
    forceDocType: "OrderRequest",
    availableContentIds: isMultipart(ct) ? availableContentIds : undefined,
    allowMixedCurrency: supplier.allowMixedCurrency,
    expectedDtdVersion: eff ? dtdVersionFor(eff, "OrderRequest") : undefined,
    priorOrder: history.prior,
  });

  appendLog({
    sessionId,
    connectionId: supplier.id,
    direction: "in",
    docType: "OrderRequest",
    url: c.req.url,
    headers: { "Content-Type": ct },
    body: xml,
    contentType: ct,
    validation,
    attachments: savedRefs,
    attachmentEncoding,
  });

  if (exposed && validation.issues.some((i) => i.code === "sharedsecret-mismatch")) {
    wrongSecret.recordFailure(client);
  }

  const ok = validation.ok;
  // Real suppliers acknowledge with their own order number and echo the PO in
  // the Status body — that is the line a buyer's integrator looks for, so the
  // mock does the same (and names the first error when it rejects). A change or
  // cancellation keeps the number the original order was acknowledged with.
  const poNumber = order.orderId;
  const forPo = poNumber ? ` for PO ${poNumber}` : "";
  const soNumber = order.type === "new" ? supplierOrderNumber() : (history.supplierOrderNumber ?? supplierOrderNumber());
  const firstError = validation.issues.find((i) => i.severity === "error")?.message;
  const accepted =
    order.type === "update"
      ? `OK. Order number ${soNumber} updated${order.orderVersion ? ` to version ${order.orderVersion}` : ""}${forPo}.`
      : order.type === "delete"
        ? `OK. Order number ${soNumber} cancelled${forPo}.`
        : `OK. Order number ${soNumber} received${forPo}.`;
  // A supplier that is given a delivery schedule plans against it, so the
  // acknowledgement says what it understood: how many deliveries, over which
  // dates. A cancelled order has nothing left to deliver.
  const plan = order.type === "delete" ? "" : deliveryPlan(orderDeliveries(doc));
  const message = ok
    ? `${accepted}${plan}`
    : `Bad Request. Order rejected${poNumber ? ` (PO ${poNumber})` : ""}${firstError ? `: ${firstError}` : "."}`;
  const respXml = buildResponseStatus({
    payloadId: makePayloadId(host(), new Date().toISOString()),
    timestamp: cxmlTimestamp(),
    statusCode: ok ? "200" : "400",
    statusText: ok ? "OK" : "Bad Request",
    message,
    dtdVersion: eff ? dtdVersionFor(eff, "OrderResponse") : undefined,
  });
  appendLog({
    sessionId,
    connectionId: supplier.id,
    direction: "out",
    docType: "OrderResponse",
    url: c.req.url,
    headers: { "Content-Type": "text/xml; charset=UTF-8" },
    body: respXml,
    validation: validateDocument(respXml, { forceDocType: "OrderResponse" }),
  });

  c.header("Content-Type", "text/xml; charset=UTF-8");
  return c.body(respXml, ok ? 200 : 400);
});

// The earlier exchanges this supplier logged for an order: the most recent
// OrderRequest (what an update/delete must reference) and the supplier order
// number it was acknowledged with.
function orderHistory(
  sessionId: string,
  supplierId: string,
  orderId: string | undefined,
): { prior: { payloadId?: string; orderVersion?: number } | null; supplierOrderNumber?: string } {
  if (!orderId) return { prior: null };
  let prior: { payloadId?: string; orderVersion?: number } | null = null;
  let supplierOrderNumber: string | undefined;
  for (const r of readSession(sessionId)) {
    if (r.connectionId !== supplierId) continue;
    if (r.direction === "in" && r.docType === "OrderRequest") {
      const info = getOrderInfo(parseXml(r.body));
      if (info.orderId !== orderId) continue;
      const version = info.orderVersion == null ? undefined : Number(info.orderVersion);
      // An original order without an explicit version is version 1.
      prior = { payloadId: info.payloadId, orderVersion: Number.isFinite(version) ? version : info.type === "new" ? 1 : undefined };
    } else if (r.direction === "out" && r.docType === "OrderResponse") {
      supplierOrderNumber = /\b(SO-[A-Z0-9]{8})\b/.exec(r.body)?.[1] ?? supplierOrderNumber;
    }
  }
  return { prior, supplierOrderNumber };
}

// "Delivery plan: 3 deliveries, 2026-12-01 to 2026-12-15." — the schedule the
// order asked for, read back the way an order desk would confirm it.
function deliveryPlan(deliveries: OrderDelivery[]): string {
  if (deliveries.length === 0) return "";
  const day = (d: string) => (/^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : d);
  const first = day(deliveries[0].date);
  const last = day(deliveries[deliveries.length - 1].date);
  const lines = new Set(deliveries.map((d) => d.line)).size;
  const span = first === last ? `on ${first}` : `${first} to ${last}`;
  const count = `${deliveries.length} ${deliveries.length === 1 ? "delivery" : "deliveries"}`;
  // A date that has already passed cannot be met; say so rather than accept silently.
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const late = deliveries.filter((d) => {
    const t = Date.parse(d.date);
    return !Number.isNaN(t) && t < startOfToday.getTime();
  }).length;
  const overdue = late > 0 ? ` ${late} of them ${late === 1 ? "is" : "are"} requested for a date already past and will ship as soon as possible.` : "";
  return ` Delivery plan: ${count} for ${lines} ${lines === 1 ? "line" : "lines"}, ${span}.${overdue}`;
}

function orderIdOf(doc: ReturnType<typeof parseXml>): string | undefined {
  const orderId = root(doc)?.Request?.OrderRequest?.OrderRequestHeader?.["@_orderID"];
  return orderId == null ? undefined : String(orderId);
}

// cXML OrderRequest has no BuyerCookie: when this tool sent the order itself
// (loopback demo) file it under that buyer session, otherwise group by orderID.
function findSessionForOrder(doc: ReturnType<typeof parseXml>): string | undefined {
  const orderId = orderIdOf(doc);
  if (!orderId) return undefined;
  return sessionForOrder(orderId) ?? `order-${orderId}`;
}

// A supplier-side sales-order number, distinct from the buyer's PO on purpose.
const supplierOrderNumber = () => `SO-${nanoid(8).toUpperCase().replace(/[^A-Z0-9]/g, "X")}`;
