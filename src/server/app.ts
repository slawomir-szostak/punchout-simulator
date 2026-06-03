import { existsSync } from "node:fs";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import { serveStatic } from "@hono/node-server/serve-static";
import { getToken } from "./runtime.js";
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

  // When a token is configured (the tool is exposed via a non-loopback
  // --public-url), gate the admin/control plane (/api/*, except the health probe)
  // behind it. The inbound buyer surface (/sim, /punchout) stays open so a real
  // buyer system can reach it. Token may arrive as a Bearer header, an
  // x-pos-token header, a ?token= query, or a pos-api-token cookie.
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
    if (provided === token) return next();
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
