import { nanoid } from "nanoid";
import type { CartItem, Credential } from "./types.js";

// cXML document builders. We use template literals (not an XML library) so we
// keep full control over element order, attributes and xml:lang — see spec
// section 6. Everything user-supplied is escaped.

export function escapeXml(value: string | number | undefined | null): string {
  if (value == null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Build a cXML payloadID of the form `<timestamp>.<random>@<host>`. */
export function makePayloadId(host: string, nowIso: string): string {
  return `${nowIso}.${nanoid(10)}@${host}`;
}

// Sum of (unit price × quantity) across the line items — but only when they
// share one currency. A cXML Total is a single Money, so a cross-currency sum
// would be meaningless; we return 0 in that case rather than fabricate a number
// (it also makes the inconsistency visible via the total-mismatch / mixed-currency
// validations). `headerCurrency` is the fallback for items without their own.
export function lineItemsTotal(
  items: Array<{ unitPriceAmount?: number; quantity: number; currency?: string }>,
  headerCurrency: string,
): number {
  const currencies = new Set(items.map((it) => it.currency || headerCurrency));
  if (currencies.size > 1) return 0;
  return items.reduce((sum, it) => sum + (it.unitPriceAmount ?? 0) * it.quantity, 0);
}

// Emit one `<Classification>` per entry. Prefers the `classifications` array;
// falls back to the legacy single classificationDomain/classification pair so
// items built from older carts (or simple fixtures) still produce one element.
function classificationBlock(it: CartItem, indent: string): string {
  const list =
    it.classifications && it.classifications.length > 0
      ? it.classifications
      : [{ domain: it.classificationDomain ?? "UNSPSC", value: it.classification ?? "" }];
  return list
    .map((c) => `${indent}<Classification domain="${escapeXml(c.domain || "UNSPSC")}">${escapeXml(c.value)}</Classification>`)
    .join("\n");
}

export interface HeaderParts {
  from: Credential;
  to: Credential;
  sender: Credential;
  /** Included only when present (responses and the punchback omit it). */
  sharedSecret?: string;
  userAgent?: string;
}

function credentialBlock(tag: string, c: Credential): string {
  return `    <${tag}>
      <Credential domain="${escapeXml(c.domain)}">
        <Identity>${escapeXml(c.identity)}</Identity>
      </Credential>
    </${tag}>`;
}

function senderBlock(c: Credential, sharedSecret?: string, userAgent?: string): string {
  const secret =
    sharedSecret != null && sharedSecret !== ""
      ? `\n        <SharedSecret>${escapeXml(sharedSecret)}</SharedSecret>`
      : "";
  return `    <Sender>
      <Credential domain="${escapeXml(c.domain)}">
        <Identity>${escapeXml(c.identity)}</Identity>${secret}
      </Credential>
      <UserAgent>${escapeXml(userAgent ?? "punchout-simulator")}</UserAgent>
    </Sender>`;
}

function header(p: HeaderParts): string {
  return `  <Header>
${credentialBlock("From", p.from)}
${credentialBlock("To", p.to)}
${senderBlock(p.sender, p.sharedSecret, p.userAgent)}
  </Header>`;
}

const DEFAULT_DTD_VERSION = "1.2.045";

function doctype(version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE cXML SYSTEM "http://xml.cxml.org/schemas/cXML/${escapeXml(version)}/cXML.dtd">`;
}

function envelope(
  payloadId: string,
  timestamp: string,
  lang: string,
  inner: string,
  dtdVersion: string = DEFAULT_DTD_VERSION,
): string {
  return `${doctype(dtdVersion)}
<cXML payloadID="${escapeXml(payloadId)}" timestamp="${escapeXml(timestamp)}" xml:lang="${escapeXml(lang)}">
${inner}
</cXML>`;
}

/** A resolved Extrinsic (tokens already substituted) for injection into a document. */
export interface ExtrinsicVal {
  name: string;
  value: string;
}

/** Substitute ${token} placeholders in an Extrinsic value (e.g. ${buyerCookie}). */
export function applyExtrinsicTokens(value: string, tokens: Record<string, string>): string {
  return value.replace(/\$\{(\w+)\}/g, (_, k) => tokens[k] ?? "");
}

function extrinsicBlock(items: ExtrinsicVal[] | undefined, indent: string): string {
  if (!items || items.length === 0) return "";
  return (
    "\n" +
    items
      .map((e) => `${indent}<Extrinsic name="${escapeXml(e.name)}">${escapeXml(e.value)}</Extrinsic>`)
      .join("\n")
  );
}

// --- SetupRequest (Mode A: buyer -> supplier) --------------------------------

export interface SetupRequestOptions {
  from: Credential;
  to: Credential;
  sender: Credential;
  sharedSecret?: string;
  buyerCookie: string;
  /** The tool's own callback URL the punchback should POST to. */
  browserFormPostUrl: string;
  payloadId: string;
  timestamp: string;
  lang?: string;
  deploymentMode?: string;
  operation?: string; // create | edit | inspect
  dtdVersion?: string;
  userAgent?: string;
  extrinsics?: ExtrinsicVal[];
}

export function buildSetupRequest(o: SetupRequestOptions): string {
  const lang = o.lang ?? "en-US";
  const deployment = o.deploymentMode
    ? ` deploymentMode="${escapeXml(o.deploymentMode)}"`
    : "";
  const inner = `${header({
    from: o.from,
    to: o.to,
    sender: o.sender,
    sharedSecret: o.sharedSecret,
    userAgent: o.userAgent,
  })}
  <Request${deployment}>
    <PunchOutSetupRequest operation="${escapeXml(o.operation ?? "create")}">
      <BuyerCookie>${escapeXml(o.buyerCookie)}</BuyerCookie>
      <BrowserFormPost>
        <URL>${escapeXml(o.browserFormPostUrl)}</URL>
      </BrowserFormPost>${extrinsicBlock(o.extrinsics, "      ")}
    </PunchOutSetupRequest>
  </Request>`;
  return envelope(o.payloadId, o.timestamp, lang, inner, o.dtdVersion);
}

// --- OrderRequest (Mode A: buyer -> supplier) --------------------------------

export interface OrderRequestItem extends CartItem {}

export interface OrderAttachmentMeta {
  /** Content-ID to reference via <Attachment><URL>cid:...</URL>. */
  contentId: string;
  /** Where the attachment is attached: the whole order, or a 1-based item index. */
  scope: "order" | { itemIndex: number };
}

export interface OrderRequestOptions {
  from: Credential;
  to: Credential;
  sender: Credential;
  sharedSecret?: string;
  orderId: string;
  orderDate: string;
  payloadId: string;
  timestamp: string;
  lang?: string;
  deploymentMode?: string;
  currency: string;
  total: number;
  items: OrderRequestItem[];
  shipTo?: AddressParts;
  billTo?: AddressParts;
  attachments?: OrderAttachmentMeta[];
  dtdVersion?: string;
  userAgent?: string;
  extrinsics?: ExtrinsicVal[];
}

export interface AddressParts {
  addressId?: string;
  name?: string;
  deliverTo?: string;
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  countryIsoCode?: string;
  countryName?: string;
}

function addressBlock(tag: "ShipTo" | "BillTo", a: AddressParts): string {
  return `      <${tag}>
        <Address${a.addressId ? ` addressID="${escapeXml(a.addressId)}"` : ""}>
          <Name xml:lang="en">${escapeXml(a.name ?? "")}</Name>
          <PostalAddress>
${a.deliverTo ? `            <DeliverTo>${escapeXml(a.deliverTo)}</DeliverTo>\n` : ""}            <Street>${escapeXml(a.street ?? "")}</Street>
            <City>${escapeXml(a.city ?? "")}</City>
            <State>${escapeXml(a.state ?? "")}</State>
            <PostalCode>${escapeXml(a.postalCode ?? "")}</PostalCode>
            <Country isoCountryCode="${escapeXml(a.countryIsoCode ?? "US")}">${escapeXml(a.countryName ?? "United States")}</Country>
          </PostalAddress>
        </Address>
      </${tag}>`;
}

function commentsWithAttachments(cids: string[], indent: string): string {
  if (cids.length === 0) return "";
  const atts = cids
    .map(
      (cid) =>
        `${indent}  <Attachment>\n${indent}    <URL>cid:${escapeXml(cid)}</URL>\n${indent}  </Attachment>`,
    )
    .join("\n");
  return `\n${indent}<Comments>\n${atts}\n${indent}</Comments>`;
}

export function buildOrderRequest(o: OrderRequestOptions): string {
  const lang = o.lang ?? "en-US";
  const deployment = o.deploymentMode
    ? ` deploymentMode="${escapeXml(o.deploymentMode)}"`
    : "";

  const orderLevelCids = (o.attachments ?? [])
    .filter((a) => a.scope === "order")
    .map((a) => a.contentId);
  const itemCids = (idx: number) =>
    (o.attachments ?? [])
      .filter((a) => typeof a.scope === "object" && a.scope.itemIndex === idx)
      .map((a) => a.contentId);

  const items = o.items
    .map((it, i) => {
      const idx = i + 1;
      const cids = itemCids(idx);
      return `      <ItemOut quantity="${escapeXml(it.quantity)}" lineNumber="${idx}">
        <ItemID>
          <SupplierPartID>${escapeXml(it.supplierPartId ?? "")}</SupplierPartID>${
            it.supplierPartAuxiliaryId
              ? `\n          <SupplierPartAuxiliaryID>${escapeXml(it.supplierPartAuxiliaryId)}</SupplierPartAuxiliaryID>`
              : ""
          }
        </ItemID>
        <ItemDetail>
          <UnitPrice>
            <Money currency="${escapeXml(it.currency ?? o.currency)}">${escapeXml(
              it.unitPriceAmount ?? 0,
            )}</Money>
          </UnitPrice>
          <Description xml:lang="en">${escapeXml(it.description ?? "")}</Description>
          <UnitOfMeasure>${escapeXml(it.uom ?? "EA")}</UnitOfMeasure>
${classificationBlock(it, "          ")}${
            it.manufacturerPartId
              ? `\n          <ManufacturerPartID>${escapeXml(it.manufacturerPartId)}</ManufacturerPartID>`
              : ""
          }${
            it.manufacturerName
              ? `\n          <ManufacturerName>${escapeXml(it.manufacturerName)}</ManufacturerName>`
              : ""
          }${commentsWithAttachments(cids, "          ")}
        </ItemDetail>
      </ItemOut>`;
    })
    .join("\n");

  const inner = `${header({
    from: o.from,
    to: o.to,
    sender: o.sender,
    sharedSecret: o.sharedSecret,
    userAgent: o.userAgent,
  })}
  <Request${deployment}>
    <OrderRequest>
      <OrderRequestHeader orderID="${escapeXml(o.orderId)}" orderDate="${escapeXml(
        o.orderDate,
      )}" type="new">
        <Total>
          <Money currency="${escapeXml(o.currency)}">${escapeXml(o.total)}</Money>
        </Total>
${addressBlock("ShipTo", o.shipTo ?? {})}
${addressBlock("BillTo", o.billTo ?? {})}${commentsWithAttachments(orderLevelCids, "        ")}${extrinsicBlock(
        o.extrinsics,
        "        ",
      )}
      </OrderRequestHeader>
${items}
    </OrderRequest>
  </Request>`;
  return envelope(o.payloadId, o.timestamp, lang, inner, o.dtdVersion);
}

// --- Responses & punchback (Mode B / mock supplier) --------------------------

function optionalHeader(p?: { from: Credential; to: Credential; sender: Credential }): string {
  return p ? `${header({ from: p.from, to: p.to, sender: p.sender })}\n` : "";
}

export function buildSetupResponse(o: {
  payloadId: string;
  timestamp: string;
  startPageUrl: string;
  statusCode?: string;
  statusText?: string;
  lang?: string;
  from?: Credential;
  to?: Credential;
  sender?: Credential;
  dtdVersion?: string;
}): string {
  const head =
    o.from && o.to && o.sender
      ? optionalHeader({ from: o.from, to: o.to, sender: o.sender })
      : "";
  const inner = `${head}  <Response>
    <Status code="${escapeXml(o.statusCode ?? "200")}" text="${escapeXml(
      o.statusText ?? "OK",
    )}"/>
    <PunchOutSetupResponse>
      <StartPage>
        <URL>${escapeXml(o.startPageUrl)}</URL>
      </StartPage>
    </PunchOutSetupResponse>
  </Response>`;
  return envelope(o.payloadId, o.timestamp, o.lang ?? "en-US", inner, o.dtdVersion);
}

export function buildResponseStatus(o: {
  payloadId: string;
  timestamp: string;
  statusCode?: string;
  statusText?: string;
  lang?: string;
  from?: Credential;
  to?: Credential;
  sender?: Credential;
  dtdVersion?: string;
}): string {
  const head =
    o.from && o.to && o.sender
      ? optionalHeader({ from: o.from, to: o.to, sender: o.sender })
      : "";
  const inner = `${head}  <Response>
    <Status code="${escapeXml(o.statusCode ?? "200")}" text="${escapeXml(
      o.statusText ?? "OK",
    )}">${escapeXml(o.statusText === "OK" || !o.statusText ? "" : o.statusText)}</Status>
  </Response>`;
  return envelope(o.payloadId, o.timestamp, o.lang ?? "en-US", inner, o.dtdVersion);
}

export interface PunchbackOptions {
  from: Credential;
  to: Credential;
  sender: Credential;
  buyerCookie: string;
  payloadId: string;
  timestamp: string;
  lang?: string;
  currency: string;
  items: CartItem[];
  dtdVersion?: string;
  operationAllowed?: string;
}

export function buildPunchOutOrderMessage(o: PunchbackOptions): string {
  const total = lineItemsTotal(o.items, o.currency);
  const items = o.items
    .map(
      (it) => `    <ItemIn quantity="${escapeXml(it.quantity)}">
      <ItemID>
        <SupplierPartID>${escapeXml(it.supplierPartId ?? "")}</SupplierPartID>${
          it.supplierPartAuxiliaryId
            ? `\n        <SupplierPartAuxiliaryID>${escapeXml(it.supplierPartAuxiliaryId)}</SupplierPartAuxiliaryID>`
            : ""
        }
      </ItemID>
      <ItemDetail>
        <UnitPrice>
          <Money currency="${escapeXml(it.currency ?? o.currency)}">${escapeXml(
            it.unitPriceAmount ?? 0,
          )}</Money>
        </UnitPrice>
        <Description xml:lang="en">${escapeXml(it.description ?? "")}</Description>
        <UnitOfMeasure>${escapeXml(it.uom ?? "EA")}</UnitOfMeasure>
${classificationBlock(it, "        ")}${
          it.manufacturerPartId
            ? `\n        <ManufacturerPartID>${escapeXml(it.manufacturerPartId)}</ManufacturerPartID>`
            : ""
        }
      </ItemDetail>
    </ItemIn>`,
    )
    .join("\n");

  const inner = `${header({ from: o.from, to: o.to, sender: o.sender })}
  <Message>
    <PunchOutOrderMessage>
      <BuyerCookie>${escapeXml(o.buyerCookie)}</BuyerCookie>
      <PunchOutOrderMessageHeader operationAllowed="${escapeXml(o.operationAllowed ?? "create")}">
        <Total>
          <Money currency="${escapeXml(o.currency)}">${escapeXml(total.toFixed(2))}</Money>
        </Total>
      </PunchOutOrderMessageHeader>
${items}
    </PunchOutOrderMessage>
  </Message>`;
  return envelope(o.payloadId, o.timestamp, o.lang ?? "en-US", inner, o.dtdVersion);
}
