import { Hono } from "hono";
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
import {
  buildPunchOutOrderMessage,
  buildResponseStatus,
  buildSetupResponse,
  cxmlTimestamp,
  escapeXml,
  makePayloadId,
  type OperationAllowed,
} from "../cxml/build.js";
import { getHeaderCredentials, getOrderInfo, parseSetupItems, parseXml, root, text, type SetupItems } from "../cxml/parse.js";
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
  { supplierPartId: "WIDGET-001", description: "Premium Steel Widget", unitPrice: 12.5, currency: "USD", uom: "EA", classifications: [{ domain: "UNSPSC", value: "31161500" }], manufacturerPartId: "MFR-W001", manufacturerName: "Acme Manufacturing" },
  { supplierPartId: "BOLT-250", description: "M8 Hex Bolt (pack of 250)", unitPrice: 34.0, currency: "USD", uom: "PK", classifications: [{ domain: "UNSPSC", value: "31161600" }], manufacturerPartId: "MFR-B250", manufacturerName: "Acme Manufacturing" },
  { supplierPartId: "TAPE-RED", description: "Industrial Marking Tape, Red", unitPrice: 5.75, currency: "USD", uom: "RL", classifications: [{ domain: "UNSPSC", value: "31201500" }] },
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
    from: r.buyer.identity,
    to: r.supplier.identity,
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

// --- 1. PunchOutSetupRequest in -> PunchOutSetupResponse out ------------------

simRoute.post("/:id/punchout", async (c) => {
  const supplier = getSupplier(c.req.param("id"));
  if (!supplier) return c.text("supplier not found", 404);

  const reqXml = await c.req.text();
  const doc = parseXml(reqXml);
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

// A normalized view of one row (a catalog item or a carried buyer-cart item).
interface RowView {
  description?: string;
  supplierPartId?: string;
  supplierPartAuxiliaryId?: string;
  uom?: string;
  currency?: string;
  price?: number;
  classifications?: { domain: string; value: string }[];
}
const catalogView = (it: CatalogItem): RowView => ({
  description: it.description,
  supplierPartId: it.supplierPartId,
  supplierPartAuxiliaryId: it.supplierPartAuxiliaryId,
  uom: it.uom,
  currency: it.currency,
  price: it.unitPrice,
  classifications: it.classifications,
});
const cartView = (it: CartItem): RowView => ({
  description: it.description,
  supplierPartId: it.supplierPartId,
  supplierPartAuxiliaryId: it.supplierPartAuxiliaryId,
  uom: it.uom,
  currency: it.currency,
  price: it.unitPriceAmount,
  classifications: it.classifications,
});

function rowLabelCells(v: RowView): string {
  const partId =
    escapeXml(v.supplierPartId ?? "") +
    (v.supplierPartAuxiliaryId ? ` / ${escapeXml(v.supplierPartAuxiliaryId)}` : "");
  const cls = (v.classifications ?? []).map((c) => `${escapeXml(c.domain)} ${escapeXml(c.value)}`).join(" · ");
  return `<td><strong>${escapeXml(v.description ?? "")}</strong><br><small>${partId} · ${escapeXml(v.uom ?? "")}${cls ? ` · ${cls}` : ""}</small></td>
      <td class="price">${escapeXml(v.currency ?? "")} ${(v.price ?? 0).toFixed(2)}</td>`;
}

// An editable quantity row. `fractional` controls the input step; `value` is the
// initial quantity (pre-filled from a carried edit cart, else 0).
function qtyRow(v: RowView, name: string, value: number, fractional: boolean, tag?: string): string {
  return `<tr>
      ${rowLabelCells(v)}
      <td><input type="number" name="${name}" value="${escapeXml(value)}" min="0" step="${fractional ? "any" : "1"}" inputmode="${fractional ? "decimal" : "numeric"}">${tag ? ` <span class="tag">${tag}</span>` : ""}</td>
    </tr>`;
}

// A read-only row (inspect): the quantity is shown but cannot be changed.
function readonlyRow(v: RowView, qty: number): string {
  return `<tr>
      ${rowLabelCells(v)}
      <td class="ro">${escapeXml(qty)}</td>
    </tr>`;
}

interface CatalogPageOpts {
  supplier: Supplier;
  banner: string;
  rows: string;
  submitLabel: string;
  cookie: string;
}

function catalogPage(o: CatalogPageOpts): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeXml(o.supplier.name)} — mock catalog</title>
<script>
  // Match the main app's theme. The app appends ?theme= to the catalog link
  // (works even when the SPA is on a different origin, e.g. the Vite dev server);
  // otherwise fall back to a same-origin 'pos-theme' in localStorage, then the OS
  // preference. Set before paint to avoid a flash.
  (function () {
    try {
      var q = new URLSearchParams(location.search).get("theme");
      var t = (q === "light" || q === "dark") ? q : localStorage.getItem("pos-theme");
      if (t !== "light" && t !== "dark") {
        t = (window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark";
      }
      document.documentElement.dataset.theme = t;
    } catch (e) {}
  })();
</script>
<style>
  :root{--bg:#0f172a;--text:#e2e8f0;--muted:#94a3b8;--panel:#1e293b;--th:#0b1220;--border:#334155;--field:#0b1220;--price:#fbbf24;--accent:#6366f1;--accent-hover:#4f46e5;--banner:#1e293b}
  :root[data-theme="light"]{--bg:#f5f7fb;--text:#1e293b;--muted:#4b5a73;--panel:#ffffff;--th:#eef1f7;--border:#d4dae8;--field:#ffffff;--price:#b45309;--accent:#6366f1;--accent-hover:#4f46e5;--banner:#eef1f7}
  body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);margin:0;padding:2rem}
  .wrap{max-width:720px;margin:0 auto}
  h1{font-size:1.4rem}.sub{color:var(--muted);margin-bottom:1.5rem}
  .banner{background:var(--banner);border:1px solid var(--border);border-left:4px solid var(--accent);border-radius:8px;padding:.7rem 1rem;margin-bottom:1.25rem;font-size:.95rem}
  .banner.inspect{border-left-color:var(--price)}
  table{width:100%;border-collapse:collapse;background:var(--panel);border-radius:12px;overflow:hidden}
  th,td{padding:.75rem 1rem;text-align:left;border-bottom:1px solid var(--border)}
  th{background:var(--th);font-size:.8rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
  .price{white-space:nowrap;color:var(--price)}
  .ro{color:var(--muted)}
  .tag{font-size:.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-left:.4rem}
  input[type=number]{width:5rem;background:var(--field);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:.35rem .5rem}
  button{margin-top:1.5rem;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:.7rem 1.4rem;font-size:1rem;cursor:pointer}
  button:hover{background:var(--accent-hover)}
  button.cancel{background:transparent;color:var(--muted);border:1px solid var(--border);margin-left:.6rem}
  button.cancel:hover{background:var(--panel);color:var(--text)}
</style></head><body><div class="wrap">
  <h1>${escapeXml(o.supplier.name)} <small>(virtual supplier)</small></h1>
  <div class="sub">Mock catalog served by punchout-simulator. Set quantities and return the cart.</div>
  ${o.banner}
  <form method="post" action="${escapeXml(`${getPublicUrl()}/sim/${encodeURIComponent(o.supplier.id)}/checkout`)}">
    <input type="hidden" name="cookie" value="${escapeXml(o.cookie)}">
    <table><thead><tr><th>Item</th><th>Price</th><th>Qty</th></tr></thead>
    <tbody>${o.rows}</tbody></table>
    <button type="submit">${escapeXml(o.submitLabel)}</button>
    <button type="submit" name="action" value="cancel" class="cancel" formnovalidate title="End the session without returning a cart (empty PunchOutOrderMessage, Status 204)">Cancel</button>
  </form>
</div></body></html>`;
}

simRoute.get("/:id/catalog", (c) => {
  const supplier = getSupplier(c.req.param("id"));
  if (!supplier) return c.text("supplier not found", 404);
  const cookie = c.req.query("cookie") ?? "";
  const items = catalogOf(supplier);
  const ctx = setupContextFor(cookie, supplier.id);
  const page = (banner: string, rows: string, submitLabel: string) =>
    c.html(catalogPage({ supplier, banner, rows, submitLabel, cookie }));

  // inspect: the buyer wants to view the carried item(s). Show them read-only and
  // return them unchanged. (Falls through to the catalog if none were carried.)
  if (ctx.operation === "inspect" && ctx.items.length > 0) {
    const rows = ctx.items.map((it) => readonlyRow(cartView(it), it.quantity)).join("\n");
    const banner = `<div class="banner inspect">Inspect — ${ctx.items.length} item(s), read-only. Returning the cart unchanged to the buyer.</div>`;
    return page(banner, rows, "Return to buyer →");
  }

  // create / edit. For edit, pre-fill quantities from the carried cart and add
  // any carried items the catalog doesn't list as extra editable rows.
  const isEdit = ctx.operation === "edit";
  const prefill = (it: CatalogItem): number =>
    isEdit ? (ctx.items.find((p) => sameProduct(p, it))?.quantity ?? 0) : 0;
  const catalogRows = items
    .map((it, i) => qtyRow(catalogView(it), `q_${i}`, prefill(it), !!it.allowFractional))
    .join("\n");

  const extras = isEdit ? ctx.items.filter((p) => !items.some((it) => sameProduct(p, it))) : [];
  const extraRows = extras
    .map((p, j) => qtyRow(cartView(p), `qx_${j}`, p.quantity, true, "from cart"))
    .join("\n");

  const banner = isEdit
    ? `<div class="banner edit">Edit — ${ctx.items.length} item(s) pre-loaded from the buyer's cart. Adjust quantities and return.</div>`
    : "";
  const rows = extraRows ? `${catalogRows}\n${extraRows}` : catalogRows;
  return page(banner, rows, "Return cart to buyer →");
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
  const xml = buildPunchOutOrderMessage({
    from: supplier.identity,
    to: buyerCred,
    sender: supplier.identity,
    buyerCookie: cookie,
    payloadId: makePayloadId(host(), new Date().toISOString()),
    timestamp: cxmlTimestamp(),
    currency,
    items,
    dtdVersion: eff ? dtdVersionFor(eff, "PunchOutOrderMessage") : undefined,
    operationAllowed: operationAllowedOf(supplier),
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

// The OrderResponse necessarily tells the sender whether its SharedSecret was
// accepted, which makes this endpoint a way to test guesses at a connection's
// secret. When the tool is exposed, bound that the same way as /api token
// guesses: a client that keeps sending a wrong secret is refused for the rest
// of the minute. (On a plain localhost run every client is the operator, and
// "send a bad secret" is a legitimate thing to test repeatedly.)
const wrongSecret = authThrottle();

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
  const message = ok
    ? accepted
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
