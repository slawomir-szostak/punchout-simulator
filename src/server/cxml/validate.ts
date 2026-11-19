import {
  asArray,
  attr,
  collectCidReferences,
  getDocType,
  getHeaderCredentials,
  getPayloadId,
  getStartPage,
  getStatus,
  getTimestamp,
  parseXml,
  root,
  text,
  type ParsedDoc,
} from "./parse.js";
import type {
  Credential,
  DocType,
  ValidationIssue,
  ValidationResult,
} from "./types.js";

// Bidirectional cXML validation (spec section 8). Runs on every document,
// inbound and outbound. Full DTD validation would require a native validating
// parser (which would hurt `npx` portability — spec section 6), so we do
// well-formedness via fast-xml-parser plus thorough field-level rules, which
// is the high-value half of the linter for sellers checking their own output.
//
// The rules below are written against the cXML 1.2.072 DTD and the cXML
// Reference Guide. Severity follows one convention:
//   error   — the DTD requires it (a required attribute or element, an
//             enumerated value) or the transaction cannot be processed;
//   warning — the Reference Guide says "must"/"should" but a receiver can
//             usually still process the document (date formats, DOCTYPE);
//   info    — permitted but deprecated or merely worth knowing.

/** The credentials/auth expected for this exchange, resolved from a connection. */
export interface ExpectedCredentials {
  from?: Credential;
  to?: Credential;
  sender?: Credential;
  sharedSecret?: string;
}

export interface ValidationContext {
  expected?: ExpectedCredentials;
  /** Expected BuyerCookie for the session (punchback correlation). */
  expectedBuyerCookie?: string;
  /** Normalized Content-IDs present in a multipart envelope, for cid resolution. */
  availableContentIds?: Set<string>;
  /** Force the doc type rather than inferring it (e.g. when shape is ambiguous). */
  forceDocType?: DocType;
  /**
   * When true, a document spanning multiple currencies is reported as a warning
   * instead of an error (the receiving supplier handles multi-currency orders).
   * Resolved from the supplier involved in the exchange.
   */
  allowMixedCurrency?: boolean;
  /**
   * PunchOutSetupRequest/@operation of the session a punchback belongs to. Decides
   * how an empty or non-empty cart must be read (Reference Guide, "Empty
   * Shopping Carts").
   */
  setupOperation?: string;
  /**
   * The most recent earlier OrderRequest for the same orderID, when the caller
   * can know it: `null` means "none on record", `undefined` "not checked".
   * An update/delete must reference it through DocumentReference.
   */
  priorOrder?: { payloadId?: string; orderVersion?: number } | null;
  /** DTD version the sender's platform profile uses for this document type. */
  expectedDtdVersion?: string;
  /**
   * For a setup arriving at the mock supplier: the operationAllowed that
   * supplier returns with its carts, to flag an edit/inspect it never permitted.
   */
  supplierOperationAllowed?: string;
}

class Issues {
  list: ValidationIssue[] = [];
  error(code: string, message: string, path?: string) {
    this.list.push({ severity: "error", code, message, path });
  }
  warn(code: string, message: string, path?: string) {
    this.list.push({ severity: "warning", code, message, path });
  }
  info(code: string, message: string, path?: string) {
    this.list.push({ severity: "info", code, message, path });
  }
}

function isValidUrl(s: string | undefined): boolean {
  if (!s) return false;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function credEq(a: Credential | undefined, b: Credential | undefined): boolean {
  if (!a || !b) return false;
  return a.domain === b.domain && a.identity === b.identity;
}

function credKnown(c: Credential | undefined, exp: ExpectedCredentials): boolean {
  if (!c) return false;
  return [exp.from, exp.to, exp.sender].some((k) => credEq(c, k));
}

// --- general checks ----------------------------------------------------------

function checkGeneral(doc: ParsedDoc, ctx: ValidationContext, issues: Issues, docType: DocType) {
  const payloadId = getPayloadId(doc);
  if (!payloadId) {
    issues.error("missing-payloadID", "cXML/@payloadID is missing", "cXML/@payloadID");
  } else if (!payloadId.includes("@")) {
    issues.warn(
      "payloadID-format",
      "payloadID should have the form <unique>@<host>",
      "cXML/@payloadID",
    );
  }

  const timestamp = getTimestamp(doc);
  if (!timestamp) {
    issues.error("missing-timestamp", "cXML/@timestamp is missing", "cXML/@timestamp");
  } else {
    checkDateTime(timestamp, "timestamp", "cXML/@timestamp", issues);
  }

  checkDoctype(doc, ctx, issues);
  checkXmlLang(doc, issues);

  if (!ctx.expected) return;
  // Only requests and the punchback carry a <Header> with From/To/Sender by spec.
  // Response documents (SetupResponse, OrderResponse) legitimately have no Header,
  // so don't flag missing credentials on them.
  const carriesHeader =
    docType === "SetupRequest" || docType === "OrderRequest" || docType === "PunchOutOrderMessage";
  if (!carriesHeader) return;
  const exp = ctx.expected;
  const creds = getHeaderCredentials(doc);
  // A party may carry several credentials — one organization in different
  // domains. Reference Guide, "Multiple Credentials": validate every credential
  // whose domain we recognize and reject a mismatch; reject two credentials of
  // the same domain with different values. Credentials in domains we don't
  // know are not ours to judge.
  const knownDomains = new Set(
    [exp.from, exp.to, exp.sender].filter((k): k is Credential => !!k).map((k) => k.domain),
  );

  for (const [name, list] of [
    ["From", creds.fromAll],
    ["To", creds.toAll],
    ["Sender", creds.senderAll],
  ] as const) {
    const path = `cXML/Header/${name}`;
    if (list.length === 0) {
      issues.warn("missing-credential", `Header/${name} credential is missing`, path);
      continue;
    }
    const seen = new Map<string, string>();
    for (const c of list) {
      if (!c.domain) issues.warn("credential-domain", `Header/${name}/Credential/@domain is empty`, path);
      if (!c.identity) issues.warn("credential-identity", `Header/${name}/Credential/Identity is empty`, path);
      if (!c.domain || !c.identity) continue;
      const earlier = seen.get(c.domain);
      if (earlier != null && earlier !== c.identity) {
        issues.error(
          "credential-domain-conflict",
          `Header/${name} has two credentials in domain "${c.domain}" with different identities (${earlier}, ${c.identity})`,
          path,
        );
      }
      seen.set(c.domain, c.identity);
    }
    const complete = list.filter((c) => c.domain && c.identity);
    const recognized = complete.filter((c) => knownDomains.has(c.domain));
    // Nothing in a domain we know: judge the party by what it did send.
    for (const c of recognized.length > 0 ? recognized : complete) {
      if (credKnown(c, exp)) continue;
      issues.warn(
        "credential-mismatch",
        `Header/${name} (${c.domain}/${c.identity}) does not match any identity configured on the connection`,
        path,
      );
    }
  }
}

// --- format checks -------------------------------------------------------------

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

// cXML dates and times use the restricted ISO 8601 subset of the W3C "Date and
// Time Formats" note: a complete date plus hours, minutes and seconds, in local
// time with a numeric offset from UTC. The DTD types these `datetime.tz` ("Time
// zone is required"), and the Reference Guide adds that the "Z" designator is
// not allowed.
function checkDateTime(value: string, what: string, path: string, issues: Issues): void {
  const m = DATE_TIME.exec(value.trim());
  if (!m || Number.isNaN(Date.parse(m[2] ? value.trim() : `${value.trim()}Z`))) {
    issues.error(
      `${what}-format`,
      `${path} "${value}" is not an ISO 8601 date-time (expected YYYY-MM-DDThh:mm:ss±hh:mm)`,
      path,
    );
    return;
  }
  if (!m[2]) {
    issues.warn(`${what}-no-timezone`, `${path} "${value}" has no time zone; cXML requires an offset from UTC (e.g. -08:00)`, path);
  } else if (m[2] === "Z") {
    issues.warn(`${what}-utc-designator`, `${path} "${value}" uses the "Z" designator; cXML requires a numeric offset from UTC (e.g. +00:00)`, path);
  }
}

const DOCTYPE = /<!DOCTYPE\s+(\S+)(?:\s+SYSTEM\s+(["'])(.*?)\2)?/;
const CXML_DTD_URL = /^https?:\/\/xml\.cxml\.org\/schemas\/cXML\/(\d+\.\d+\.\d+)\/[A-Za-z]+\.dtd$/;

// "The second line in cXML documents must contain the DOCTYPE document type
// declaration" (Reference Guide). It names the DTD version the sender built
// the document against, which is how a receiver knows what to expect.
function checkDoctype(doc: ParsedDoc, ctx: ValidationContext, issues: Issues): void {
  const m = DOCTYPE.exec(doc.raw);
  if (!m) {
    issues.warn("missing-doctype", "The document has no <!DOCTYPE cXML SYSTEM \"…/cXML.dtd\"> declaration", "DOCTYPE");
    return;
  }
  const url = m[3] ?? "";
  const version = CXML_DTD_URL.exec(url)?.[1];
  if (m[1] !== "cXML" || !version) {
    issues.warn(
      "doctype-unrecognized",
      `DOCTYPE does not reference a cXML DTD at http://xml.cxml.org/schemas/cXML/<version>/ (found ${m[1]}${url ? ` "${url}"` : ""})`,
      "DOCTYPE",
    );
    return;
  }
  if (ctx.expectedDtdVersion && version !== ctx.expectedDtdVersion) {
    issues.info(
      "dtd-version-differs",
      `Document declares cXML ${version}; the sender's platform profile uses ${ctx.expectedDtdVersion} for this document type`,
      "DOCTYPE",
    );
  }
}

// Elements whose xml:lang the DTD marks #REQUIRED, and those where it is
// #IMPLIED but "will be required in a future version (leaving it out is
// deprecated)".
const LANG_REQUIRED = ["Description", "Name"];
const LANG_RECOMMENDED = ["Comments", "Status"];

function checkXmlLang(doc: ParsedDoc, issues: Issues): void {
  const missing = new Map<string, number>();
  const visit = (key: string, node: any): void => {
    for (const n of asArray(node)) {
      if (LANG_REQUIRED.includes(key) || LANG_RECOMMENDED.includes(key)) {
        if (attr(n, "xml:lang") == null) missing.set(key, (missing.get(key) ?? 0) + 1);
      }
      if (n && typeof n === "object") {
        for (const [k, v] of Object.entries(n)) {
          // Extrinsic and BuyerCookie are declared ANY: their content is opaque.
          if (!k.startsWith("@_") && k !== "#text" && k !== "Extrinsic" && k !== "BuyerCookie") visit(k, v);
        }
      }
    }
  };
  const cxml = root(doc);
  if (!cxml || typeof cxml !== "object") return;
  for (const [k, v] of Object.entries(cxml)) if (!k.startsWith("@_") && k !== "#text") visit(k, v);

  for (const name of LANG_REQUIRED) {
    const n = missing.get(name);
    if (n) issues.error(`${name.toLowerCase()}-missing-xml-lang`, `${n} <${name}> element(s) lack the required xml:lang attribute`, `…/${name}/@xml:lang`);
  }
  const recommended = LANG_RECOMMENDED.filter((name) => missing.has(name));
  if (attr(cxml, "xml:lang") == null) recommended.unshift("cXML");
  if (recommended.length > 0) {
    issues.info(
      "xml-lang-recommended",
      `xml:lang is missing on ${recommended.map((r) => `<${r}>`).join(", ")} — optional today, but leaving it out is deprecated`,
      "@xml:lang",
    );
  }
}

/** String comparison whose duration doesn't depend on where the inputs first
 *  differ, so response timing can't be used to recover a secret a character at
 *  a time. (Pure JS: this module is not tied to node:crypto.) */
function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ b.charCodeAt(i);
  return diff === 0;
}

function checkSharedSecret(doc: ParsedDoc, ctx: ValidationContext, issues: Issues) {
  const exp = ctx.expected;
  if (!exp) return;
  const creds = getHeaderCredentials(doc);
  if (!creds.sharedSecret) {
    issues.warn(
      "missing-sharedsecret",
      "Sender/Credential/SharedSecret is absent (required for SharedSecret auth)",
      "cXML/Header/Sender/Credential/SharedSecret",
    );
  } else if (exp.sharedSecret && !constantTimeEqual(creds.sharedSecret, exp.sharedSecret)) {
    issues.error(
      "sharedsecret-mismatch",
      "Sender SharedSecret does not match the connection's configured shared secret",
      "cXML/Header/Sender/Credential/SharedSecret",
    );
  }
}

// --- document-specific checks ------------------------------------------------

function checkSetupResponse(doc: ParsedDoc, issues: Issues) {
  const status = getStatus(doc);
  if (!status.code) {
    issues.error("missing-status", "Response/Status/@code is missing", "cXML/Response/Status");
  } else if (status.code !== "200") {
    issues.error(
      "status-not-200",
      `PunchOutSetupResponse Status is ${status.code} (expected 200)`,
      "cXML/Response/Status",
    );
  }
  const startPage = getStartPage(doc);
  if (!startPage) {
    issues.error(
      "missing-startpage",
      "PunchOutSetupResponse/StartPage/URL is missing",
      "cXML/Response/PunchOutSetupResponse/StartPage/URL",
    );
  } else if (!isValidUrl(startPage)) {
    issues.error(
      "invalid-startpage-url",
      `StartPage/URL is not a valid http(s) URL: ${startPage}`,
      "cXML/Response/PunchOutSetupResponse/StartPage/URL",
    );
  }
}

function num(s: string | undefined): number | undefined {
  if (s == null || s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function checkPunchback(doc: ParsedDoc, ctx: ValidationContext, issues: Issues) {
  const pom = root(doc)?.Message?.PunchOutOrderMessage;
  if (!pom) {
    issues.error("missing-pom", "Message/PunchOutOrderMessage is missing", "cXML/Message");
    return;
  }
  const buyerCookie = text(pom.BuyerCookie);
  if (!buyerCookie) {
    issues.error("missing-buyercookie", "BuyerCookie is missing", "cXML/Message/PunchOutOrderMessage/BuyerCookie");
  } else if (ctx.expectedBuyerCookie && buyerCookie !== ctx.expectedBuyerCookie) {
    issues.error(
      "buyercookie-mismatch",
      `BuyerCookie "${buyerCookie}" does not match the session "${ctx.expectedBuyerCookie}"`,
      "cXML/Message/PunchOutOrderMessage/BuyerCookie",
    );
  }

  const headerNode = pom.PunchOutOrderMessageHeader;
  const totalMoney = headerNode?.Total?.Money;
  const totalAmount = num(text(totalMoney));
  const totalCurrency = attr(totalMoney, "currency");
  if (totalMoney == null) {
    issues.error("missing-total", "PunchOutOrderMessageHeader/Total/Money is missing", "cXML/.../PunchOutOrderMessageHeader/Total");
  } else if (!totalCurrency) {
    issues.error("missing-total-currency", "Total/Money/@currency is missing", "cXML/.../Total/Money");
  }

  // operationAllowed is #REQUIRED and enumerated; quoteStatus is enumerated.
  const allowed = attr(headerNode, "operationAllowed");
  if (headerNode != null && !["create", "inspect", "edit"].includes(allowed ?? "")) {
    issues.error(
      "pom-invalid-operationallowed",
      allowed == null
        ? "PunchOutOrderMessageHeader/@operationAllowed is missing (required: create, inspect or edit)"
        : `PunchOutOrderMessageHeader/@operationAllowed="${allowed}" is not one of create, inspect, edit`,
      "cXML/.../PunchOutOrderMessageHeader/@operationAllowed",
    );
  }
  const quoteStatus = attr(headerNode, "quoteStatus");
  if (quoteStatus != null && quoteStatus !== "pending" && quoteStatus !== "final") {
    issues.error("pom-invalid-quotestatus", `PunchOutOrderMessageHeader/@quoteStatus="${quoteStatus}" is not one of pending, final`, "cXML/.../PunchOutOrderMessageHeader/@quoteStatus");
  }

  // "The authentication element should not be sent within Message documents
  // transported via an end user's browser" (DTD, Credential).
  if (getHeaderCredentials(doc).sharedSecret != null) {
    issues.warn(
      "sharedsecret-in-message",
      "The punchback carries a SharedSecret. It travels through the user's browser, so authentication elements should not be sent in a Message",
      "cXML/Header/Sender/Credential/SharedSecret",
    );
  }

  // An empty cart is legitimate; what it means depends on the session's
  // operation and on Message/Status (Reference Guide, "Empty Shopping Carts").
  const items = asArray(pom.ItemIn);
  const statusCode = attr(root(doc)?.Message?.Status, "code");
  const op = ctx.setupOperation;
  if (statusCode === "204" && items.length > 0) {
    issues.warn(
      "status-204-with-items",
      "Message/Status is 204 (session ended without change) but the cart contains ItemIn elements; a 204 punchback should carry none",
      "cXML/Message/Status",
    );
  }
  if (op === "inspect" && items.length > 0) {
    issues.warn(
      "inspect-returned-items",
      'The session was operation="inspect": the supplier should return no ItemIn elements, and the buyer must ignore the ones sent',
      "cXML/.../PunchOutOrderMessage",
    );
  }
  if (items.length === 0) {
    const meaning =
      op === "edit"
        ? statusCode === "204"
          ? "the user cancelled an edit session without change: the requisition keeps its items"
          : "an edit session returned empty: its existing items must be deleted from the requisition"
        : op === "inspect"
          ? "expected for an inspect session"
          : "the session was cancelled: no items are added to the requisition";
    issues.info("empty-cart", `PunchOutOrderMessage contains no ItemIn elements — ${meaning}`, "cXML/.../PunchOutOrderMessage");
  }

  let lineSum = 0;
  const lineCurrencies: string[] = [];
  items.forEach((it, i) => {
    const base = `cXML/.../ItemIn[${i + 1}]`;
    const qty = num(attr(it, "quantity"));
    if (qty == null) {
      issues.error("item-missing-quantity", `ItemIn[${i + 1}] is missing @quantity`, base);
    }
    if (!text(it?.ItemID?.SupplierPartID)) {
      issues.error("item-missing-supplierpartid", `ItemIn[${i + 1}] is missing ItemID/SupplierPartID`, `${base}/ItemID`);
    }
    const detail = it?.ItemDetail;
    if (!detail) {
      issues.error("item-missing-detail", `ItemIn[${i + 1}] is missing ItemDetail`, base);
      return;
    }
    const up = detail.UnitPrice?.Money;
    const upAmount = num(text(up));
    const upCurrency = attr(up, "currency");
    if (up == null) {
      issues.error("item-missing-unitprice", `ItemIn[${i + 1}] is missing ItemDetail/UnitPrice/Money`, `${base}/ItemDetail/UnitPrice`);
    } else if (!upCurrency) {
      issues.error("item-missing-currency", `ItemIn[${i + 1}] UnitPrice/Money is missing @currency`, `${base}/ItemDetail/UnitPrice/Money`);
    } else {
      lineCurrencies.push(upCurrency);
    }
    if (!text(detail.Description)) {
      issues.error("item-missing-description", `ItemIn[${i + 1}] is missing ItemDetail/Description`, `${base}/ItemDetail/Description`);
    }
    if (!text(detail.UnitOfMeasure)) {
      issues.error("item-missing-uom", `ItemIn[${i + 1}] is missing ItemDetail/UnitOfMeasure`, `${base}/ItemDetail/UnitOfMeasure`);
    }
    const classification = Array.isArray(detail.Classification)
      ? detail.Classification[0]
      : detail.Classification;
    if (classification == null) {
      issues.error("item-missing-classification", `ItemIn[${i + 1}] is missing ItemDetail/Classification`, `${base}/ItemDetail/Classification`);
    } else if (!attr(classification, "domain")) {
      issues.error("item-classification-domain", `ItemIn[${i + 1}] Classification is missing @domain`, `${base}/ItemDetail/Classification`);
    }
    if (qty != null && upAmount != null) lineSum += qty * upAmount;
  });

  // A cXML Total is a single Money — every line and the Total must share one
  // currency. Mixing them is invalid (real receivers reject it), so it's an
  // error, not a warning.
  const singleCurrency = checkSingleCurrency(
    lineCurrencies,
    totalCurrency,
    issues,
    "cXML/.../PunchOutOrderMessageHeader/Total",
    ctx.allowMixedCurrency,
  );

  const headerPath = "cXML/.../PunchOutOrderMessageHeader";
  const charges = checkCharges(headerNode, items, totalCurrency, headerPath, issues);

  // Total consistency: sum of (quantity * unit price) vs the header Total. Only
  // meaningful when the document is single-currency (otherwise the mock supplier
  // deliberately sends Total 0 and the mixed-currency error above already fired).
  if (singleCurrency && totalAmount != null && items.length > 0) {
    checkTotal(totalAmount, lineSum, charges, `${headerPath}/Total`, issues);
  }
}

// The Total "contains the total cost for the items …, excluding any tax and
// shipping" (Reference Guide, for the order and the punchback alike). A Total
// that equals goods + charges is the classic mistake, so it gets its own message.
function checkTotal(total: number, lineSum: number, charges: number, path: string, issues: Issues): void {
  if (Math.abs(total - lineSum) <= 0.01) return;
  if (charges > 0 && Math.abs(total - (lineSum + charges)) <= 0.01) {
    issues.warn(
      "total-includes-charges",
      `Header Total (${total.toFixed(2)}) includes tax and/or shipping (${charges.toFixed(2)}); the Total must be the cost of the items only (${lineSum.toFixed(2)})`,
      path,
    );
    return;
  }
  issues.warn("total-mismatch", `Header Total (${total.toFixed(2)}) does not equal the sum of line totals (${lineSum.toFixed(2)})`, path);
}

const moneyOf = (node: any): { amount?: number; currency?: string } => {
  const m = node?.Money;
  return m == null ? {} : { amount: num(text(m)), currency: attr(m, "currency") };
};

// One <Tax> element: structure the DTD requires, and internal consistency.
// Returns the tax amount (0 when unreadable).
function checkTax(tax: any, path: string, issues: Issues): number {
  const total = moneyOf(tax);
  if (total.amount == null || text(tax?.Description) == null) {
    issues.error("tax-incomplete", `${path} must contain Money and a Description`, path);
  }
  const details = asArray(tax?.TaxDetail);
  let detailSum = 0;
  let readable = details.length > 0;
  details.forEach((d, i) => {
    const dp = `${path}/TaxDetail[${i + 1}]`;
    if (!attr(d, "category")) issues.error("taxdetail-missing-category", `${dp} is missing the required @category (e.g. sales, vat, gst)`, dp);
    const amount = moneyOf(d?.TaxAmount).amount;
    if (amount == null) {
      issues.error("taxdetail-missing-amount", `${dp} is missing TaxAmount/Money`, dp);
      readable = false;
      return;
    }
    detailSum += amount;
    const rate = num(attr(d, "percentageRate"));
    const taxable = moneyOf(d?.TaxableAmount).amount;
    if (rate != null && taxable != null && Math.abs((taxable * rate) / 100 - amount) > 0.011) {
      issues.warn(
        "tax-rate-mismatch",
        `${dp}: ${rate}% of ${taxable.toFixed(2)} is ${((taxable * rate) / 100).toFixed(2)}, but TaxAmount is ${amount.toFixed(2)}`,
        dp,
      );
    }
  });
  if (readable && total.amount != null && Math.abs(detailSum - total.amount) > 0.011) {
    issues.warn("tax-detail-mismatch", `${path}/Money (${total.amount.toFixed(2)}) does not equal the sum of its TaxDetail amounts (${detailSum.toFixed(2)})`, path);
  }
  return total.amount ?? 0;
}

// Shipping and Tax at header and line level, for an OrderRequestHeader or a
// PunchOutOrderMessageHeader with its items. Returns header tax + shipping.
function checkCharges(header: any, items: any[], currency: string | undefined, path: string, issues: Issues): number {
  let charges = 0;
  const shipping = header?.Shipping;
  if (shipping != null) {
    const m = moneyOf(shipping);
    if (m.amount == null || text(shipping?.Description) == null) {
      issues.error("shipping-incomplete", `${path}/Shipping must contain Money and a Description`, `${path}/Shipping`);
    }
    if (m.currency && currency && m.currency !== currency) {
      issues.warn("charge-currency-differs", `${path}/Shipping is in ${m.currency}, the Total in ${currency}`, `${path}/Shipping`);
    }
    charges += m.amount ?? 0;
    // "If the Shipping element is present in the OrderRequestHeader, it must
    // not appear in the ItemOut elements."
    const lines = items.map((it, i) => (it?.Shipping != null ? i + 1 : 0)).filter(Boolean);
    if (lines.length > 0) {
      issues.warn("shipping-at-both-levels", `Shipping appears in the header and on line(s) ${lines.join(", ")}; it must be at one level only`, `${path}/Shipping`);
    }
  }

  let lineTax = 0;
  let linesWithTax = 0;
  items.forEach((it, i) => {
    if (it?.Tax == null) return;
    linesWithTax += 1;
    lineTax += checkTax(it.Tax, `cXML/.../Item[${i + 1}]/Tax`, issues);
  });
  if (header?.Tax != null) {
    const amount = checkTax(header.Tax, `${path}/Tax`, issues);
    const cur = moneyOf(header.Tax).currency;
    if (cur && currency && cur !== currency) {
      issues.warn("charge-currency-differs", `${path}/Tax is in ${cur}, the Total in ${currency}`, `${path}/Tax`);
    }
    charges += amount;
    // A header Tax "describes the total tax for an order"; line-level Tax
    // elements describe the line amounts, so they should add up to it.
    if (linesWithTax > 0 && Math.abs(lineTax - amount) > 0.01 * Math.max(1, linesWithTax)) {
      issues.warn("tax-lines-mismatch", `${path}/Tax (${amount.toFixed(2)}) does not equal the sum of the line-level Tax amounts (${lineTax.toFixed(2)})`, `${path}/Tax`);
    }
  }
  return charges;
}

// Distribution "divides the cost of an item among multiple parties".
//   Distribution (Accounting, Charge); Accounting @name #REQUIRED with
//   AccountingSegment+ (@id #REQUIRED) or the deprecated Segment+.
function checkDistributions(item: any, index: number, lineAmount: number | undefined, issues: Issues): void {
  const list = asArray(item?.Distribution);
  if (list.length === 0) return;
  const base = `cXML/.../ItemOut[${index}]/Distribution`;
  let sum = 0;
  let readable = true;
  list.forEach((d, j) => {
    const dp = list.length > 1 ? `${base}[${j + 1}]` : base;
    const acc = d?.Accounting;
    if (acc == null || !attr(acc, "name")) {
      issues.error("accounting-missing-name", `${dp}/Accounting is missing or has no @name`, `${dp}/Accounting`);
    }
    const segments = asArray(acc?.AccountingSegment);
    const legacy = asArray(acc?.Segment);
    if (segments.length === 0 && legacy.length === 0) {
      issues.error("accounting-no-segments", `${dp}/Accounting has no AccountingSegment`, `${dp}/Accounting`);
    }
    if (legacy.length > 0) {
      issues.info("segment-deprecated", `${dp} uses <Segment>; it is deprecated in favour of <AccountingSegment>`, `${dp}/Accounting`);
    }
    if (segments.some((s) => !attr(s, "id"))) {
      issues.error("accountingsegment-missing-id", `${dp}: an AccountingSegment is missing the required @id`, `${dp}/Accounting`);
    }
    const charge = moneyOf(d?.Charge).amount;
    if (charge == null) {
      issues.error("distribution-missing-charge", `${dp} is missing Charge/Money`, `${dp}/Charge`);
      readable = false;
    } else {
      sum += charge;
    }
  });
  if (readable && lineAmount != null && Math.abs(sum - lineAmount) > 0.011) {
    issues.warn(
      "distribution-sum-mismatch",
      `ItemOut[${index}]: its Distribution charges add up to ${sum.toFixed(2)}, but the line amount is ${lineAmount.toFixed(2)}`,
      base,
    );
  }
}

// Returns true when the document is single-currency. When the line items + Total
// span more than one currency it emits `mixed-currency` — an error by default
// (a cXML Total is a single Money; most receivers reject it), or a warning when
// the receiving supplier is configured to handle multi-currency orders.
function checkSingleCurrency(
  lineCurrencies: string[],
  totalCurrency: string | undefined,
  issues: Issues,
  path: string,
  allowMixed = false,
): boolean {
  const all = new Set(lineCurrencies.filter(Boolean));
  if (totalCurrency) all.add(totalCurrency);
  if (all.size > 1) {
    const list = [...all].join(", ");
    if (allowMixed) {
      issues.warn(
        "mixed-currency",
        `Multiple currencies in one document (${list}); allowed for this supplier. The header Total is a single Money — rely on the per-line currencies.`,
        path,
      );
    } else {
      issues.error(
        "mixed-currency",
        `Multiple currencies in one document (${list}). A cXML Total is a single Money — all line items and the Total must share one currency.`,
        path,
      );
    }
    return false;
  }
  return true;
}

// An <Address> should carry either an addressID reference or a usable postal
// address (Street/City). An empty block (no id, blank postal) is flagged so the
// always-emitted-but-unconfigured ShipTo/BillTo doesn't pass silently.
function checkAddressComplete(addr: any, label: "ShipTo" | "BillTo", issues: Issues): void {
  if (addr == null) return;
  const hasId = !!attr(addr, "addressID");
  const postal = addr.PostalAddress;
  const hasPostal = !!(text(postal?.Street) || text(postal?.City));
  if (!hasId && !hasPostal) {
    issues.warn(
      `${label.toLowerCase()}-incomplete`,
      `${label}/Address has neither an addressID nor a Street/City — the address is empty`,
      `cXML/.../OrderRequestHeader/${label}/Address`,
    );
  }
}

function checkOrderRequest(doc: ParsedDoc, ctx: ValidationContext, issues: Issues) {
  const orderReq = root(doc)?.Request?.OrderRequest;
  if (!orderReq) {
    issues.error("missing-orderrequest", "Request/OrderRequest is missing", "cXML/Request");
    return;
  }
  const header = orderReq.OrderRequestHeader;
  if (!attr(header, "orderID")) {
    issues.error("missing-orderid", "OrderRequestHeader/@orderID is missing", "cXML/.../OrderRequestHeader");
  }
  const orderDate = attr(header, "orderDate");
  if (!orderDate) {
    issues.error("missing-orderdate", "OrderRequestHeader/@orderDate is missing", "cXML/.../OrderRequestHeader");
  } else {
    checkDateTime(orderDate, "orderdate", "OrderRequestHeader/@orderDate", issues);
  }
  checkOrderType(header, ctx, issues);
  if (header?.Total?.Money == null) {
    issues.error("missing-order-total", "OrderRequestHeader/Total/Money is missing", "cXML/.../OrderRequestHeader/Total");
  }
  if (!header?.ShipTo) {
    issues.warn("missing-shipto", "OrderRequestHeader/ShipTo is missing", "cXML/.../OrderRequestHeader/ShipTo");
  } else {
    checkAddressComplete(header.ShipTo.Address, "ShipTo", issues);
  }
  if (!header?.BillTo) {
    issues.warn("missing-billto", "OrderRequestHeader/BillTo is missing", "cXML/.../OrderRequestHeader/BillTo");
  } else {
    checkAddressComplete(header.BillTo.Address, "BillTo", issues);
  }
  for (const contact of asArray(header?.Contact)) {
    if (!attr(contact, "role")) {
      issues.warn("contact-missing-role", "OrderRequestHeader/Contact is missing @role", "cXML/.../OrderRequestHeader/Contact");
    }
  }

  const items = asArray(orderReq.ItemOut);
  if (items.length === 0) {
    issues.error("no-itemout", "OrderRequest contains no ItemOut elements", "cXML/.../OrderRequest");
  }
  const lineCurrencies: string[] = [];
  let lineSum = 0;
  let allPriced = items.length > 0;
  items.forEach((it, i) => {
    const base = `cXML/.../ItemOut[${i + 1}]`;
    if (!text(it?.ItemID?.SupplierPartID)) {
      issues.error("itemout-missing-id", `ItemOut[${i + 1}] is missing ItemID/SupplierPartID`, `${base}/ItemID`);
    }
    const up = it?.ItemDetail?.UnitPrice?.Money;
    const qty = num(attr(it, "quantity"));
    const price = num(text(up));
    if (up == null) {
      issues.error("itemout-missing-unitprice", `ItemOut[${i + 1}] is missing ItemDetail/UnitPrice/Money`, `${base}/ItemDetail/UnitPrice`);
    } else {
      const cur = attr(up, "currency");
      if (cur) lineCurrencies.push(cur);
    }
    if (qty == null) {
      issues.error("itemout-missing-quantity", `ItemOut[${i + 1}] is missing @quantity`, base);
    }
    const lineAmount = qty != null && price != null ? qty * price : undefined;
    if (lineAmount == null) allPriced = false;
    else lineSum += lineAmount;
    checkDistributions(it, i + 1, lineAmount, issues);
  });

  const totalCurrency = attr(header?.Total?.Money, "currency");
  const singleCurrency = checkSingleCurrency(lineCurrencies, totalCurrency, issues, "cXML/.../OrderRequestHeader/Total", ctx.allowMixedCurrency);
  const charges = checkCharges(header, items, totalCurrency, "cXML/.../OrderRequestHeader", issues);
  // A blanket order's Total is a maximum commitment, not a sum of its lines.
  const orderTotal = num(text(header?.Total?.Money));
  if (singleCurrency && allPriced && orderTotal != null && attr(header, "orderType") !== "blanket") {
    checkTotal(orderTotal, lineSum, charges, "cXML/.../OrderRequestHeader/Total", issues);
  }

  // Attachment cid resolution (spec section 11). Scan Comments at both levels.
  const refs = collectCidReferences(doc);
  const available = ctx.availableContentIds;
  const referenced = new Set<string>();
  for (const ref of refs) {
    if (ref.external) {
      issues.info(
        "external-attachment",
        `Attachment URL is an external reference (not a cid:): ${ref.rawUrl}`,
        ref.level === "item" ? `cXML/.../ItemOut[${ref.itemIndex}]` : "cXML/.../OrderRequestHeader/Comments",
      );
      continue;
    }
    referenced.add(ref.cid);
    if (available && !available.has(ref.cid)) {
      issues.error(
        "dangling-cid",
        `Attachment references cid:"${ref.cid}" but no multipart part has that Content-ID (dangling attachment)`,
        ref.level === "item" ? `cXML/.../ItemOut[${ref.itemIndex}]/Comments/Attachment` : "cXML/.../OrderRequestHeader/Comments/Attachment",
      );
    }
  }
  // Parts present in the envelope but never referenced by any Attachment.
  if (available) {
    for (const cid of available) {
      if (!referenced.has(cid)) {
        issues.warn(
          "unreferenced-attachment",
          `Multipart part Content-ID "${cid}" is not referenced by any <Attachment><URL>cid:...`,
          "multipart",
        );
      }
    }
  }
}

// OrderRequestHeader/@type is new (the default), update or delete. "Update and
// delete orders must use the DocumentReference element with the payloadID to
// refer to the original purchase order" — more precisely, to the most recent
// OrderRequest for that order, forming a chain back to the type="new" one.
// orderVersion is 1 for the original and goes up by 1 per change order.
function checkOrderType(header: any, ctx: ValidationContext, issues: Issues): void {
  const base = "cXML/.../OrderRequestHeader";
  const type = attr(header, "type") ?? "new";
  if (!["new", "update", "delete"].includes(type)) {
    issues.error("order-invalid-type", `OrderRequestHeader/@type="${type}" is not one of new, update, delete`, `${base}/@type`);
    return;
  }
  const rawVersion = attr(header, "orderVersion");
  const version = rawVersion == null ? undefined : Number(rawVersion);
  if (rawVersion != null && !Number.isFinite(version)) {
    issues.error("order-version-format", `OrderRequestHeader/@orderVersion="${rawVersion}" is not a number`, `${base}/@orderVersion`);
  }
  const docRef = attr(header?.DocumentReference, "payloadID");

  if (type === "new") {
    if (header?.DocumentReference != null) {
      issues.info("order-unexpected-documentreference", 'DocumentReference is only needed when @type is "update" or "delete"', `${base}/DocumentReference`);
    }
    if (version != null && Number.isFinite(version) && version !== 1) {
      issues.warn("order-version", `A new order should carry orderVersion 1 (found ${rawVersion})`, `${base}/@orderVersion`);
    }
    return;
  }

  if (!docRef) {
    issues.error(
      "order-missing-documentreference",
      `An OrderRequest with type="${type}" must reference the previous OrderRequest through DocumentReference/@payloadID`,
      `${base}/DocumentReference`,
    );
  }
  if (version == null) {
    issues.warn("order-version", `A change order (type="${type}") should carry orderVersion (2 for the first change)`, `${base}/@orderVersion`);
  } else if (Number.isFinite(version) && version < 2) {
    issues.warn("order-version", `A change order (type="${type}") should have an orderVersion above 1 (found ${rawVersion})`, `${base}/@orderVersion`);
  }

  const prior = ctx.priorOrder;
  if (prior === undefined) return; // the caller has no order history to compare with
  if (prior === null) {
    issues.warn("order-no-prior", `type="${type}" refers to an order this endpoint has no earlier OrderRequest for`, base);
    return;
  }
  if (docRef && prior.payloadId && docRef !== prior.payloadId) {
    issues.warn(
      "order-documentreference-stale",
      `DocumentReference points at payloadID "${docRef}", but the most recent OrderRequest for this order is "${prior.payloadId}"`,
      `${base}/DocumentReference`,
    );
  }
  if (version != null && Number.isFinite(version) && prior.orderVersion != null && version <= prior.orderVersion) {
    issues.warn(
      "order-version",
      `orderVersion ${rawVersion} does not exceed the previous version ${prior.orderVersion}`,
      `${base}/@orderVersion`,
    );
  }
}

function checkOrderResponse(doc: ParsedDoc, issues: Issues) {
  const status = getStatus(doc);
  if (!status.code) {
    issues.error("missing-status", "Response/Status/@code is missing", "cXML/Response/Status");
  } else {
    const code = Number(status.code);
    if (Number.isFinite(code) && code >= 400) {
      issues.error("status-error", `Response Status is ${status.code} ${status.text ?? ""}`.trim(), "cXML/Response/Status");
    }
  }
}

// --- entry point -------------------------------------------------------------

export function validateDocument(raw: string, ctx: ValidationContext = {}): ValidationResult {
  const doc = parseXml(raw);
  const issues = new Issues();

  if (!doc.wellFormed) {
    issues.error("not-well-formed", `XML is not well-formed: ${doc.wellFormedError}`);
    return { docType: "Unknown", wellFormed: false, ok: false, issues: issues.list };
  }

  const docType = ctx.forceDocType ?? getDocType(doc);
  checkGeneral(doc, ctx, issues, docType);

  switch (docType) {
    case "SetupRequest": {
      checkSharedSecret(doc, ctx, issues);
      const setup = root(doc)?.Request?.PunchOutSetupRequest;
      if (!setup?.BrowserFormPost?.URL) {
        issues.warn("missing-browserformpost", "PunchOutSetupRequest/BrowserFormPost/URL is missing", "cXML/.../PunchOutSetupRequest/BrowserFormPost/URL");
      }
      // edit/inspect reopen prior items, so they should carry ItemOut; create
      // starts an empty cart, so ItemOut there is unexpected.
      // @operation is #REQUIRED: create | inspect | edit | source.
      const rawOp = attr(setup, "operation");
      if (setup != null && !["create", "inspect", "edit", "source"].includes(rawOp ?? "")) {
        issues.error(
          "setup-invalid-operation",
          rawOp == null
            ? "PunchOutSetupRequest/@operation is missing (required: create, inspect, edit or source)"
            : `PunchOutSetupRequest/@operation="${rawOp}" is not one of create, inspect, edit, source`,
          "cXML/.../PunchOutSetupRequest/@operation",
        );
      }
      const op = rawOp ?? "create";
      const granted = ctx.supplierOperationAllowed;
      if (granted && ((op === "edit" && granted !== "edit") || (op === "inspect" && granted === "create"))) {
        issues.warn(
          "setup-operation-not-allowed",
          `operation="${op}" reopens a cart, but this supplier returns its carts with operationAllowed="${granted}", which does not permit it`,
          "cXML/.../PunchOutSetupRequest/@operation",
        );
      }
      const hasItems = asArray(setup?.ItemOut).length > 0;
      if ((op === "edit" || op === "inspect") && !hasItems) {
        issues.warn("setup-missing-items", `operation="${op}" usually carries the prior item(s) as ItemOut, but none are present`, "cXML/.../PunchOutSetupRequest");
      }
      if (op === "create" && hasItems) {
        issues.warn("setup-unexpected-items", 'operation="create" starts an empty cart, but ItemOut elements are present', "cXML/.../PunchOutSetupRequest");
      }
      break;
    }
    case "SetupResponse":
      checkSetupResponse(doc, issues);
      break;
    case "PunchOutOrderMessage":
      checkPunchback(doc, ctx, issues);
      break;
    case "OrderRequest":
      checkSharedSecret(doc, ctx, issues);
      checkOrderRequest(doc, ctx, issues);
      break;
    case "OrderResponse":
      checkOrderResponse(doc, issues);
      break;
    default:
      issues.warn("unknown-doctype", "Could not classify the cXML document type");
  }

  const hasError = issues.list.some((i) => i.severity === "error");
  return { docType, wellFormed: true, ok: !hasError, issues: issues.list };
}
