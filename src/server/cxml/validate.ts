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

function checkGeneral(doc: ParsedDoc, ctx: ValidationContext, issues: Issues) {
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

  if (!getTimestamp(doc)) {
    issues.error("missing-timestamp", "cXML/@timestamp is missing", "cXML/@timestamp");
  }

  if (!ctx.expected) return;
  const exp = ctx.expected;
  const creds = getHeaderCredentials(doc);

  for (const [name, c] of [
    ["From", creds.from],
    ["To", creds.to],
    ["Sender", creds.sender],
  ] as const) {
    if (!c) {
      issues.warn("missing-credential", `Header/${name} credential is missing`, `cXML/Header/${name}`);
      continue;
    }
    if (!c.domain) {
      issues.warn("credential-domain", `Header/${name}/Credential/@domain is empty`, `cXML/Header/${name}`);
    }
    if (!c.identity) {
      issues.warn("credential-identity", `Header/${name}/Credential/Identity is empty`, `cXML/Header/${name}`);
    }
    if (c.domain && c.identity && !credKnown(c, exp)) {
      issues.warn(
        "credential-mismatch",
        `Header/${name} (${c.domain}/${c.identity}) does not match any identity configured on the connection`,
        `cXML/Header/${name}`,
      );
    }
  }
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
  } else if (exp.sharedSecret && creds.sharedSecret !== exp.sharedSecret) {
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

  const items = asArray(pom.ItemIn);
  if (items.length === 0) {
    issues.warn("empty-cart", "PunchOutOrderMessage contains no ItemIn elements", "cXML/.../PunchOutOrderMessage");
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

  // Total consistency: sum of (quantity * unit price) vs the header Total. Only
  // meaningful when the document is single-currency (otherwise the mock supplier
  // deliberately sends Total 0 and the mixed-currency error above already fired).
  if (singleCurrency && totalAmount != null && items.length > 0) {
    const diff = Math.abs(totalAmount - lineSum);
    if (diff > 0.01) {
      issues.warn(
        "total-mismatch",
        `Header Total (${totalAmount.toFixed(2)}) does not equal the sum of line totals (${lineSum.toFixed(2)})`,
        "cXML/.../PunchOutOrderMessageHeader/Total",
      );
    }
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
  if (!attr(header, "orderDate")) {
    issues.error("missing-orderdate", "OrderRequestHeader/@orderDate is missing", "cXML/.../OrderRequestHeader");
  }
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
  items.forEach((it, i) => {
    const base = `cXML/.../ItemOut[${i + 1}]`;
    if (!text(it?.ItemID?.SupplierPartID)) {
      issues.error("itemout-missing-id", `ItemOut[${i + 1}] is missing ItemID/SupplierPartID`, `${base}/ItemID`);
    }
    const up = it?.ItemDetail?.UnitPrice?.Money;
    if (up == null) {
      issues.error("itemout-missing-unitprice", `ItemOut[${i + 1}] is missing ItemDetail/UnitPrice/Money`, `${base}/ItemDetail/UnitPrice`);
    } else {
      const cur = attr(up, "currency");
      if (cur) lineCurrencies.push(cur);
    }
    if (num(attr(it, "quantity")) == null) {
      issues.error("itemout-missing-quantity", `ItemOut[${i + 1}] is missing @quantity`, base);
    }
  });

  checkSingleCurrency(lineCurrencies, attr(header?.Total?.Money, "currency"), issues, "cXML/.../OrderRequestHeader/Total", ctx.allowMixedCurrency);

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
  checkGeneral(doc, ctx, issues);

  switch (docType) {
    case "SetupRequest":
      checkSharedSecret(doc, ctx, issues);
      if (!root(doc)?.Request?.PunchOutSetupRequest?.BrowserFormPost?.URL) {
        issues.warn("missing-browserformpost", "PunchOutSetupRequest/BrowserFormPost/URL is missing", "cXML/.../PunchOutSetupRequest/BrowserFormPost/URL");
      }
      break;
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
