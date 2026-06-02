// Shared cXML / domain types used across the server and (via a re-export shim
// in the web app) the SPA. Kept role-neutral so Mode B slots in without a
// rewrite — see spec sections 7 and 14.

export type ConnectionMode = "virtual-buyer" | "virtual-supplier";
export type DeploymentMode = "test" | "production";
export type AuthStyle = "SharedSecret" | "MAC";
/** MIME Content-Transfer-Encoding used for OrderRequest attachment parts. */
export type AttachmentEncoding = "binary" | "base64";

/** A cXML credential: the `domain`/identity pair used in From/To/Sender. */
export interface Credential {
  domain: string;
  identity: string;
}

/** A mock catalog item served by Mode B (virtual-supplier). */
export interface CatalogItem {
  supplierPartId: string;
  description: string;
  unitPrice: number;
  currency: string;
  uom: string; // UnitOfMeasure, e.g. "EA"
  unspsc: string; // Classification domain="UNSPSC"
  manufacturerPartId?: string;
  manufacturerName?: string;
}

// --- Normalized domain model -------------------------------------------------
//
// A Buyer and a Supplier are standalone, reusable entities holding only what is
// intrinsic to them. A Connection is the edge between one Buyer and one
// Supplier and holds only what is specific to that pair (credentials, mode).

/** A buyer party. Its `identity` is the cXML `From` credential it presents. */
export interface Buyer {
  id: string;
  name: string;
  identity: Credential;
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
  catalog?: CatalogItem[]; // served when the tool acts as this supplier (Mode B)
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
  authStyle: AuthStyle;
  /**
   * Content-Transfer-Encoding for OrderRequest attachment parts sent over this
   * connection. `binary` writes raw bytes (valid over HTTP, more compact);
   * `base64` is what many real Ariba/Coupa receivers expect. Defaults to
   * `binary` when unset.
   */
  attachmentEncoding?: AttachmentEncoding;

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
  classificationDomain?: string;
  classification?: string;
  manufacturerPartId?: string;
  manufacturerName?: string;
}

export interface Cart {
  sessionId: string; // BuyerCookie
  operationAllowed?: string;
  total?: { amount: number; currency: string };
  items: CartItem[];
}
