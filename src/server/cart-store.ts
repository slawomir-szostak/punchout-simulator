import type { Cart } from "./cxml/types.js";

// The most recent cart per session (BuyerCookie), held in memory so the SPA can
// fetch it after the punchback auto-submit lands on /punchout/return. The log
// remains the durable record; this is just a fast lookup for the active flow.

const carts = new Map<string, Cart>();
const connectionBySession = new Map<string, string>();

export function setCart(cart: Cart): void {
  carts.set(cart.sessionId, cart);
}

export function getCart(sessionId: string): Cart | undefined {
  return carts.get(sessionId);
}

export function rememberSessionConnection(sessionId: string, connectionId: string): void {
  connectionBySession.set(sessionId, connectionId);
}

export function connectionForSession(sessionId: string): string | undefined {
  return connectionBySession.get(sessionId);
}
