// The SPA reuses the server's domain types directly (type-only imports, erased
// at build) so the two halves never drift.
export type {
  AttachmentRef,
  AuthStyle,
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
  ValidationIssue,
  ValidationResult,
  ValidationSeverity,
} from "../server/cxml/types";

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
