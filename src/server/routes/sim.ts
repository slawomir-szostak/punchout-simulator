import { Hono } from "hono";
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
import { getPublicUrl } from "../runtime.js";
import {
  buildPunchOutOrderMessage,
  buildResponseStatus,
  buildSetupResponse,
  escapeXml,
  makePayloadId,
} from "../cxml/build.js";
import { getHeaderCredentials, parseSetupItems, parseXml, root, text, type SetupItems } from "../cxml/parse.js";
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

// The edit/inspect state of a session: re-parsed from the latest inbound
// PunchOutSetupRequest in the session log. The append-only log is the source of
// truth, so both the catalog GET and the checkout POST recompute the same thing
// (no extra mutable server state). A `create` setup carries no items.
function setupContextFor(cookie: string): SetupItems {
  if (!cookie) return { operation: "create", items: [] };
  const records = readSession(cookie);
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.direction === "in" && r.docType === "SetupRequest") {
      return parseSetupItems(parseXml(r.body));
    }
  }
  return { operation: "create", items: [] };
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
function expectedFor(supplierId: string, from: Credential | undefined): ExpectedCredentials | undefined {
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
function effFor(supplierId: string, from: Credential | undefined): EffectiveProfile | undefined {
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

  const eff = effFor(supplier.id, from);
  const respXml = buildSetupResponse({
    payloadId: makePayloadId(host(), new Date().toISOString()),
    timestamp: new Date().toISOString(),
    startPageUrl,
    from: supplier.identity,
    to: buyerCred,
    sender: supplier.identity,
    dtdVersion: eff ? dtdVersionFor(eff, "SetupResponse") : undefined,
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
  formpost: string;
  bd: string;
  bi: string;
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
</style></head><body><div class="wrap">
  <h1>${escapeXml(o.supplier.name)} <small>(virtual supplier)</small></h1>
  <div class="sub">Mock catalog served by punchout-simulator. Set quantities and return the cart.</div>
  ${o.banner}
  <form method="post" action="${getPublicUrl()}/sim/${o.supplier.id}/checkout">
    <input type="hidden" name="cookie" value="${escapeXml(o.cookie)}">
    <input type="hidden" name="formpost" value="${escapeXml(o.formpost)}">
    <input type="hidden" name="bd" value="${escapeXml(o.bd)}">
    <input type="hidden" name="bi" value="${escapeXml(o.bi)}">
    <table><thead><tr><th>Item</th><th>Price</th><th>Qty</th></tr></thead>
    <tbody>${o.rows}</tbody></table>
    <button type="submit">${escapeXml(o.submitLabel)}</button>
  </form>
</div></body></html>`;
}

simRoute.get("/:id/catalog", (c) => {
  const supplier = getSupplier(c.req.param("id"));
  if (!supplier) return c.text("supplier not found", 404);
  const cookie = c.req.query("cookie") ?? "";
  const formpost = safeHttpUrl(c.req.query("formpost") ?? "");
  const bd = c.req.query("bd") ?? "";
  const bi = c.req.query("bi") ?? "";
  const items = catalogOf(supplier);
  const ctx = setupContextFor(cookie);
  const page = (banner: string, rows: string, submitLabel: string) =>
    c.html(catalogPage({ supplier, banner, rows, submitLabel, cookie, formpost, bd, bi }));

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
  const formpost = safeHttpUrl(String(form.formpost ?? ""));
  const buyerCred: Credential = { domain: String(form.bd ?? ""), identity: String(form.bi ?? "") };
  const catalog = catalogOf(supplier);
  const ctx = setupContextFor(cookie);

  let items: CartItem[] = [];
  if (ctx.operation === "inspect" && ctx.items.length > 0) {
    // Inspect is read-only: return exactly the item(s) the buyer asked to view.
    items = ctx.items;
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
    timestamp: new Date().toISOString(),
    currency,
    items,
    dtdVersion: eff ? dtdVersionFor(eff, "PunchOutOrderMessage") : undefined,
  });

  appendLog({
    sessionId: cookie,
    connectionId: supplier.id,
    direction: "out",
    docType: "PunchOutOrderMessage",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: xml,
    validation: validateDocument(xml, {
      forceDocType: "PunchOutOrderMessage",
      allowMixedCurrency: supplier.allowMixedCurrency,
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
    allowMixedCurrency: supplier.allowMixedCurrency,
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
  const eff = effFor(supplier.id, from);
  const respXml = buildResponseStatus({
    payloadId: makePayloadId(host(), new Date().toISOString()),
    timestamp: new Date().toISOString(),
    statusCode: ok ? "200" : "400",
    statusText: ok ? "OK" : "Bad Request",
    from: supplier.identity,
    to: from ?? { domain: "", identity: "" },
    sender: supplier.identity,
    dtdVersion: eff ? dtdVersionFor(eff, "OrderResponse") : undefined,
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
