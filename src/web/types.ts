// The SPA reuses the server's domain types directly (type-only imports, erased
// at build) so the two halves never drift.
export type {
  AttachmentEncoding,
  AttachmentRef,
  AuthStyle,
  Buyer,
  Cart,
  CartItem,
  CatalogItem,
  Connection,
  ConnectionMode,
  Credential,
  DeploymentMode,
  Direction,
  DocType,
  LogRecord,
  Supplier,
  ValidationIssue,
  ValidationResult,
  ValidationSeverity,
} from "../server/cxml/types";

import type { Buyer, Connection, Supplier } from "../server/cxml/types";

/** A connection as returned by the list/detail API — enriched with its parties. */
export interface ConnectionWithParties extends Connection {
  buyer?: Buyer;
  supplier?: Supplier;
}

export interface SessionSummary {
  sessionId: string;
  connectionId?: string;
  count: number;
  firstTs?: string;
  lastTs?: string;
  docTypes: string[];
  hasErrors: boolean;
}

export interface SetupResult {
  buyerCookie: string;
  transportError?: string;
  httpStatus: number;
  startPage?: string;
  statusCode?: string;
  request: import("../server/cxml/types").LogRecord;
  response: import("../server/cxml/types").LogRecord;
}

export interface OrderResult {
  transportError?: string;
  httpStatus: number;
  statusCode?: string;
  statusText?: string;
  request: import("../server/cxml/types").LogRecord;
  response: import("../server/cxml/types").LogRecord;
}

/** A draft attachment to send with the OrderRequest. scope: "order" or 1-based item index. */
export interface AttachmentDraft {
  contentId: string;
  filename: string;
  contentType: string;
  dataBase64: string;
  scope: "order" | number;
}

/**
 * One flow session for a connection (≈ one order roundtrip). Lifted into App so
 * it survives Flow/Settings tab switches and connection switches, and so the
 * OrderRequest can be edited and re-sent (retry) after a supplier rejection.
 */
export interface FlowSession {
  buyerCookie: string;
  setupXml: string;
  setupResult: SetupResult | null;
  orderXml: string;
  orderResult: OrderResult | null;
  attachments: AttachmentDraft[];
  danglingCid: boolean;
}

export function emptySession(): FlowSession {
  return {
    buyerCookie: "",
    setupXml: "",
    setupResult: null,
    orderXml: "",
    orderResult: null,
    attachments: [],
    danglingCid: false,
  };
}
