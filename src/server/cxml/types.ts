// Shared cXML / domain types used across the server and (via a re-export shim
// in the web app) the SPA. Kept role-neutral so Mode B slots in without a
// rewrite — see spec sections 7 and 14.

export type ConnectionMode = "virtual-buyer" | "virtual-supplier";
export type DeploymentMode = "test" | "production";
/** MIME Content-Transfer-Encoding used for OrderRequest attachment parts. */
export type AttachmentEncoding = "binary" | "base64";
/** How the browser posts the punchback (PunchOutOrderMessage) back to the buyer. */
export type CartReturnTransport = "cxml-urlencoded" | "cxml-base64" | "raw";
/** PunchOutSetupRequest operation. */
export type SetupOperation = "create" | "edit" | "inspect";
/** Which outbound document a profile Extrinsic is injected into. */
export type ExtrinsicScope = "setup" | "order";

/** A profile Extrinsic template. `value` may contain ${buyerCookie} / ${orderId} tokens. */
export interface ProfileExtrinsic {
  name: string;
  value: string;
  scope: ExtrinsicScope;
}

/**
 * Per-document-type cXML DTD versions (e.g. "1.2.045"). `default` is the
 * fallback used for any document type without an explicit entry. Keys match the
 * DocType union (note: PunchOutSetupRequest maps to `SetupRequest`).
 */
export interface DtdVersionMap {
  default: string;
  SetupRequest?: string;
  SetupResponse?: string;
  PunchOutOrderMessage?: string;
  OrderRequest?: string;
  OrderResponse?: string;
}

/**
 * A reusable procurement-platform profile (Ariba/Coupa/Jaggaer/...). It holds
 * the platform-intrinsic DEFAULTS for the cXML a buyer running that platform
 * emits. A Connection's own fields (sharedSecret, senderIdentity, and the
 * concrete attachmentEncoding) still override these per pair.
 */
export interface Profile {
  id: string;
  name: string;
  /** Free-text platform label, e.g. "Coupa". */
  platform?: string;
  dtdVersions: DtdVersionMap;
  userAgent: string;
  setupOperation: SetupOperation;
  attachmentEncoding: AttachmentEncoding;
  cartReturnTransport: CartReturnTransport;
  extrinsics: ProfileExtrinsic[];
  /** How ShipTo/BillTo/Contact addresses are emitted (ref / full postal / both). */
  addressMode: AddressMode;
  /** Emit the buyer's ShipTo inside the PunchOutSetupRequest (Ariba-style). */
  shipToInSetup: boolean;
  /** Emit the buyer's Contact inside the PunchOutSetupRequest. */
  contactInSetup: boolean;
  /** True for code-seeded presets. */
  builtin?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A cXML credential: the `domain`/identity pair used in From/To/Sender. */
export interface Credential {
  domain: string;
  identity: string;
}

/** How an `<Address>` is emitted: a bare reference, a full postal block, or both. */
export type AddressMode = "id-only" | "full" | "both";

/** A cXML postal `<Address>` (used by ShipTo/BillTo and, with a role, Contact). */
export interface Address {
  /** `<Address addressID=…>` — a key into the buyer's address book. */
  addressId?: string;
  /** `addressIDDomain` attribute (e.g. "NetworkID", "buyerSystemID"). */
  addressIdDomain?: string;
  name?: string;
  deliverTo?: string;
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  countryIsoCode?: string;
  countryName?: string;
  email?: string;
  phone?: string;
}

/** Common cXML `Contact@role` values. Free text is allowed; these are the typical ones. */
export type ContactRole =
  | "endUser"
  | "purchasingAgent"
  | "buyerMasterAccount"
  | "administrator"
  | "sales"
  | "technicalSupport"
  | "default";

/** A cXML `<Contact role=…>` — who placed/owns the order (name/email/phone). */
export interface Contact extends Address {
  role: string;
}

/** A cXML `<Classification domain="…">value</Classification>`. */
export interface Classification {
  domain: string; // e.g. "UNSPSC", or a supplier-specific commodity scheme
  value: string;
}

/** A mock catalog item served by Mode B (virtual-supplier). */
export interface CatalogItem {
  supplierPartId: string;
  /** `<SupplierPartAuxiliaryID>` — a secondary part key (variant / contract-line ref). */
  supplierPartAuxiliaryId?: string;
  description: string;
  unitPrice: number;
  currency: string;
  uom: string; // UnitOfMeasure, e.g. "EA"
  /** One or more `<Classification>` entries; cXML requires at least one with a domain. */
  classifications: Classification[];
  manufacturerPartId?: string;
  manufacturerName?: string;
  /**
   * When true, the Mode-B catalog accepts fractional order quantities for this
   * item (e.g. 1.5 m of cable). Defaults to false — whole numbers only.
   */
  allowFractional?: boolean;
}

/**
 * A reusable, named list of catalog products. Created/edited on its own and
 * assigned to one or more Suppliers, which serve the union of their lists as the
 * Mode-B catalog. Replaces the old inline per-supplier catalog.
 */
export interface ProductList {
  id: string;
  name: string;
  description?: string;
  items: CatalogItem[];
  /** True for code-seeded sample lists. */
  builtin?: boolean;
  createdAt: string;
  updatedAt: string;
}

// --- Normalized domain model -------------------------------------------------
//
// A Buyer and a Supplier are standalone, reusable entities holding only what is
// intrinsic to them. A Connection is the edge between one Buyer and one
// Supplier and holds only what is specific to that pair (credentials, mode).

/** A buyer party. Its `identity` is the cXML `From` credential it presents. */
/**
 * How a party computes tax: a single rate applied to the goods subtotal.
 * Emitted as `<Tax>` with one `<TaxDetail category percentageRate>`.
 */
export interface TaxSettings {
  /** Percentage, e.g. 23 for 23 %. */
  ratePercent: number;
  /** TaxDetail/@category (required by the DTD): sales, vat, gst, usage, … */
  category: string;
  description?: string;
  /**
   * Buyer side only: `order` puts one Tax in the OrderRequestHeader (the
   * default); `lines` additionally gives every ItemOut its own Tax.
   */
  level?: "order" | "lines";
}

/** A flat shipping charge, emitted as `<Shipping>` (Money + Description). */
export interface ShippingSettings {
  amount: number;
  description?: string;
}

/** One accounting code: `<AccountingSegment id><Name/><Description/>`. */
export interface AccountingSegmentDef {
  /** The kind of code — "Cost Center", "G/L Account", … (element Name). */
  name: string;
  /** The code itself (attribute id). */
  id: string;
  description: string;
}

/**
 * Who is charged for an order line. Emitted on every ItemOut as one
 * `<Distribution>` whose Charge is the line amount.
 */
export interface AccountingSettings {
  /** Accounting/@name — the name of this accounting combination. */
  name: string;
  segments: AccountingSegmentDef[];
}

/**
 * Tax and shipping for one buyer–supplier pair, overriding the party's own
 * defaults. Suppliers set this up per customer in practice: not every buyer
 * wants tax in the cart it gets back. Absent on a connection = use the party's
 * defaults; `none` = send neither; `custom` = send exactly what is given here.
 */
export interface ChargeOverride {
  mode: "none" | "custom";
  tax?: TaxSettings;
  shipping?: ShippingSettings;
}

/** A charge as carried in a document (parsed, or computed for emission). */
export interface ChargeAmount {
  amount: number;
  currency: string;
  description?: string;
}

export interface Buyer {
  id: string;
  name: string;
  identity: Credential;
  /**
   * Optional reference to a procurement-platform Profile. When unset, the
   * built-in "Generic" profile defaults apply (today's behavior).
   */
  profileId?: string;
  /** Default ship-to / bill-to addresses and end-user contact for this buyer's
   * orders. Pre-fill the OrderRequest form and may be sent in the SetupRequest
   * (profile-gated). All optional. */
  shipTo?: Address;
  billTo?: Address;
  contact?: Contact;
  /**
   * Charges and accounting this buyer adds to its OrderRequests. All optional.
   * "This element is present if the buying organization computes tax"; without
   * `tax` / `shipping` here an order carries what the supplier quoted in the cart.
   */
  tax?: TaxSettings;
  shipping?: ShippingSettings;
  accounting?: AccountingSettings;
  createdAt: string;
  updatedAt: string;
}

/**
 * A supplier party. Endpoints are intrinsic to the supplier (constant across
 * every buyer that talks to it) — defined here, never per Connection.
 */
export interface Supplier {
  id: string;
  name: string;
  identity: Credential; // cXML `To` credential
  punchoutUrl?: string; // the supplier's PunchOut setup endpoint
  orderUrl?: string; // the supplier's order endpoint
  /**
   * Where to send a ProfileRequest — the supplier's "root" cXML URL, when it
   * has one distinct from the PunchOut endpoint. Defaults to `punchoutUrl`.
   */
  profileUrl?: string;
  /**
   * Product Lists this supplier serves as its Mode-B catalog. The served catalog
   * is the union of these lists' items (in order).
   */
  productListIds?: string[];
  /**
   * When true, documents involving this supplier may span multiple currencies:
   * the mixed-currency validation is a warning instead of an error (the
   * supplier's system handles multi-currency orders). Defaults to false.
   */
  allowMixedCurrency?: boolean;
  /**
   * `PunchOutOrderMessageHeader/@operationAllowed` the mock supplier returns
   * with a cart: the highest operation the buyer may later perform on it.
   * `create` permits no reopening, `inspect` a read-only one, `edit` both.
   * Defaults to `edit`, since the mock catalog can reopen carts.
   */
  operationAllowed?: "create" | "inspect" | "edit";
  /**
   * Charges the mock supplier quotes with a returned cart, emitted in
   * PunchOutOrderMessageHeader as Tax and Shipping ("computed on the remote
   * website"). The header Total stays the goods amount, excluding both.
   */
  cartTax?: TaxSettings;
  cartShipping?: ShippingSettings;
  /**
   * @deprecated Legacy inline catalog. Read only, for one-time migration into a
   * generated Product List (see store/config.ts). No longer written from the UI.
   */
  catalog?: CatalogItem[];
  createdAt: string;
  updatedAt: string;
}

/**
 * The Buyer↔Supplier relationship under test. Holds only pair-specific data:
 * which side the tool simulates (`mode`), and the credentials this buyer uses
 * at this supplier.
 */
export interface Connection {
  id: string;
  name: string; // display label, defaults to "<Buyer> → <Supplier>"
  buyerId: string;
  supplierId: string;
  mode: ConnectionMode;

  sharedSecret: string; // pair "password" (Sender/Credential/SharedSecret)
  /**
   * Optional per-pair login override (the Sender identity used at this
   * supplier). When unset it defaults to the buyer's own identity.
   */
  senderIdentity?: Credential;

  deploymentMode: DeploymentMode;
  /**
   * Content-Transfer-Encoding for OrderRequest attachment parts sent over this
   * connection. `binary` writes raw bytes (valid over HTTP, more compact);
   * `base64` is what many real Ariba/Coupa receivers expect. Defaults to
   * `binary` when unset.
   */
  attachmentEncoding?: AttachmentEncoding;

  /**
   * Tax and shipping on the OrderRequests this buyer sends to this supplier.
   * Unset: the buyer's own settings apply (and, where it has none, the order
   * carries what the supplier quoted with the cart).
   */
  orderCharges?: ChargeOverride;
  /**
   * Tax and shipping the mock supplier quotes in carts returned to this buyer.
   * Unset: the supplier's own settings apply.
   */
  cartCharges?: ChargeOverride;

  createdAt: string;
  updatedAt: string;
}

/** A Connection with its Buyer and Supplier resolved — used by the flow/sim. */
export interface ResolvedConnection {
  connection: Connection;
  buyer: Buyer;
  supplier: Supplier;
}

export type Direction = "out" | "in"; // relative to the tool

export type DocType =
  | "SetupRequest"
  | "SetupResponse"
  | "PunchOutOrderMessage"
  | "OrderRequest"
  | "OrderResponse"
  | "ProfileRequest"
  | "ProfileResponse"
  | "Unknown";

export type ValidationSeverity = "error" | "warning" | "info";

export interface ValidationIssue {
  severity: ValidationSeverity;
  /** Stable machine code, e.g. "missing-payloadID". */
  code: string;
  message: string;
  /** Optional dotted path / location hint into the document. */
  path?: string;
}

export interface ValidationResult {
  docType: DocType;
  wellFormed: boolean;
  ok: boolean; // true when there are no error-severity issues
  issues: ValidationIssue[];
}

export interface AttachmentRef {
  contentId: string; // normalized (no angle brackets)
  filename?: string;
  contentType: string;
  /** sha256 hash; also the on-disk filename under data/attachments/. */
  hash: string;
  size: number;
  /** Whether a matching <Attachment><URL>cid:...</URL> referenced this part. */
  referenced?: boolean;
}

export interface LogRecord {
  id: string;
  sessionId: string; // = BuyerCookie
  connectionId: string;
  direction: Direction;
  docType: DocType;
  ts: string;
  /** HTTP status of the exchange when applicable. */
  status?: number;
  /**
   * Endpoint of the exchange: for outbound requests the URL we POSTed to, for
   * inbound ones the URL the counterparty hit; the matching response record
   * carries the same URL. Absent on records logged before this field existed.
   */
  url?: string;
  headers: Record<string, string>;
  body: string;
  contentType?: string;
  validation?: ValidationResult;
  attachments?: AttachmentRef[];
  /**
   * Transfer encoding used for the multipart attachment parts on the wire, so
   * the raw-message view can reconstruct the envelope byte-for-byte.
   */
  attachmentEncoding?: AttachmentEncoding;
  /** Optional human label, e.g. "dangling-cid test". */
  note?: string;
}

/** A normalized cart parsed from a PunchOutOrderMessage (punchback). */
export interface CartItem {
  quantity: number;
  supplierPartId?: string;
  supplierPartAuxiliaryId?: string;
  description?: string;
  uom?: string;
  unitPriceAmount?: number;
  currency?: string;
  /**
   * All `<Classification>` entries. When present, builders emit each one;
   * otherwise they fall back to the single classificationDomain/classification
   * pair below (kept for back-compat and simple single-domain display).
   */
  classifications?: Classification[];
  classificationDomain?: string;
  classification?: string;
  manufacturerPartId?: string;
  manufacturerName?: string;
}

/**
 * `PunchOutSetupRequest/SelectedItem`: the catalog item the user punched out
 * from. The supplier uses it "to determine which products to display" — its
 * whole store, an aisle, or a single product (Level 2 PunchOut).
 */
export interface SelectedItem {
  supplierPartId: string;
  supplierPartAuxiliaryId?: string;
}

/** One `<Option name>` of a ProfileResponse or of one of its Transactions. */
export interface ProfileOption {
  name: string;
  value: string;
}

/** A `<Transaction requestName>`: a request the server accepts, and where. */
export interface ProfileTransaction {
  requestName: string;
  url: string;
  options: ProfileOption[];
}

/** A parsed ProfileResponse: the capabilities a cXML server advertises. */
export interface ServerProfile {
  effectiveDate?: string;
  lastRefresh?: string;
  options: ProfileOption[];
  transactions: ProfileTransaction[];
}

/**
 * What a punchback means for the buyer's requisition, following the cXML
 * Reference Guide ("Empty Shopping Carts"):
 *  - `returned`  — the cart's items replace what the session had;
 *  - `cancelled` — a `create` session ended with no items: nothing to add;
 *  - `emptied`   — an `edit` session came back empty: its items are deleted;
 *  - `unchanged` — an `edit` session ended with Status 204: keep the items as
 *                  they were;
 *  - `inspected` — an `inspect` session: whatever came back is ignored.
 */
export type CartOutcome = "returned" | "cancelled" | "emptied" | "unchanged" | "inspected";

export interface Cart {
  sessionId: string; // BuyerCookie
  operationAllowed?: string;
  /** Message/Status/@code of the punchback, when it carried one (e.g. "204"). */
  statusCode?: string;
  /** How the buyer must treat this punchback; set once the session's operation is known. */
  outcome?: CartOutcome;
  /** Header Total: the goods amount, excluding tax and shipping. */
  total?: { amount: number; currency: string };
  /** PunchOutOrderMessageHeader/Shipping and /Tax, when the supplier quoted them. */
  shipping?: ChargeAmount;
  tax?: ChargeAmount;
  items: CartItem[];
}
