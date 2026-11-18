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
function clientKey(c: Parameters<MiddlewareHandler>[0]): string {
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

// Client key for the failed-token throttle. Unlike the inbound key above, this
// one must not be forgeable: a guesser who could pick their own key would dodge
// the limit, and one who could pick someone else's would lock that person out.
// So X-Forwarded-For is believed only when the socket peer is loopback — i.e. a
// tunnel agent or proxy on this machine put it there — and then only its last
// hop, the one that agent appended. Any other peer is keyed by its socket address.
export function authClientKey(c: Parameters<MiddlewareHandler>[0]): string {
  let peer: string | undefined;
  try {
    peer = getConnInfo(c).remote.address ?? undefined;
  } catch {
    /* in-process test client has no socket */
  }
  if (peer && !isLoopbackAddress(peer)) return throttleKeyFor(peer);
  const lastHop = c.req.header("x-forwarded-for")?.split(",").pop()?.trim();
  return throttleKeyFor(lastHop || peer || "unknown");
}

/**
 * Normalise an address into a throttle key. An IPv6 host normally controls a
 * whole /64 and can take a fresh address for every request, so IPv6 is keyed by
 * its /64 prefix; IPv4 (including IPv4-mapped IPv6) by the full address.
 */
export function throttleKeyFor(address: string): string {
  const addr = address.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return mapped[1];
  if (!addr.includes(":")) return addr;
  const [head, tail] = addr.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups =
    tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  if (groups.length !== 8) return addr; // not a well-formed address: key it verbatim
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

function isLoopbackAddress(addr: string): boolean {
  const a = addr.replace(/^::ffff:/i, "");
  return a === "::1" || a.startsWith("127.");
}

// Throttle for failed /api token attempts. The auto-generated token is far
// beyond guessing, but an operator-chosen one may not be, and without this the
// only limit on guesses is the network. Fixed one-minute windows again. A
// refused client gets 429 without its token being compared — otherwise a
// correct guess would still get through and the limit would bound nothing.
//
// Two limits, shaped so that neither lets a stranger lock the operator out:
//  - per client: `perClient` wrong tokens, then that client is refused;
//  - overall: once `globalMax` wrong tokens have arrived from anyone, every
//    client that has itself sent a wrong token this window is refused. A client
//    with no failures is never affected, so the operator's working session
//    carries on; a guesser spread over many addresses gets one attempt per
//    address beyond the budget instead of `perClient` each.
// Successful requests are never counted.
export interface AuthThrottleOptions {
  windowMs?: number;
  /** Failed attempts per client per window before that client is refused. */
  perClient?: number;
  /** Failed attempts overall per window before every failing client is refused. */
  globalMax?: number;
  /** Most clients tracked per window (memory bound). */
  maxClients?: number;
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
  const maxClients = opts.maxClients ?? 50_000;
  let windowStart = 0;
  let totalFailures = 0;
  let failures = new Map<string, number>();

  const roll = (nowMs: number) => {
    if (nowMs - windowStart >= windowMs) {
      windowStart = nowMs;
      totalFailures = 0;
      failures = new Map();
    }
  };

  return {
    blockedFor(key) {
      const nowMs = Date.now();
      roll(nowMs);
      const wait = Math.max(1, Math.ceil((windowStart + windowMs - nowMs) / 1000));
      const mine = failures.get(key);
      // Table full (tens of thousands of distinct failing networks in a minute):
      // counters are never reset to make room, so an untracked client can no
      // longer be told from a fresh guesser and is refused until the window turns.
      if (mine === undefined) return failures.size >= maxClients ? wait : 0;
      return mine >= perClient || totalFailures >= globalMax ? wait : 0;
    },
    recordFailure(key) {
      roll(Date.now());
      totalFailures += 1;
      if (!failures.has(key) && failures.size >= maxClients) return;
      failures.set(key, (failures.get(key) ?? 0) + 1);
    },
  };
}
