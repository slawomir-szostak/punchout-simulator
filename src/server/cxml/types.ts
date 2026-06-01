// Shared cXML / domain types used across the server and (via a re-export shim
// in the web app) the SPA. Kept role-neutral so Mode B slots in without a
// rewrite — see spec sections 7 and 14.

export type ConnectionMode = "virtual-buyer" | "virtual-supplier";
export type DeploymentMode = "test" | "production";
export type AuthStyle = "SharedSecret" | "MAC";

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

export interface Connection {
  id: string;
  name: string;
  mode: ConnectionMode;

  // Identities. For virtual-buyer the tool presents from/sender (the buyer);
  // for virtual-supplier the tool presents the supplier identity.
  from: Credential;
  to: Credential;
  sender: Credential;
  sharedSecret: string;

  deploymentMode: DeploymentMode;
  authStyle: AuthStyle;

  // virtual-buyer: the supplier endpoints the tool calls.
  punchoutUrl?: string;
  orderUrl?: string;

  // virtual-supplier (phase 2): the tool's own mock catalog.
  catalog?: CatalogItem[];

  createdAt: string;
  updatedAt: string;
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
