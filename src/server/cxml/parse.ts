import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { Cart, CartItem, Credential, DocType } from "./types.js";

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
    return {
      raw,
      tree: null,
      wellFormed: false,
      wellFormedError: check?.err?.msg ?? "not well-formed",
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
  }
  if (resp && typeof resp === "object") {
    // SetupResponse and OrderResponse both live under <Response>; distinguish
    // by the presence of the PunchOut payload.
    if ("PunchOutSetupResponse" in resp) return "SetupResponse";
    return "OrderResponse";
  }
  if (msg && typeof msg === "object" && "PunchOutOrderMessage" in msg) {
    return "PunchOutOrderMessage";
  }
  return "Unknown";
}

// --- credential extraction ----------------------------------------------------

function credentialOf(node: any): Credential | undefined {
  const cred = node?.Credential;
  if (!cred) return undefined;
  const first = Array.isArray(cred) ? cred[0] : cred;
  return {
    domain: attr(first, "domain") ?? "",
    identity: text(first?.Identity) ?? "",
  };
}

export interface HeaderCredentials {
  from?: Credential;
  to?: Credential;
  sender?: Credential;
  sharedSecret?: string;
}

export function getHeaderCredentials(doc: ParsedDoc): HeaderCredentials {
  const header = root(doc)?.Header;
  if (!header) return {};
  const senderCred = header.Sender?.Credential;
  const senderFirst = Array.isArray(senderCred) ? senderCred[0] : senderCred;
  return {
    from: credentialOf(header.From),
    to: credentialOf(header.To),
    sender: credentialOf(header.Sender),
    sharedSecret: text(senderFirst?.SharedSecret),
  };
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
  text?: string;
}

export function getStatus(doc: ParsedDoc): StatusInfo {
  const status = root(doc)?.Response?.Status;
  if (!status) return {};
  return { code: attr(status, "code"), text: attr(status, "text") };
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
}

export function parseSetupItems(doc: ParsedDoc): SetupItems {
  const sr = root(doc)?.Request?.PunchOutSetupRequest;
  return {
    operation: attr(sr, "operation") ?? "create",
    items: asArray(sr?.ItemOut).map(itemFromNode),
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
    total:
      total.amount != null && total.currency
        ? { amount: total.amount, currency: total.currency }
        : undefined,
    items,
  };
}
