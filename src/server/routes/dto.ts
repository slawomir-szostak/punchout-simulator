import type { Buyer, Connection, LogRecord, Supplier } from "../cxml/types.js";
import type { SessionSummary as LogSessionSummary } from "../store/log.js";

// Response DTOs shared between the route handlers and the SPA (re-exported
// type-only from src/web/types.ts). Routes annotate their c.json() payloads
// with these so a server-side rename breaks the build instead of the UI.

/** A connection as returned by the list/detail API — enriched with its parties. */
export interface ConnectionWithParties extends Connection {
  buyer?: Buyer;
  supplier?: Supplier;
  /** Server masks `sharedSecret` to "" on read and reports presence here. */
  hasSharedSecret?: boolean;
}

/** A session summary enriched with resolved connection/party names for display. */
export interface SessionSummary extends LogSessionSummary {
  connectionName?: string;
  buyerName?: string;
  supplierName?: string;
  mode?: string;
  /** True when an external buyer initiated this session against our Mode-B endpoint. */
  inbound?: boolean;
}

/** Result of POST /api/connections/:id/setup. */
export interface SetupResult {
  buyerCookie: string;
  transportError?: string;
  httpStatus: number;
  startPage?: string;
  statusCode?: string;
  request: LogRecord;
  response: LogRecord;
}

/** Result of POST /api/connections/:id/order. */
export interface OrderResult {
  transportError?: string;
  httpStatus: number;
  statusCode?: string;
  statusText?: string;
  request: LogRecord;
  response: LogRecord;
}
