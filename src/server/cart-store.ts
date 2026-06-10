import type { Cart } from "./cxml/types.js";
import { readSession } from "./store/log.js";
import { parseCart, parseXml } from "./cxml/parse.js";

// The most recent cart per session (BuyerCookie), held in memory so the SPA can
// fetch it after the punchback auto-submit lands on /punchout/return. The log
// remains the durable record; this map is a fast lookup for the active flow, and
// after a server restart (when the map is empty) both lookups re-derive their
// answer from the on-disk log so pre-restart sessions still work.

const carts = new Map<string, Cart>();
const connectionBySession = new Map<string, string>();

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
      const cart = parseCart(parseXml(r.body));
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

/** Drop the in-memory cart + connection mapping for a session (on delete). */
export function forgetSession(sessionId: string): void {
  carts.delete(sessionId);
  connectionBySession.delete(sessionId);
}
