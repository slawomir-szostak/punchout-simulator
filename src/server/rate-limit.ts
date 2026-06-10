import type { MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { getToken } from "./runtime.js";

// Basic in-process rate limiter for the open inbound surface (/sim, /punchout).
// Those endpoints must stay unauthenticated (remote buyer systems post to them),
// so when the tool is exposed the only guards are the body-size limit and this:
// fixed one-minute windows, counted per client and globally. The limits sit far
// above any legitimate punchout flow but stop a dumb flood from filling the disk
// with session logs and attachments. Plain localhost runs (no token configured)
// are exempt so local development stays friction-free. For anything serious,
// front the tool with a rate-limiting reverse proxy instead (see README).

export interface RateLimitOptions {
  windowMs?: number;
  /** Max requests per client (IP) per window. */
  perClient?: number;
  /** Max requests across all clients per window. */
  globalMax?: number;
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
  let windowStart = 0;
  let globalCount = 0;
  let counts = new Map<string, number>();

  return async (c, next) => {
    if (!getToken()) return next(); // not exposed → no limiting
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
    if (n > perClient || globalCount > globalMax) {
      c.header("Retry-After", String(Math.max(1, Math.ceil((windowStart + windowMs - nowMs) / 1000))));
      return c.json({ error: "rate limit exceeded" }, 429);
    }
    return next();
  };
}
