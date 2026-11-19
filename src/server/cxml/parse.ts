import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { Cart, CartItem, ChargeAmount, Credential, DocType, ProfileOption, SelectedItem, ServerProfile } from "./types.js";

// fast-xml-parser configuration. We keep all tag/attribute values as raw
// strings (no number coercion) so money amounts like "100.00" survive intact;
// numeric conversion happens explicitly where we need it.
const ATTR = "@_";
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // Always treat the repeated cXML containers as arrays so callers don't have
  // to special-case "one item vs many".
  isArray: (name) =>
    ["ItemIn", "ItemOut", "Attachment", "Comments", "Extrinsic"].includes(name),
});

export interface ParsedDoc {
  raw: string;
  /** Parsed object tree, or null when not well-formed. */
  tree: any | null;
  wellFormed: boolean;
  wellFormedError?: string;
}

export function parseXml(raw: string): ParsedDoc {
  // Defense-in-depth against XXE / entity-expansion ("billion laughs"): cXML
  // documents declare a `<!DOCTYPE cXML SYSTEM "...">` with NO internal entity
  // definitions, so reject any document that defines custom entities before it
  // reaches the parser. (fast-xml-parser does not resolve external DTDs.)
  if (/<!ENTITY/i.test(raw)) {
    return { raw, tree: null, wellFormed: false, wellFormedError: "DTD entity definitions are not allowed" };
  }
  const check = XMLValidator.validate(raw, { allowBooleanAttributes: true });
  if (check !== true) {
    const where = check?.err?.line != null ? ` (line ${check.err.line}, column ${check.err.col})` : "";
    return {
      raw,
      tree: null,
      wellFormed: false,
      wellFormedError: `${(check?.err?.msg ?? "not well-formed").replace(/\.$/, "")}${where}`,
    };
  }
  try {
    return { raw, tree: parser.parse(raw), wellFormed: true };
  } catch (e) {
    return {
      raw,
      tree: null,
      wellFormed: false,
      wellFormedError: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * What a body that should have been cXML actually is. A counterparty that
 * fails before its cXML layer answers with something else entirely — a proxy's
 * or web server's HTML error page, a plain-text message, JSON from an API
 * gateway — and "not well-formed" says nothing about that.
 */
export interface BodyKind {
  kind: "empty" | "text" | "html" | "json" | "xml";
  /** HTML <title>, when there is one. */
  title?: string;
  /** The readable start of the body: markup stripped, whitespace collapsed. */
  excerpt: string;
}

// Only the start of the body is examined. The excerpt is a few hundred
// characters, and the patterns below are not linear in the worst case: a body
// of unclosed "<script" tags makes the script-stripping pattern rescan the rest
// of the input for every one of them. Bodies reach this function straight from
// the open inbound endpoints, so its cost must not depend on their size.
const DESCRIBE_PREFIX = 8 * 1024;

export function describeBody(raw: string, maxLength = 300): BodyKind {
  const body = raw.slice(0, DESCRIBE_PREFIX + 64).replace(/^\uFEFF/, "").trimStart().slice(0, DESCRIBE_PREFIX).trimEnd();
  const clip = (s: string) => (s.length > maxLength ? `${s.slice(0, maxLength)}…` : s);
  if (body === "") return { kind: "empty", excerpt: "" };
  const head = body.slice(0, 1000);
  if (/<!doctype\s+html|<html[\s>]/i.test(head)) {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.replace(/\s+/g, " ").trim();
    const visible = body
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return { kind: "html", title: title || undefined, excerpt: clip(visible) };
  }
  if (body.startsWith("{") || body.startsWith("[")) return { kind: "json", excerpt: clip(body.replace(/\s+/g, " ")) };
  if (!body.startsWith("<")) return { kind: "text", excerpt: clip(body.replace(/\s+/g, " ")) };
  return { kind: "xml", excerpt: clip(body.replace(/\s+/g, " ")) };
}

// --- small navigation helpers -------------------------------------------------

/** Extract text content of a node whether it is a bare string or {#text}. */
export function text(node: any): string | undefined {
  if (node == null) return undefined;
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (typeof node === "object" && "#text" in node) {
    const t = node["#text"];
    return t == null ? undefined : String(t);
  }
  return undefined;
}

export function attr(node: any, name: string): string | undefined {
  if (node == null || typeof node !== "object") return undefined;
  const v = node[ATTR + name];
  return v == null ? undefined : String(v);
}

export function asArray<T = any>(node: any): T[] {
  if (node == null) return [];
  return Array.isArray(node) ? node : [node];
}

/** The cXML root element ({@code <cXML>}). */
export function root(doc: ParsedDoc): any | undefined {
  return doc.tree?.cXML;
}

// --- document classification --------------------------------------------------

export function getDocType(doc: ParsedDoc): DocType {
  const r = root(doc);
  if (!r) return "Unknown";
  const req = r.Request;
  const resp = r.Response;
  const msg = r.Message;
  // Use key presence, not truthiness: an empty element (e.g.
  // `<PunchOutSetupResponse/>`) parses to "" which is falsy.
  if (req && typeof req === "object") {
    if ("PunchOutSetupRequest" in req) return "SetupRequest";
    if ("OrderRequest" in req) return "OrderRequest";
    if ("ProfileRequest" in req) return "ProfileRequest";
  }
  if (resp && typeof resp === "object") {
    // SetupResponse and OrderResponse both live under <Response>; distinguish
    // by the presence of the PunchOut payload.
    if ("PunchOutSetupResponse" in resp) return "SetupResponse";
    if ("ProfileResponse" in resp) return "ProfileResponse";
    return "OrderResponse";
  }
  if (msg && typeof msg === "object" && "PunchOutOrderMessage" in msg) {
    return "PunchOutOrderMessage";
  }
  return "Unknown";
}

// --- credential extraction ----------------------------------------------------

// From, To and Sender may each carry several Credential elements (the DTD says
// `Credential+`): they identify one organization in different domains, e.g. a
// DUNS number and a NetworkId. All of them are returned.
function credentialsOf(node: any): Credential[] {
  return asArray(node?.Credential)
    .filter((c) => c != null)
    .map((c) => ({ domain: attr(c, "domain") ?? "", identity: text(c?.Identity) ?? "" }));
}

export interface HeaderCredentials {
  /** The first credential of each party (kept for callers that need just one). */
  from?: Credential;
  to?: Credential;
  sender?: Credential;
  sharedSecret?: string;
  /** Every credential of each party, in document order. */
  fromAll: Credential[];
  toAll: Credential[];
  senderAll: Credential[];
}

export function getHeaderCredentials(doc: ParsedDoc): HeaderCredentials {
  const header = root(doc)?.Header;
  if (!header) return { fromAll: [], toAll: [], senderAll: [] };
  const fromAll = credentialsOf(header.From);
  const toAll = credentialsOf(header.To);
  const senderAll = credentialsOf(header.Sender);
  // The secret sits on whichever Sender credential authenticates the sender.
  const withSecret = asArray(header.Sender?.Credential).find((c) => text(c?.SharedSecret) != null);
  return {
    from: fromAll[0],
    to: toAll[0],
    sender: senderAll[0],
    sharedSecret: text(withSecret?.SharedSecret),
    fromAll,
    toAll,
    senderAll,
  };
}

/** The credential in `list` that equals one of `known`, if any. */
export function matchCredential(list: Credential[], known: Array<Credential | undefined>): Credential | undefined {
  return list.find((c) => known.some((k) => !!k && k.domain === c.domain && k.identity === c.identity));
}

export function getPayloadId(doc: ParsedDoc): string | undefined {
  return attr(root(doc), "payloadID");
}

export function getTimestamp(doc: ParsedDoc): string | undefined {
  return attr(root(doc), "timestamp");
}

// --- response helpers ---------------------------------------------------------

export interface StatusInfo {
  code?: string;
  /** The short `text` attribute ("OK", "Bad Request"). */
  text?: string;
  /**
   * The element body — cXML's human-readable explanation, where suppliers put
   * things like "Order number 12345 received" or the reason for a rejection.
   */
  message?: string;
}

export function getStatus(doc: ParsedDoc): StatusInfo {
  const status = root(doc)?.Response?.Status;
  if (!status) return {};
  const message = text(status)?.trim();
  return { code: attr(status, "code"), text: attr(status, "text"), message: message || undefined };
}

// --- Profile transaction -------------------------------------------------------

const optionsOf = (node: any): ProfileOption[] =>
  asArray(node?.Option)
    .filter((o) => o != null)
    .map((o) => ({ name: attr(o, "name") ?? "", value: (text(o) ?? "").trim() }));

/** The capabilities advertised in a ProfileResponse, or undefined when there is none. */
export function parseProfileResponse(doc: ParsedDoc): ServerProfile | undefined {
  const resp = root(doc)?.Response;
  if (!resp || typeof resp !== "object" || !("ProfileResponse" in resp)) return undefined;
  const pr = resp.ProfileResponse;
  return {
    effectiveDate: attr(pr, "effectiveDate"),
    lastRefresh: attr(pr, "lastRefresh"),
    options: optionsOf(pr),
    transactions: asArray(pr?.Transaction)
      .filter((t) => t != null)
      .map((t) => ({ requestName: attr(t, "requestName") ?? "", url: (text(t?.URL) ?? "").trim(), options: optionsOf(t) })),
  };
}

/**
 * The URL a profile gives for a request. When several Transactions carry the
 * same requestName they are variations told apart by a `service` Option; with
 * no service asked for, "use the first transaction with no option name".
 */
export function profileUrlFor(profile: ServerProfile, requestName: string): string | undefined {
  const matches = profile.transactions.filter((t) => t.requestName === requestName && t.url);
  return (matches.find((t) => !t.options.some((o) => o.name === "service")) ?? matches[0])?.url;
}

export function getStartPage(doc: ParsedDoc): string | undefined {
  const sr = root(doc)?.Response?.PunchOutSetupResponse;
  return text(sr?.StartPage?.URL);
}

// --- punchback -> cart --------------------------------------------------------

function money(node: any): { amount?: number; currency?: string } {
  const m = node?.Money;
  if (!m) return {};
  const raw = text(m);
  const amount = raw != null && raw !== "" ? Number(raw) : undefined;
  return {
    amount: Number.isFinite(amount) ? amount : undefined,
    currency: attr(m, "currency"),
  };
}

/** A `<Shipping>` or `<Tax>` element as an amount: its Money and Description. */
export function chargeOf(node: any): ChargeAmount | undefined {
  const m = money(node);
  if (m.amount == null || !m.currency) return undefined;
  return { amount: m.amount, currency: m.currency, description: text(node?.Description)?.trim() || undefined };
}

// --- attachment cid references (OrderRequest) --------------------------------

export interface CidReference {
  cid: string; // normalized, cid: scheme stripped
  rawUrl: string;
  level: "order" | "item";
  itemIndex?: number; // 1-based, for item-level
  /** A plain https:// URL rather than a cid: reference. */
  external: boolean;
}

function stripCid(url: string): { cid: string; external: boolean } {
  const trimmed = url.trim();
  if (/^cid:/i.test(trimmed)) {
    const cid = trimmed.replace(/^cid:/i, "").trim().replace(/^<+/, "").replace(/>+$/, "");
    return { cid, external: false };
  }
  return { cid: trimmed, external: true };
}

function attachmentsInComments(commentsNode: any): string[] {
  const urls: string[] = [];
  for (const comments of asArray(commentsNode)) {
    for (const att of asArray(comments?.Attachment)) {
      const url = text(att?.URL);
      if (url) urls.push(url);
    }
  }
  return urls;
}

/**
 * Scan an OrderRequest for every <Attachment><URL> at both levels:
 * OrderRequestHeader/Comments (whole-order) and each ItemOut/Comments
 * (per line item). See spec section 11 — Comments appears at two levels.
 */
export function collectCidReferences(doc: ParsedDoc): CidReference[] {
  const orderReq = root(doc)?.Request?.OrderRequest;
  if (!orderReq) return [];
  const refs: CidReference[] = [];

  for (const rawUrl of attachmentsInComments(orderReq?.OrderRequestHeader?.Comments)) {
    const { cid, external } = stripCid(rawUrl);
    refs.push({ cid, rawUrl, level: "order", external });
  }

  asArray(orderReq?.ItemOut).forEach((item, i) => {
    for (const rawUrl of attachmentsInComments(item?.ItemDetail?.Comments)) {
      const { cid, external } = stripCid(rawUrl);
      refs.push({ cid, rawUrl, level: "item", itemIndex: i + 1, external });
    }
    // Comments may also appear directly under ItemOut (not just ItemDetail).
    for (const rawUrl of attachmentsInComments(item?.Comments)) {
      const { cid, external } = stripCid(rawUrl);
      refs.push({ cid, rawUrl, level: "item", itemIndex: i + 1, external });
    }
  });

  return refs;
}

// A single cart line, parsed from either an <ItemIn> (PunchOutOrderMessage) or an
// <ItemOut> (the edit/inspect PunchOutSetupRequest) — they share the same
// quantity + ItemID + ItemDetail shape.
function itemFromNode(it: any): CartItem {
  const detail = it?.ItemDetail;
  const up = money(detail?.UnitPrice);
  const classifications = asArray(detail?.Classification)
    .filter((c) => c != null)
    .map((c) => ({ domain: attr(c, "domain") ?? "", value: text(c) ?? "" }));
  const classFirst = classifications[0];
  return {
    quantity: Number(attr(it, "quantity") ?? "1") || 1,
    supplierPartId: text(it?.ItemID?.SupplierPartID),
    supplierPartAuxiliaryId: text(it?.ItemID?.SupplierPartAuxiliaryID),
    description: text(detail?.Description),
    uom: text(detail?.UnitOfMeasure),
    unitPriceAmount: up.amount,
    currency: up.currency,
    classifications: classifications.length > 0 ? classifications : undefined,
    classificationDomain: classFirst?.domain,
    classification: classFirst?.value,
    manufacturerPartId: text(detail?.ManufacturerPartID),
    manufacturerName: text(detail?.ManufacturerName),
  };
}

/** The operation + carried line items of an inbound PunchOutSetupRequest. For
 * `edit`/`inspect` the buyer sends the existing cart as ItemOut blocks so the
 * supplier can re-open it; `create` carries none. */
export interface SetupItems {
  operation: string;
  items: CartItem[];
  /** The catalog item the user punched out from, when the buyer named one. */
  selectedItem?: SelectedItem;
}

export function parseSetupItems(doc: ParsedDoc): SetupItems {
  const sr = root(doc)?.Request?.PunchOutSetupRequest;
  const selectedId = sr?.SelectedItem?.ItemID;
  const selectedPart = text(selectedId?.SupplierPartID)?.trim();
  return {
    operation: attr(sr, "operation") ?? "create",
    items: asArray(sr?.ItemOut).map(itemFromNode),
    selectedItem: selectedPart
      ? { supplierPartId: selectedPart, supplierPartAuxiliaryId: text(selectedId?.SupplierPartAuxiliaryID)?.trim() || undefined }
      : undefined,
  };
}

/** Message/Status/@code of a punchback (e.g. "204" for a cancelled session). */
export function getMessageStatusCode(doc: ParsedDoc): string | undefined {
  return attr(root(doc)?.Message?.Status, "code");
}

/** The identifying attributes of an OrderRequest, for change-order handling. */
export interface OrderInfo {
  payloadId?: string;
  orderId?: string;
  /** OrderRequestHeader/@type; the DTD default is "new". */
  type: string;
  orderVersion?: string;
  /** DocumentReference/@payloadID, present on update / delete. */
  documentReference?: string;
}

export function getOrderInfo(doc: ParsedDoc): OrderInfo {
  const header = root(doc)?.Request?.OrderRequest?.OrderRequestHeader;
  return {
    payloadId: getPayloadId(doc),
    orderId: attr(header, "orderID"),
    type: attr(header, "type") ?? "new",
    orderVersion: attr(header, "orderVersion"),
    documentReference: attr(header?.DocumentReference, "payloadID"),
  };
}

export function parseCart(doc: ParsedDoc): Cart {
  const pom = root(doc)?.Message?.PunchOutOrderMessage;
  const sessionId = text(pom?.BuyerCookie) ?? "";
  const headerNode = pom?.PunchOutOrderMessageHeader;
  const total = money(headerNode?.Total);
  const items: CartItem[] = asArray(pom?.ItemIn).map(itemFromNode);
  return {
    sessionId,
    operationAllowed: attr(headerNode, "operationAllowed"),
    statusCode: getMessageStatusCode(doc),
    shipping: chargeOf(headerNode?.Shipping),
    tax: chargeOf(headerNode?.Tax),
    total:
      total.amount != null && total.currency
        ? { amount: total.amount, currency: total.currency }
        : undefined,
    items,
  };
}
