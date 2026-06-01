import { Hono } from "hono";
import {
  createConnection,
  deleteConnection,
  getConnection,
  listConnections,
  updateConnection,
  type ConnectionInput,
} from "../store/config.js";
import type { Connection, Credential } from "../cxml/types.js";

// CRUD for connection configs (spec section 10). Role-neutral: each connection
// carries a `mode` so virtual-buyer (phase 1) and virtual-supplier (phase 2)
// share the same storage.

export const connectionsRoute = new Hono();

const emptyCredential = (): Credential => ({ domain: "", identity: "" });

function normalize(body: any): ConnectionInput {
  const cred = (c: any): Credential =>
    c && typeof c === "object"
      ? { domain: String(c.domain ?? ""), identity: String(c.identity ?? "") }
      : emptyCredential();
  return {
    name: String(body?.name ?? "Untitled connection"),
    mode: body?.mode === "virtual-supplier" ? "virtual-supplier" : "virtual-buyer",
    from: cred(body?.from),
    to: cred(body?.to),
    sender: cred(body?.sender),
    sharedSecret: String(body?.sharedSecret ?? ""),
    deploymentMode: body?.deploymentMode === "production" ? "production" : "test",
    authStyle: body?.authStyle === "MAC" ? "MAC" : "SharedSecret",
    punchoutUrl: body?.punchoutUrl ? String(body.punchoutUrl) : undefined,
    orderUrl: body?.orderUrl ? String(body.orderUrl) : undefined,
    catalog: Array.isArray(body?.catalog) ? body.catalog : undefined,
  };
}

function validateConnection(input: ConnectionInput): string[] {
  const errors: string[] = [];
  if (!input.name.trim()) errors.push("name is required");
  if (input.mode === "virtual-buyer") {
    if (!input.punchoutUrl) errors.push("punchoutUrl is required for virtual-buyer");
    if (!input.orderUrl) errors.push("orderUrl is required for virtual-buyer");
  }
  return errors;
}

connectionsRoute.get("/", (c) => c.json(listConnections()));

connectionsRoute.post("/", async (c) => {
  const input = normalize(await c.req.json().catch(() => ({})));
  const errors = validateConnection(input);
  if (errors.length) return c.json({ errors }, 400);
  const created = await createConnection(input);
  return c.json(created, 201);
});

connectionsRoute.get("/:id", (c) => {
  const conn = getConnection(c.req.param("id"));
  return conn ? c.json(conn) : c.json({ error: "not found" }, 404);
});

connectionsRoute.put("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = getConnection(id);
  if (!existing) return c.json({ error: "not found" }, 404);
  const merged: Connection = { ...existing, ...(await c.req.json().catch(() => ({}))) };
  const input = normalize(merged);
  const errors = validateConnection(input);
  if (errors.length) return c.json({ errors }, 400);
  const updated = await updateConnection(id, input);
  return c.json(updated);
});

connectionsRoute.delete("/:id", async (c) => {
  const ok = await deleteConnection(c.req.param("id"));
  return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});
