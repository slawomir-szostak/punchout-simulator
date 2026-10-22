import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "@hono/node-server/serve-static";
import { getToken, getPublicUrl } from "./runtime.js";
import { inboundRateLimit } from "./rate-limit.js";
import { getMaxDataMb, overDataBudget } from "./store/usage.js";
import { connectionsRoute } from "./routes/connections.js";
import { buyersRoute, suppliersRoute } from "./routes/parties.js";
import { profilePresetsRoute, profilesRoute } from "./routes/profiles.js";
import { productListPresetsRoute, productsRoute } from "./routes/products.js";
import { flowRoute } from "./routes/flow.js";
import { punchoutReturnRoute } from "./routes/punchout-return.js";
import { streamRoute } from "./routes/stream.js";
import { dataRoute } from "./routes/data.js";
import { backupRoute } from "./routes/backup.js";
import { simRoute } from "./routes/sim.js";

export interface AppOptions {
  /** Absolute path to the built SPA (dist/web). Omit in dev (Vite serves it). */
  webRoot?: string;
  quiet?: boolean;
}

export function createApp(opts: AppOptions = {}): Hono {
  const app = new Hono();
  if (!opts.quiet) app.use("*", logger());

  // Cap request bodies so an oversized (unauthenticated) POST can't OOM the
  // single-process server. Attachments make /sim and /order legitimately large,
  // so the limit is generous rather than tight.
  app.use(
    "*",
    bodyLimit({ maxSize: 24 * 1024 * 1024, onError: (c) => c.json({ error: "payload too large" }, 413) }),
  );

  // The app's own pages and API must not be framed by other sites (clickjacking
  // of e.g. Delete / Replace config) and must not leak the ?token= URL via
  // Referer. The inbound surface is exempt: buyer platforms embed the mock
  // catalog in an iframe, and the punchback receipt renders inside it.
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    if (c.req.path.startsWith("/sim/") || c.req.path.startsWith("/punchout/")) return;
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", "frame-ancestors 'none'");
    c.header("Referrer-Policy", "no-referrer");
  });

  // Guard the admin/control plane (/api/*) against DNS-rebinding: a page on an
  // attacker domain that re-resolves to 127.0.0.1 becomes "same-origin" in the
  // browser and would otherwise drive the tokenless localhost API. Requiring the
  // Host header to name a host we actually serve on closes that vector without a
  // token. The inbound buyer surface (/sim, /punchout) is intentionally open and
  // legitimately reached via arbitrary proxy Hosts, so it is not gated here.
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/health") return next(); // liveness probe stays open
    // @hono/node-server builds c.req.url from the inbound Host header, so the URL
    // host equals the Host header in production; fall back to it when the header
    // isn't separately present (e.g. Hono's in-process test client).
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (!isAllowedHost(host)) {
      return c.json({ error: "forbidden host (possible DNS-rebinding attempt)" }, 403);
    }
    return next();
  });

  // Guard the state-changing API against CSRF: any page open in the user's
  // browser can fire a "simple" cross-site POST (text/plain, no preflight) at
  // the tokenless localhost API, and readJsonBody doesn't gate on Content-Type.
  // Browsers label such requests via Sec-Fetch-Site (and Origin); the SPA is
  // same-origin, and non-browser clients (curl, scripts) send neither header.
  app.use("/api/*", async (c, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
    const site = c.req.header("sec-fetch-site");
    const origin = c.req.header("origin");
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    const crossSite = site
      ? site !== "same-origin" && site !== "none"
      : !!origin && hostnameFromOrigin(origin) !== hostnameFromHeader(host);
    if (crossSite) {
      return c.json({ error: "forbidden cross-site request" }, 403);
    }
    return next();
  });

  // When a token is configured (the tool is exposed via a non-loopback
  // --public-url), gate /api/* (except the health probe) behind it. Token may
  // arrive as a Bearer header, an x-pos-token header, or a ?token= query (for
  // EventSource and download links, which can't set headers). No cookie: one
  // would ride along on cross-site requests.
  app.use("/api/*", async (c, next) => {
    const token = getToken();
    if (!token) return next();
    if (c.req.path === "/api/health") return next();
    const auth = c.req.header("authorization") ?? "";
    const provided =
      (auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "") ||
      c.req.header("x-pos-token") ||
      c.req.query("token") ||
      "";
    if (safeEqual(provided, token)) return next();
    return c.json({ error: "unauthorized" }, 401);
  });

  // The SPA and its own API share a single origin, so there is no CORS between
  // them (spec section 5).
  app.route("/api/buyers", buyersRoute);
  app.route("/api/suppliers", suppliersRoute);
  app.route("/api/profiles", profilesRoute);
  app.route("/api/profile-presets", profilePresetsRoute);
  app.route("/api/product-lists", productsRoute);
  app.route("/api/product-list-presets", productListPresetsRoute);
  app.route("/api/connections", connectionsRoute);
  app.route("/api/connections", flowRoute); // /:id/setup, /:id/order
  app.route("/api/config", backupRoute);
  app.route("/api", dataRoute);
  app.route("/api", streamRoute);
  // The inbound buyer surface is intentionally unauthenticated; when exposed,
  // bound the abuse it can absorb (body size is capped above; this caps volume).
  // One shared instance so the global bucket spans both prefixes.
  const inboundLimit = inboundRateLimit();
  app.use("/punchout/*", inboundLimit);
  app.use("/sim/*", inboundLimit);
  // Disk budget: once logs + attachments reach --max-data-mb, the open surface
  // stops accepting writes (catalog GETs still work) until sessions are deleted.
  const dataBudget: MiddlewareHandler = async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && overDataBudget()) {
      return c.text(
        `punchout-simulator data directory is full (limit ${getMaxDataMb()} MB) — delete old sessions in the UI, or raise --max-data-mb`,
        507,
      );
    }
    return next();
  };
  app.use("/punchout/*", dataBudget);
  app.use("/sim/*", dataBudget);
  app.route("/punchout", punchoutReturnRoute); // Mode A callback
  app.route("/sim", simRoute); // Mode B mock supplier

  // Single error envelope so every failure reaches the SPA as { error } JSON
  // (api.ts reads body.error), rather than Hono's default plain-text 500.
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    console.error(err);
    return c.json({ error: "internal server error" }, 500);
  });

  // Serve the built SPA from the same server. @hono/node-server's serveStatic
  // resolves files via path.join(root, reqPath), so an absolute root is fine —
  // and unlike a cwd-relative one it survives Windows installs where the npm
  // prefix and the cwd sit on different drives (path.relative would go absolute
  // and 404 the UI).
  if (opts.webRoot && existsSync(opts.webRoot)) {
    app.use(
      "/*",
      serveStatic({
        root: opts.webRoot,
        // SPA fallback: unknown non-API routes return index.html.
        rewriteRequestPath: (path) => path,
      }),
    );
    app.get("/*", serveStatic({ root: opts.webRoot, path: "index.html" }));
  }

  return app;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** Bare hostname from a `Host:` header (or any host[:port]), brackets/port
 *  stripped, lowercased. Returns "" if it can't be parsed. */
function hostnameFromHeader(host?: string): string {
  if (!host) return "";
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Bare hostname from an `Origin:` header; "" for "null" or anything unparseable
 *  (which then never matches, i.e. counts as cross-site). */
function hostnameFromOrigin(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Allow loopback names plus the configured public-URL host (ngrok/cloudflared
 *  front the tool with that Host). A missing/unparseable Host is rejected. */
function isAllowedHost(host?: string): boolean {
  const h = hostnameFromHeader(host);
  if (!h) return false;
  if (LOOPBACK_HOSTS.has(h)) return true;
  return h === hostnameFromHeader(new URL(getPublicUrl()).host);
}

/** Constant-time token comparison (length-guarded) to avoid a timing oracle. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
