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

const DECLARATION = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE cXML SYSTEM "http://xml.cxml.org/schemas/cXML/1.2.045/cXML.dtd">`;

function envelope(payloadId: string, timestamp: string, lang: string, inner: string): string {
  return `${DECLARATION}
<cXML payloadID="${escapeXml(payloadId)}" timestamp="${escapeXml(timestamp)}" xml:lang="${escapeXml(lang)}">
${inner}
</cXML>`;
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
  })}
  <Request${deployment}>
    <PunchOutSetupRequest operation="${escapeXml(o.operation ?? "create")}">
      <BuyerCookie>${escapeXml(o.buyerCookie)}</BuyerCookie>
      <BrowserFormPost>
        <URL>${escapeXml(o.browserFormPostUrl)}</URL>
      </BrowserFormPost>
    </PunchOutSetupRequest>
  </Request>`;
  return envelope(o.payloadId, o.timestamp, lang, inner);
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
          <Classification domain="${escapeXml(it.classificationDomain ?? "UNSPSC")}">${escapeXml(
            it.classification ?? "",
          )}</Classification>${
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
${addressBlock("BillTo", o.billTo ?? {})}${commentsWithAttachments(orderLevelCids, "        ")}
      </OrderRequestHeader>
${items}
    </OrderRequest>
  </Request>`;
  return envelope(o.payloadId, o.timestamp, lang, inner);
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
  return envelope(o.payloadId, o.timestamp, o.lang ?? "en-US", inner);
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
  return envelope(o.payloadId, o.timestamp, o.lang ?? "en-US", inner);
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
}

export function buildPunchOutOrderMessage(o: PunchbackOptions): string {
  const total = o.items.reduce(
    (sum, it) => sum + (it.unitPriceAmount ?? 0) * it.quantity,
    0,
  );
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
        <Classification domain="${escapeXml(it.classificationDomain ?? "UNSPSC")}">${escapeXml(
          it.classification ?? "",
        )}</Classification>${
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
      <PunchOutOrderMessageHeader operationAllowed="create">
        <Total>
          <Money currency="${escapeXml(o.currency)}">${escapeXml(total.toFixed(2))}</Money>
        </Total>
      </PunchOutOrderMessageHeader>
${items}
    </PunchOutOrderMessage>
  </Message>`;
  return envelope(o.payloadId, o.timestamp, o.lang ?? "en-US", inner);
}
