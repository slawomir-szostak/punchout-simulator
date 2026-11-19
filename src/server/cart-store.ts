import type { Cart, CartItem, LogRecord } from "./cxml/types.js";
import { readSession } from "./store/log.js";
import { parseCart, parseSetupItems, parseXml, type ParsedDoc } from "./cxml/parse.js";
import { lineItemsTotal } from "./cxml/build.js";

// The most recent cart per session (BuyerCookie), held in memory so the SPA can
// fetch it after the punchback auto-submit lands on /punchout/return. The log
// remains the durable record; this map is a fast lookup for the active flow, and
// after a server restart (when the map is empty) both lookups re-derive their
// answer from the on-disk log so pre-restart sessions still work.

const carts = new Map<string, Cart>();
const connectionBySession = new Map<string, string>();
// orderID → BuyerCookie for OrderRequests this tool sent. A cXML OrderRequest
// carries no BuyerCookie, so when the tool is both ends (loopback demo) the
// mock supplier uses this to file the inbound order under the buyer's session
// instead of minting a second "inbound" session for the same flow.
const sessionByOrder = new Map<string, string>();

/** The operation and carried items of a session's most recent PunchOutSetupRequest. */
export function sessionSetup(records: LogRecord[]): { operation: string; items: CartItem[] } | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].docType === "SetupRequest") return parseSetupItems(parseXml(records[i].body));
  }
  return undefined;
}

/**
 * Turn a punchback into the cart the buyer should now hold, following the cXML
 * Reference Guide ("Empty Shopping Carts"). `records` is the session log up to,
 * but not including, the punchback.
 *  - inspect: the returned item list must be ignored — the items stay as sent;
 *  - create, no items: the session was cancelled, nothing is added;
 *  - edit, no items, Status 204: cancelled without change — the items stay;
 *  - edit, no items otherwise: the items are deleted from the requisition;
 *  - anything else: the returned items are the cart.
 */
export function interpretPunchback(doc: ParsedDoc, records: LogRecord[]): Cart {
  const cart = parseCart(doc);
  const setup = sessionSetup(records);
  const keep = (outcome: "inspected" | "unchanged"): Cart => {
    const items = setup?.items ?? [];
    const currency = items[0]?.currency ?? cart.total?.currency ?? "USD";
    return { ...cart, outcome, items, total: items.length > 0 ? { amount: lineItemsTotal(items, currency), currency } : cart.total };
  };
  if (setup?.operation === "inspect") return keep("inspected");
  if (cart.items.length > 0) return { ...cart, outcome: "returned" };
  if (setup?.operation === "edit") return cart.statusCode === "204" ? keep("unchanged") : { ...cart, outcome: "emptied" };
  return { ...cart, outcome: "cancelled" };
}

export function setCart(cart: Cart): void {
  carts.set(cart.sessionId, cart);
}

export function getCart(sessionId: string): Cart | undefined {
  const cached = carts.get(sessionId);
  if (cached) return cached;
  const derived = deriveCartFromLog(sessionId);
  if (derived) carts.set(sessionId, derived); // cache the rebuild
  return derived;
}

// Rebuild the cart from the latest inbound PunchOutOrderMessage in the session
// log — the same document the in-memory cart was parsed from originally.
function deriveCartFromLog(sessionId: string): Cart | undefined {
  const records = readSession(sessionId);
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.direction === "in" && r.docType === "PunchOutOrderMessage" && r.body) {
      const cart = interpretPunchback(parseXml(r.body), records.slice(0, i));
      return { ...cart, sessionId: cart.sessionId || sessionId };
    }
  }
  return undefined;
}

export function rememberSessionConnection(sessionId: string, connectionId: string): void {
  connectionBySession.set(sessionId, connectionId);
}

export function connectionForSession(sessionId: string): string | undefined {
  const cached = connectionBySession.get(sessionId);
  if (cached) return cached;
  // Recover the connection id from the first logged record that carries one
  // (the SetupRequest), so inbound punchbacks for pre-restart sessions still
  // validate against the expected credentials.
  const id = readSession(sessionId).find((r) => r.connectionId)?.connectionId;
  if (id) connectionBySession.set(sessionId, id);
  return id || undefined;
}

export function rememberOrderSession(orderId: string, sessionId: string): void {
  sessionByOrder.set(orderId, sessionId);
}

/** The buyer session that sent this orderID, if it was sent from this tool. */
export function sessionForOrder(orderId: string): string | undefined {
  return sessionByOrder.get(orderId);
}

/** Drop the in-memory cart + connection mapping for a session (on delete). */
export function forgetSession(sessionId: string): void {
  carts.delete(sessionId);
  connectionBySession.delete(sessionId);
  for (const [orderId, sid] of sessionByOrder) if (sid === sessionId) sessionByOrder.delete(orderId);
}
