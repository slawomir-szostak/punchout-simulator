import type { MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { getToken } from "./runtime.js";

// Basic in-process rate limiter for the open inbound surface (/sim, /punchout).
// Those endpoints must stay unauthenticated (remote buyer systems post to them),
// so when the tool is exposed the only guards are the body-size limit and this:
// fixed one-minute windows, counted per client and globally. The limits sit far
// above any legitimate punchout flow but stop a dumb flood from filling the disk
// with session logs and attachments. Plain localhost runs (no token configured)
// get a looser, global-only cap: every client is 127.0.0.1 there, but any web
// page open in the user's browser can still blind-POST at localhost. The disk
// budget (store/usage.ts) bounds the bytes; this bounds the request rate. For
// anything serious, front the tool with a rate-limiting reverse proxy instead
// (see README).

export interface RateLimitOptions {
  windowMs?: number;
  /** Max requests per client (IP) per window. */
  perClient?: number;
  /** Max requests across all clients per window. */
  globalMax?: number;
  /** Max requests per window on a plain localhost run (no token). */
  localMax?: number;
}

// The client key prefers X-Forwarded-For because exposure happens behind a
// tunnel (ngrok/cloudflared), where the socket peer is always the local tunnel
// agent. XFF is spoofable, so a determined attacker can dodge the per-client
// bucket — the global bucket still bounds total damage.
export function clientKey(c: Parameters<MiddlewareHandler>[0]): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown"; // in-process test client has no socket
  }
}

export function inboundRateLimit(opts: RateLimitOptions = {}): MiddlewareHandler {
  const windowMs = opts.windowMs ?? 60_000;
  const perClient = opts.perClient ?? 120;
  const globalMax = opts.globalMax ?? 1200;
  const localMax = opts.localMax ?? 600;
  let windowStart = 0;
  let globalCount = 0;
  let counts = new Map<string, number>();

  return async (c, next) => {
    const exposed = !!getToken();
    const nowMs = Date.now();
    if (nowMs - windowStart >= windowMs) {
      windowStart = nowMs;
      globalCount = 0;
      counts = new Map();
    }
    globalCount += 1;
    const key = clientKey(c);
    const n = (counts.get(key) ?? 0) + 1;
    // Memory bound: a spoofed-XFF flood could otherwise grow the map without limit.
    if (counts.size >= 10_000) counts.clear();
    counts.set(key, n);
    if (exposed ? n > perClient || globalCount > globalMax : globalCount > localMax) {
      c.header("Retry-After", String(Math.max(1, Math.ceil((windowStart + windowMs - nowMs) / 1000))));
      return c.json({ error: "rate limit exceeded" }, 429);
    }
    return next();
  };
}

// Throttle for failed /api token attempts. The auto-generated token is far
// beyond guessing, but an operator-chosen one may not be, and without this the
// only limit on guesses is the network. Fixed one-minute windows again: a
// client that keeps failing is refused outright (429, the token is not even
// compared) until the window turns over, and a global cap bounds a guesser that
// rotates a spoofed X-Forwarded-For. Successful requests are never counted.
export interface AuthThrottleOptions {
  windowMs?: number;
  /** Failed attempts per client per window before that client is refused. */
  perClient?: number;
  /** Failed attempts across all clients per window before everyone is refused. */
  globalMax?: number;
}

export interface AuthThrottle {
  /** Seconds to wait if this client may not attempt auth right now, else 0. */
  blockedFor(key: string): number;
  recordFailure(key: string): void;
}

export function authThrottle(opts: AuthThrottleOptions = {}): AuthThrottle {
  const windowMs = opts.windowMs ?? 60_000;
  const perClient = opts.perClient ?? 30;
  const globalMax = opts.globalMax ?? 300;
  let windowStart = 0;
  let globalFailures = 0;
  let failures = new Map<string, number>();

  const roll = (nowMs: number) => {
    if (nowMs - windowStart >= windowMs) {
      windowStart = nowMs;
      globalFailures = 0;
      failures = new Map();
    }
  };

  return {
    blockedFor(key) {
      const nowMs = Date.now();
      roll(nowMs);
      if ((failures.get(key) ?? 0) < perClient && globalFailures < globalMax) return 0;
      return Math.max(1, Math.ceil((windowStart + windowMs - nowMs) / 1000));
    },
    recordFailure(key) {
      roll(Date.now());
      globalFailures += 1;
      if (failures.size >= 10_000) failures.clear(); // memory bound, as above
      failures.set(key, (failures.get(key) ?? 0) + 1);
    },
  };
}
