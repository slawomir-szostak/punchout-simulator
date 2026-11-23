import { nanoid } from "nanoid";
import type { AccountingSettings, Address, AddressMode, CartItem, ChargeAmount, Contact, Credential, ProfileOption, ProfileTransaction, SelectedItem, TaxSettings } from "./types.js";

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

/**
 * A date-time in the form cXML requires: the restricted ISO 8601 subset of the
 * W3C "Date and Time Formats" note, in local time with a numeric offset from
 * UTC, e.g. `2015-04-14T13:36:00-08:00`. The "Z" designator is not allowed
 * (cXML Reference Guide, "Date, Time, and Other Data Types"), which rules out
 * `Date.prototype.toISOString()`.
 */
export function cxmlTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(offsetMin / 60)}:${pad(offsetMin % 60)}`
  );
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
  from: Credential | Credential[];
  to: Credential | Credential[];
  sender: Credential;
  /** Included only when present (responses and the punchback omit it). */
  sharedSecret?: string;
  userAgent?: string;
}

function credentialBlock(tag: string, c: Credential | Credential[]): string {
  // A party may go by several credentials: one organization, different domains.
  const credentials = (Array.isArray(c) ? c : [c])
    .map(
      (one) => `      <Credential domain="${escapeXml(one.domain)}">
        <Identity>${escapeXml(one.identity)}</Identity>
      </Credential>`,
    )
    .join("\n");
  return `    <${tag}>
${credentials}
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

// A platform profile may declare an old DTD version, and a document must only
// use what that version defines. Attributes the builders emit that are newer
// than the oldest profile DTD (found by validating against each version):
const ADDRESS_ID_DOMAIN_SINCE = "1.2.025"; // Address/@addressIDDomain, Contact/@addressIDDomain
const ORDER_VERSION_SINCE = "1.2.009"; // OrderRequestHeader/@orderVersion
export const SCHEDULE_LINE_SINCE = "1.2.025"; // ItemOut/ScheduleLine

/** True when DTD `version` is at least `min` (both "major.minor.patch"). */
export function dtdAtLeast(version: string | undefined, min: string): boolean {
  const a = (version ?? DEFAULT_DTD_VERSION).split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

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

// --- Delivery schedule -----------------------------------------------------------
//
// "ScheduleLine contains information related to delivery schedules for a line
// item": ScheduleLine (UnitOfMeasure, …) with @quantity and
// @requestedDeliveryDate both #REQUIRED and an optional @lineNumber. It follows
// Comments inside ItemOut, and exists from DTD 1.2.025.

/**
 * A requested delivery date as the datetime.tz the attribute needs. A plain date
 * becomes noon local time (the Reference Guide's own example is
 * `2019-03-15T12:00:00+01:00`); anything else is passed through as given.
 */
export function scheduleDateTime(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  return m ? cxmlTimestamp(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0)) : value.trim();
}

function scheduleLinesBlock(it: CartItem, dtdVersion: string | undefined, indent: string): string {
  const lines = it.scheduleLines ?? [];
  if (lines.length === 0 || !dtdAtLeast(dtdVersion, SCHEDULE_LINE_SINCE)) return "";
  return lines
    .map(
      (l, i) => `\n${indent}<ScheduleLine quantity="${escapeXml(l.quantity)}" requestedDeliveryDate="${escapeXml(scheduleDateTime(l.requestedDeliveryDate))}" lineNumber="${escapeXml(l.lineNumber ?? i + 1)}">
${indent}  <UnitOfMeasure>${escapeXml(it.uom ?? "EA")}</UnitOfMeasure>
${indent}</ScheduleLine>`,
    )
    .join("");
}

// --- Profile transaction -------------------------------------------------------
//
// "The Profile transaction is the only transaction that all cXML servers must
// support." A ProfileRequest is an empty element routed by the Header; the
// ProfileResponse lists the requests the server accepts and where:
//   ProfileRequest  EMPTY
//   ProfileResponse (Option*, Transaction+)   @effectiveDate #REQUIRED, @lastRefresh
//   Transaction     (URL, Option*)            @requestName #REQUIRED
//   Option          (#PCDATA)                 @name #REQUIRED

export function buildProfileRequest(o: {
  from: Credential | Credential[];
  to: Credential | Credential[];
  sender: Credential;
  sharedSecret?: string;
  payloadId: string;
  timestamp: string;
  lang?: string;
  deploymentMode?: string;
  dtdVersion?: string;
  userAgent?: string;
}): string {
  const deployment = o.deploymentMode ? ` deploymentMode="${escapeXml(o.deploymentMode)}"` : "";
  const inner = `${header({ from: o.from, to: o.to, sender: o.sender, sharedSecret: o.sharedSecret, userAgent: o.userAgent })}
  <Request${deployment}>
    <ProfileRequest/>
  </Request>`;
  return envelope(o.payloadId, o.timestamp, o.lang ?? "en-US", inner, o.dtdVersion);
}

const optionLines = (options: ProfileOption[] | undefined, indent: string): string =>
  (options ?? []).map((opt) => `\n${indent}<Option name="${escapeXml(opt.name)}">${escapeXml(opt.value)}</Option>`).join("");

export function buildProfileResponse(o: {
  payloadId: string;
  timestamp: string;
  /** When these services became available; "should not be in the future". */
  effectiveDate: string;
  lastRefresh?: string;
  options?: ProfileOption[];
  transactions: ProfileTransaction[];
  lang?: string;
  dtdVersion?: string;
}): string {
  const refresh = o.lastRefresh ? ` lastRefresh="${escapeXml(o.lastRefresh)}"` : "";
  const transactions = o.transactions
    .map(
      (t) => `      <Transaction requestName="${escapeXml(t.requestName)}">
        <URL>${escapeXml(t.url)}</URL>${optionLines(t.options, "        ")}
      </Transaction>`,
    )
    .join("\n");
  const inner = `  <Response>
    <Status code="200" text="OK" xml:lang="en"/>
    <ProfileResponse effectiveDate="${escapeXml(o.effectiveDate)}"${refresh}>${optionLines(o.options, "      ")}
${transactions}
    </ProfileResponse>
  </Response>`;
  return envelope(o.payloadId, o.timestamp, o.lang ?? "en-US", inner, o.dtdVersion);
}

// --- Tax, Shipping, Distribution ----------------------------------------------
//
// Content models (identical in the parts used here from DTD 1.2.008 to 1.2.072):
//   Shipping     (Money, Description, …)
//   Tax          (Money, …, Description, TaxDetail*, …)
//   TaxDetail    (TaxableAmount?, TaxAmount, TaxLocation?, …, Description?, …)
//                @category #REQUIRED, @percentageRate, @purpose
//   Distribution (Accounting, Charge)
//   Accounting   (AccountingSegment+)   @name #REQUIRED
//   AccountingSegment (Name, Description)   @id #REQUIRED
//   Charge       (Money)
// A Total — in an order and in a punchback alike — is the cost of the items
// "excluding any tax and shipping" (Reference Guide), so none of these change it.

const money = (amount: number, currency: string): string =>
  `<Money currency="${escapeXml(currency)}">${escapeXml(amount.toFixed(2))}</Money>`;

/** Round to cents, the precision amounts are written with. */
export const cents = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** A tax to emit: the total, and the single rate line it was computed from. */
export interface TaxValue extends ChargeAmount {
  category?: string;
  ratePercent?: number;
  /** The amount the rate was applied to (TaxDetail/TaxableAmount). */
  taxableAmount?: number;
}

/** Apply a party's tax settings to a taxable amount. */
export function computeTax(settings: TaxSettings, taxableAmount: number, currency: string): TaxValue {
  return {
    amount: cents((taxableAmount * settings.ratePercent) / 100),
    currency,
    description: settings.description,
    category: settings.category,
    ratePercent: settings.ratePercent,
    taxableAmount: cents(taxableAmount),
  };
}

function shippingBlock(s: ChargeAmount | undefined, indent: string): string {
  if (!s) return "";
  return `\n${indent}<Shipping>
${indent}  ${money(s.amount, s.currency)}
${indent}  <Description xml:lang="en">${escapeXml(s.description || "Shipping")}</Description>
${indent}</Shipping>`;
}

function taxBlock(t: TaxValue | undefined, indent: string): string {
  if (!t) return "";
  // A TaxDetail needs a category; without one (a tax carried over from a cart
  // that gave only a total) the Tax is emitted as the total alone.
  const rate = t.ratePercent != null ? ` percentageRate="${escapeXml(t.ratePercent)}"` : "";
  const taxable = t.taxableAmount != null ? `\n${indent}    <TaxableAmount>${money(t.taxableAmount, t.currency)}</TaxableAmount>` : "";
  const detail = t.category
    ? `\n${indent}  <TaxDetail purpose="tax" category="${escapeXml(t.category)}"${rate}>${taxable}
${indent}    <TaxAmount>${money(t.amount, t.currency)}</TaxAmount>
${indent}  </TaxDetail>`
    : "";
  return `\n${indent}<Tax>
${indent}  ${money(t.amount, t.currency)}
${indent}  <Description xml:lang="en">${escapeXml(t.description || "Tax")}</Description>${detail}
${indent}</Tax>`;
}

function distributionBlock(a: AccountingSettings | undefined, amount: number, currency: string, indent: string): string {
  if (!a || a.segments.length === 0) return "";
  const segments = a.segments
    .map(
      (seg) => `${indent}    <AccountingSegment id="${escapeXml(seg.id)}">
${indent}      <Name xml:lang="en">${escapeXml(seg.name)}</Name>
${indent}      <Description xml:lang="en">${escapeXml(seg.description)}</Description>
${indent}    </AccountingSegment>`,
    )
    .join("\n");
  return `\n${indent}<Distribution>
${indent}  <Accounting name="${escapeXml(a.name)}">
${segments}
${indent}  </Accounting>
${indent}  <Charge>
${indent}    ${money(amount, currency)}
${indent}  </Charge>
${indent}</Distribution>`;
}

// --- SetupRequest (Mode A: buyer -> supplier) --------------------------------

export interface SetupRequestOptions {
  from: Credential | Credential[];
  to: Credential | Credential[];
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
  /** Optional ShipTo / Contact carried in the setup (Ariba-style); profile-gated upstream. */
  shipTo?: Address;
  contact?: Contact;
  addressMode?: AddressMode;
  /** Prior cart/items carried in an `edit`/`inspect` setup (emitted as ItemOut). */
  items?: OrderRequestItem[];
  /**
   * The catalog item the user punched out from. "PunchOut sites can use it to
   * determine which products to display"; without it the supplier presents its
   * whole store.
   */
  selectedItem?: SelectedItem;
}

// A compact ItemOut for the PunchOutSetupRequest (edit/inspect): no attachments,
// no line-level Comments — just the identity + detail so the supplier can reopen
// the cart / show the item. Shares the classification emitter with OrderRequest.
function setupItemOut(it: OrderRequestItem, idx: number): string {
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
            <Money currency="${escapeXml(it.currency ?? "USD")}">${escapeXml(it.unitPriceAmount ?? 0)}</Money>
          </UnitPrice>
          <Description xml:lang="en">${escapeXml(it.description ?? "")}</Description>
          <UnitOfMeasure>${escapeXml(it.uom ?? "EA")}</UnitOfMeasure>
${classificationBlock(it, "          ")}
        </ItemDetail>
      </ItemOut>`;
}

// Child order is fixed by the DTD:
//   PunchOutSetupRequest (BuyerCookie, Extrinsic*, BrowserFormPost?, Contact*,
//                         SupplierSetup?, ShipTo?, SelectedItem?, ItemOut*)
export function buildSetupRequest(o: SetupRequestOptions): string {
  const lang = o.lang ?? "en-US";
  const deployment = o.deploymentMode
    ? ` deploymentMode="${escapeXml(o.deploymentMode)}"`
    : "";
  const mode = o.addressMode ?? "full";
  const shipTo = o.shipTo ? `\n${addressBlock("ShipTo", o.shipTo, mode, o.dtdVersion)}` : "";
  const contact = o.contact ? `\n${contactBlock(o.contact, mode, "      ", o.dtdVersion)}` : "";
  const items = o.items && o.items.length > 0 ? `\n${o.items.map((it, i) => setupItemOut(it, i + 1)).join("\n")}` : "";
  // SelectedItem (ItemID), placed after ShipTo and before any ItemOut.
  const selected = o.selectedItem?.supplierPartId
    ? `\n      <SelectedItem>
        <ItemID>
          <SupplierPartID>${escapeXml(o.selectedItem.supplierPartId)}</SupplierPartID>${
            o.selectedItem.supplierPartAuxiliaryId
              ? `\n          <SupplierPartAuxiliaryID>${escapeXml(o.selectedItem.supplierPartAuxiliaryId)}</SupplierPartAuxiliaryID>`
              : ""
          }
        </ItemID>
      </SelectedItem>`
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
      <BuyerCookie>${escapeXml(o.buyerCookie)}</BuyerCookie>${extrinsicBlock(o.extrinsics, "      ")}
      <BrowserFormPost>
        <URL>${escapeXml(o.browserFormPostUrl)}</URL>
      </BrowserFormPost>${contact}${shipTo}${selected}${items}
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
  from: Credential | Credential[];
  to: Credential | Credential[];
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
  shipTo?: Address;
  billTo?: Address;
  contact?: Contact;
  /** Address emission style; defaults to "full" (the historical output). */
  addressMode?: AddressMode;
  attachments?: OrderAttachmentMeta[];
  dtdVersion?: string;
  userAgent?: string;
  extrinsics?: ExtrinsicVal[];
  /**
   * Header Shipping and Tax. "If the Shipping element is present in the
   * OrderRequestHeader, it must not appear in the ItemOut elements", so shipping
   * is only ever emitted here. A header Tax is the total tax for the order.
   */
  shipping?: ChargeAmount;
  tax?: TaxValue;
  /** When set, every ItemOut also carries its own Tax, computed from these settings. */
  lineTax?: TaxSettings;
  /** When set, every ItemOut carries a Distribution charging its line amount to this accounting. */
  accounting?: AccountingSettings;
  /** OrderRequestHeader/@type: a new order (default), a change, or a cancellation. */
  type?: OrderType;
  /** OrderRequestHeader/@orderVersion — 1 for the original, +1 per change order. */
  orderVersion?: number;
  /**
   * payloadID of the most recent OrderRequest for this order. Required by the
   * standard on `update` and `delete`, emitted as DocumentReference.
   */
  documentReferencePayloadId?: string;
}

export type OrderType = "new" | "update" | "delete";

// --- Address / Contact emission ----------------------------------------------
//
// `mode` controls how an <Address> is rendered: a bare `addressID` reference
// (id-only), a full <PostalAddress> (full), or both. The default is "full",
// which reproduces the tool's historical ShipTo/BillTo output byte-for-byte.

const wantsId = (m: AddressMode) => m === "id-only" || m === "both";
const wantsPostal = (m: AddressMode) => m === "full" || m === "both";
const hasPostal = (a: Address) => !!(a.deliverTo || a.street || a.city || a.state || a.postalCode);

function idAttrs(a: Address, mode: AddressMode, dtdVersion?: string): string {
  if (!wantsId(mode) || !a.addressId) return "";
  const domain = a.addressIdDomain && dtdAtLeast(dtdVersion, ADDRESS_ID_DOMAIN_SINCE) ? ` addressIDDomain="${escapeXml(a.addressIdDomain)}"` : "";
  return ` addressID="${escapeXml(a.addressId)}"${domain}`;
}

function postalBlock(a: Address, indent: string): string {
  return `${indent}<PostalAddress>
${a.deliverTo ? `${indent}  <DeliverTo>${escapeXml(a.deliverTo)}</DeliverTo>\n` : ""}${indent}  <Street>${escapeXml(a.street ?? "")}</Street>
${indent}  <City>${escapeXml(a.city ?? "")}</City>
${indent}  <State>${escapeXml(a.state ?? "")}</State>
${indent}  <PostalCode>${escapeXml(a.postalCode ?? "")}</PostalCode>
${indent}  <Country isoCountryCode="${escapeXml(a.countryIsoCode ?? "US")}">${escapeXml(a.countryName ?? "United States")}</Country>
${indent}</PostalAddress>`;
}

/**
 * Split a free-form phone number into the three parts the DTD requires:
 *   TelephoneNumber (CountryCode, AreaOrCityCode, Number, Extension?)
 * An international number written with separators ("+48 12 345 67 89",
 * "+1 (415) 555-0100") yields country code / area code / local number. Anything
 * else goes whole into Number, with the other two elements present but empty.
 */
export function splitPhone(raw: string): { countryCode: string; areaCode: string; number: string } {
  const s = raw.trim();
  const groups = s.replace(/^\+/, "").split(/[^0-9]+/).filter(Boolean);
  if (s.startsWith("+") && groups.length >= 3) {
    return { countryCode: groups[0], areaCode: groups[1], number: groups.slice(2).join("") };
  }
  if (s.startsWith("+") && groups.length === 2) {
    return { countryCode: groups[0], areaCode: "", number: groups[1] };
  }
  return { countryCode: "", areaCode: "", number: s };
}

function contactInfo(a: Address, indent: string): string {
  const email = a.email ? `\n${indent}<Email>${escapeXml(a.email)}</Email>` : "";
  let phone = "";
  if (a.phone) {
    const p = splitPhone(a.phone);
    phone = `\n${indent}<Phone><TelephoneNumber><CountryCode isoCountryCode="${escapeXml(a.countryIsoCode ?? "US")}">${escapeXml(p.countryCode)}</CountryCode><AreaOrCityCode>${escapeXml(p.areaCode)}</AreaOrCityCode><Number>${escapeXml(p.number)}</Number></TelephoneNumber></Phone>`;
  }
  return email + phone;
}

function addressBlock(tag: "ShipTo" | "BillTo", a: Address, mode: AddressMode, dtdVersion?: string): string {
  const postal = wantsPostal(mode) ? `\n${postalBlock(a, "          ")}` : "";
  return `      <${tag}>
        <Address${idAttrs(a, mode, dtdVersion)}>
          <Name xml:lang="en">${escapeXml(a.name ?? "")}</Name>${postal}${contactInfo(a, "          ")}
        </Address>
      </${tag}>`;
}

function contactBlock(c: Contact, mode: AddressMode, indent: string, dtdVersion?: string): string {
  const postal = mode !== "id-only" && hasPostal(c) ? `\n${postalBlock(c, indent + "  ")}` : "";
  return `${indent}<Contact role="${escapeXml(c.role || "endUser")}"${idAttrs(c, mode, dtdVersion)}>
${indent}  <Name xml:lang="en">${escapeXml(c.name ?? "")}</Name>${postal}${contactInfo(c, indent + "  ")}
${indent}</Contact>`;
}

function commentsWithAttachments(cids: string[], indent: string): string {
  if (cids.length === 0) return "";
  const atts = cids
    .map(
      (cid) =>
        `${indent}  <Attachment>\n${indent}    <URL>cid:${escapeXml(cid)}</URL>\n${indent}  </Attachment>`,
    )
    .join("\n");
  return `\n${indent}<Comments xml:lang="en">\n${atts}\n${indent}</Comments>`;
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
      // ItemOut child order: ItemID, ItemDetail, …, Tax?, …, Distribution*, …,
      // Comments*, …, ScheduleLine*.
      const lineCurrency = it.currency ?? o.currency;
      const lineAmount = cents((it.unitPriceAmount ?? 0) * it.quantity);
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
          }
        </ItemDetail>${taxBlock(
          o.lineTax ? computeTax(o.lineTax, lineAmount, lineCurrency) : undefined,
          "        ",
        )}${distributionBlock(o.accounting, lineAmount, lineCurrency, "        ")}${commentsWithAttachments(cids, "        ")}${scheduleLinesBlock(it, o.dtdVersion, "        ")}
      </ItemOut>`;
    })
    .join("\n");

  const mode = o.addressMode ?? "full";
  const contact = o.contact ? `\n${contactBlock(o.contact, mode, "        ", o.dtdVersion)}` : "";
  const type: OrderType = o.type ?? "new";
  const version =
    o.orderVersion != null && dtdAtLeast(o.dtdVersion, ORDER_VERSION_SINCE) ? ` orderVersion="${escapeXml(o.orderVersion)}"` : "";
  const docRef = o.documentReferencePayloadId
    ? `\n        <DocumentReference payloadID="${escapeXml(o.documentReferencePayloadId)}"/>`
    : "";
  // Header child order is fixed by the DTD: Total, ShipTo?, BillTo, …,
  // Shipping?, Tax?, Payment?, PaymentTerm*, Contact*, Comments*, Followup?,
  // ControlKeys?, DocumentReference?, … Extrinsic*. Item-level Comments belong
  // to ItemOut (after ItemDetail), not inside ItemDetail.
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
      )}" type="${type}"${version}>
        <Total>
          <Money currency="${escapeXml(o.currency)}">${escapeXml(o.total)}</Money>
        </Total>
${addressBlock("ShipTo", o.shipTo ?? {}, mode, o.dtdVersion)}
${addressBlock("BillTo", o.billTo ?? {}, mode, o.dtdVersion)}${shippingBlock(o.shipping, "        ")}${taxBlock(o.tax, "        ")}${contact}${commentsWithAttachments(orderLevelCids, "        ")}${docRef}${extrinsicBlock(
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

// A Response carries no Header: the DTD's envelope is
//   cXML (((Header, (Message | Request)) | Response), ds:Signature*)
// so From/To/Sender appear only on requests and on the punchback Message.

export function buildSetupResponse(o: {
  payloadId: string;
  timestamp: string;
  startPageUrl: string;
  statusCode?: string;
  statusText?: string;
  lang?: string;
  dtdVersion?: string;
}): string {
  const inner = `  <Response>
    <Status code="${escapeXml(o.statusCode ?? "200")}" text="${escapeXml(
      o.statusText ?? "OK",
    )}" xml:lang="en"/>
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
  /** Human-readable Status body (order number, rejection reason). Defaults to the text for non-OK statuses. */
  message?: string;
  lang?: string;
  dtdVersion?: string;
}): string {
  const message = o.message ?? (o.statusText === "OK" || !o.statusText ? "" : o.statusText);
  const inner = `  <Response>
    <Status code="${escapeXml(o.statusCode ?? "200")}" text="${escapeXml(
      o.statusText ?? "OK",
    )}" xml:lang="en">${escapeXml(message)}</Status>
  </Response>`;
  return envelope(o.payloadId, o.timestamp, o.lang ?? "en-US", inner, o.dtdVersion);
}

export interface PunchbackOptions {
  from: Credential | Credential[];
  to: Credential | Credential[];
  sender: Credential;
  buyerCookie: string;
  payloadId: string;
  timestamp: string;
  lang?: string;
  currency: string;
  items: CartItem[];
  dtdVersion?: string;
  /**
   * Highest operation the buyer may later perform on this cart (a required
   * attribute): `create` allows none, `inspect` a read-only reopen, `edit` both.
   */
  operationAllowed?: OperationAllowed;
  /** Shipping and tax the supplier computed for this cart (header level). */
  shipping?: ChargeAmount;
  tax?: TaxValue;
  /**
   * Optional Message/Status. Code 204 "No Content" ends the session without any
   * change to the shopping cart (the user cancelled); the cart is then empty.
   */
  status?: { code: string; text: string };
}

export type OperationAllowed = "create" | "inspect" | "edit";

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

  const status = o.status
    ? `\n    <Status code="${escapeXml(o.status.code)}" text="${escapeXml(o.status.text)}" xml:lang="en"/>`
    : "";
  const inner = `${header({ from: o.from, to: o.to, sender: o.sender })}
  <Message>${status}
    <PunchOutOrderMessage>
      <BuyerCookie>${escapeXml(o.buyerCookie)}</BuyerCookie>
      <PunchOutOrderMessageHeader operationAllowed="${escapeXml(o.operationAllowed ?? "create")}">
        <Total>
          <Money currency="${escapeXml(o.currency)}">${escapeXml(total.toFixed(2))}</Money>
        </Total>${shippingBlock(o.shipping, "        ")}${taxBlock(o.tax, "        ")}
      </PunchOutOrderMessageHeader>${items ? `\n${items}` : ""}
    </PunchOutOrderMessage>
  </Message>`;
  return envelope(o.payloadId, o.timestamp, o.lang ?? "en-US", inner, o.dtdVersion);
}
