import { Hono } from "hono";
import { readJsonBody } from "./json-body.js";
import { ConfigImportError, exportConfig, importConfig } from "../store/config.js";
import { getVersion } from "../runtime.js";

// Export / import of the whole configuration (buyers, suppliers, connections,
// profiles, product lists) as one JSON file. Sessions and logs are not included.

export const backupRoute = new Hono();

// ?secrets=1 includes the connections' plaintext shared secrets.
backupRoute.get("/export", (c) => {
  const snapshot = exportConfig({ appVersion: getVersion(), includeSecrets: c.req.query("secrets") === "1" });
  const day = snapshot.exportedAt.slice(0, 10);
  // Served as a download so a plain <a href> saves it under a sensible name.
  c.header("Content-Disposition", `attachment; filename="punchout-simulator-config-${day}.json"`);
  return c.body(JSON.stringify(snapshot, null, 2), 200, { "Content-Type": "application/json; charset=utf-8" });
});

// POST the file's JSON as the body; ?mode=merge (default) or ?mode=replace.
backupRoute.post("/import", async (c) => {
  const mode = c.req.query("mode") ?? "merge";
  if (mode !== "merge" && mode !== "replace") {
    return c.json({ errors: [`mode must be "merge" or "replace"`] }, 400);
  }
  try {
    return c.json(await importConfig(await readJsonBody(c), mode));
  } catch (e) {
    if (e instanceof ConfigImportError) return c.json({ errors: e.errors }, 400);
    throw e;
  }
});
