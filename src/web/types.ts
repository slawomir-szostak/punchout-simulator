// The SPA reuses the server's domain types directly (type-only imports, erased
// at build) so the two halves never drift.
export type {
  Address,
  AddressMode,
  AttachmentEncoding,
  AttachmentRef,
  Buyer,
  Contact,
  ContactRole,
  Cart,
  CartItem,
  CartReturnTransport,
  CatalogItem,
  Classification,
  Connection,
  ConnectionMode,
  Credential,
  DeploymentMode,
  Direction,
  DocType,
  DtdVersionMap,
  ExtrinsicScope,
  LogRecord,
  ProductList,
  Profile,
  ProfileExtrinsic,
  SetupOperation,
  Supplier,
  ValidationIssue,
  ValidationResult,
  ValidationSeverity,
} from "../server/cxml/types";

// Response DTOs come from the same module the route handlers are typed with,
// so a server-side rename breaks this build instead of the UI at runtime.
export type { ConnectionWithParties, OrderResult, ProxyStatus, RuntimeInfo, SessionSummary, SetupResult } from "../server/routes/dto";

import type { SetupResult, OrderResult } from "../server/routes/dto";

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
