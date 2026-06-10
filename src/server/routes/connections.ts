import { Hono } from "hono";
import { readJsonBody } from "./json-body.js";
import {
  createConnection,
  deleteConnection,
  getBuyer,
  getConnection,
  getSupplier,
  listConnections,
  resolveConnection,
  updateConnection,
  type ConnectionInput,
} from "../store/config.js";
import type { Credential } from "../cxml/types.js";
import type { ConnectionWithParties } from "./dto.js";

// CRUD for connection edges. A connection references a Buyer and a Supplier and
// holds only pair-specific data (mode + credentials). See spec sections 7, 10.

export const connectionsRoute = new Hono();

function normalize(body: any): ConnectionInput {
  const sender: Credential | undefined =
    body?.senderIdentity && (body.senderIdentity.domain || body.senderIdentity.identity)
      ? { domain: String(body.senderIdentity.domain ?? ""), identity: String(body.senderIdentity.identity ?? "") }
      : undefined;
  return {
    name: String(body?.name ?? ""),
    buyerId: String(body?.buyerId ?? ""),
    supplierId: String(body?.supplierId ?? ""),
    mode: body?.mode === "virtual-supplier" ? "virtual-supplier" : "virtual-buyer",
    sharedSecret: String(body?.sharedSecret ?? ""),
    senderIdentity: sender,
    deploymentMode: body?.deploymentMode === "production" ? "production" : "test",
    attachmentEncoding: body?.attachmentEncoding === "base64" ? "base64" : "binary",
  };
}

function validate(input: ConnectionInput): string[] {
  const errors: string[] = [];
  if (!input.buyerId || !getBuyer(input.buyerId)) errors.push("a valid buyer is required");
  if (!input.supplierId || !getSupplier(input.supplierId)) errors.push("a valid supplier is required");
  return errors;
}

function withLabel(input: ConnectionInput): ConnectionInput {
  if (input.name.trim()) return input;
  const buyer = getBuyer(input.buyerId);
  const supplier = getSupplier(input.supplierId);
  return { ...input, name: `${buyer?.name ?? "Buyer"} → ${supplier?.name ?? "Supplier"}` };
}

// The shared secret is write-only over the API: never echo it back. Callers see
// whether one is set (hasSharedSecret) and re-submit a value only to change it.
function maskSecret<T extends { sharedSecret?: string }>(conn: T): T & { hasSharedSecret: boolean } {
  return { ...conn, sharedSecret: "", hasSharedSecret: !!conn.sharedSecret };
}

// Returns connections enriched with resolved buyer/supplier for convenient display.
connectionsRoute.get("/", (c) =>
  c.json(
    listConnections().map(
      (conn): ConnectionWithParties => ({
        ...maskSecret(conn),
        buyer: getBuyer(conn.buyerId),
        supplier: getSupplier(conn.supplierId),
      }),
    ),
  ),
);

connectionsRoute.post("/", async (c) => {
  const input = normalize(await readJsonBody(c));
  const errors = validate(input);
  if (errors.length) return c.json({ errors }, 400);
  return c.json(maskSecret(await createConnection(withLabel(input))), 201);
});

connectionsRoute.get("/:id", (c) => {
  const resolved = resolveConnection(c.req.param("id"));
  if (resolved) {
    const dto: ConnectionWithParties = { ...maskSecret(resolved.connection), buyer: resolved.buyer, supplier: resolved.supplier };
    return c.json(dto);
  }
  const conn = getConnection(c.req.param("id"));
  return conn ? c.json(maskSecret(conn)) : c.json({ error: "not found" }, 404);
});

connectionsRoute.put("/:id", async (c) => {
  const existing = getConnection(c.req.param("id"));
  if (!existing) return c.json({ error: "not found" }, 404);
  const body = await readJsonBody(c);
  // A blank sharedSecret on update means "unchanged" (it is never sent back to
  // the client to begin with), so keep the stored one rather than clearing it.
  if (!body || !body.sharedSecret) delete (body as any).sharedSecret;
  const input = normalize({ ...existing, ...body });
  const errors = validate(input);
  if (errors.length) return c.json({ errors }, 400);
  return c.json(maskSecret(await updateConnection(c.req.param("id"), withLabel(input)) as any));
});

connectionsRoute.delete("/:id", async (c) => {
  const ok = await deleteConnection(c.req.param("id"));
  return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});
