import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import { serveStatic } from "@hono/node-server/serve-static";
import { getToken, getPublicUrl } from "./runtime.js";
import { connectionsRoute } from "./routes/connections.js";
import { buyersRoute, suppliersRoute } from "./routes/parties.js";
import { profilePresetsRoute, profilesRoute } from "./routes/profiles.js";
import { productListPresetsRoute, productsRoute } from "./routes/products.js";
import { flowRoute } from "./routes/flow.js";
import { punchoutReturnRoute } from "./routes/punchout-return.js";
import { streamRoute } from "./routes/stream.js";
import { dataRoute } from "./routes/data.js";
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

  // When a token is configured (the tool is exposed via a non-loopback
  // --public-url), gate /api/* (except the health probe) behind it. Token may
  // arrive as a Bearer header, an x-pos-token header, a ?token= query, or a
  // pos-api-token cookie.
  app.use("/api/*", async (c, next) => {
    const token = getToken();
    if (!token) return next();
    if (c.req.path === "/api/health") return next();
    const auth = c.req.header("authorization") ?? "";
    const provided =
      (auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "") ||
      c.req.header("x-pos-token") ||
      c.req.query("token") ||
      getCookie(c, "pos-api-token") ||
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
  app.route("/api", dataRoute);
  app.route("/api", streamRoute);
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

  // Serve the built SPA from the same server. serveStatic needs a path relative
  // to cwd, so we expose it via the `root` option when a build is present.
  if (opts.webRoot && existsSync(opts.webRoot)) {
    app.use(
      "/*",
      serveStatic({
        root: relativeToCwd(opts.webRoot),
        // SPA fallback: unknown non-API routes return index.html.
        rewriteRequestPath: (path) => path,
      }),
    );
    app.get("/*", serveStatic({ root: relativeToCwd(opts.webRoot), path: "index.html" }));
  }

  return app;
}

import { relative } from "node:path";
function relativeToCwd(abs: string): string {
  const rel = relative(process.cwd(), abs);
  return rel === "" ? "." : rel;
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
