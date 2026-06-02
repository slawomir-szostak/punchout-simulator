import { existsSync } from "node:fs";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";
import { connectionsRoute } from "./routes/connections.js";
import { buyersRoute, suppliersRoute } from "./routes/parties.js";
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

  // The SPA and its own API share a single origin, so there is no CORS between
  // them (spec section 5).
  app.route("/api/buyers", buyersRoute);
  app.route("/api/suppliers", suppliersRoute);
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
