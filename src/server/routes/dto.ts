import type { Buyer, Connection, LogRecord, ServerProfile, Supplier } from "../cxml/types.js";
import type { ProxyStatus } from "../proxy-detect.js";
import type { SessionSummary as LogSessionSummary } from "../store/log.js";

export type { ProxyStatus } from "../proxy-detect.js";

// Response DTOs shared between the route handlers and the SPA (re-exported
// type-only from src/web/types.ts). Routes annotate their c.json() payloads
// with these so a server-side rename breaks the build instead of the UI.

/** GET /api/runtime — boot-time facts the SPA shows in its header. */
export interface RuntimeInfo {
  publicUrl: string;
  callbackUrl: string;
  version?: string;
  proxy?: ProxyStatus;
}

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
  /** Human-readable Status body from the supplier, if any. */
  statusMessage?: string;
  request: LogRecord;
  response: LogRecord;
}

/** Result of POST /api/connections/:id/profile. */
export interface ProfileResult {
  /** The session the two documents were logged under. */
  sessionId: string;
  /** The URL the ProfileRequest was posted to. */
  url: string;
  transportError?: string;
  httpStatus: number;
  statusCode?: string;
  statusMessage?: string;
  /** The capabilities the supplier advertised, when it answered with a ProfileResponse. */
  profile?: ServerProfile;
  /**
   * Where the profile and the supplier's configuration disagree: the URL the
   * supplier advertises for a request versus the one configured in this tool.
   */
  differences: Array<{ field: "punchoutUrl" | "orderUrl"; requestName: string; configured?: string; advertised: string }>;
  request: LogRecord;
  response: LogRecord;
}

/** Result of POST /api/connections/:id/order. */
export interface OrderResult {
  transportError?: string;
  httpStatus: number;
  statusCode?: string;
  statusText?: string;
  /** Human-readable Status body from the supplier (order number, rejection reason). */
  statusMessage?: string;
  request: LogRecord;
  response: LogRecord;
}

/** Result of POST /api/config/import. */
export type { ImportSummary as ConfigImportSummary } from "../store/config.js";
