import { Hono } from "hono";
import {
  createBuyer,
  createSupplier,
  deleteBuyer,
  deleteSupplier,
  getBuyer,
  getSupplier,
  listBuyers,
  listSuppliers,
  updateBuyer,
  updateSupplier,
  type BuyerInput,
  type SupplierInput,
} from "../store/config.js";
import type { CatalogItem, Credential } from "../cxml/types.js";

// CRUD for the reusable Buyer and Supplier entities (spec sections 7, 14).

const cred = (c: any): Credential => ({
  domain: String(c?.domain ?? ""),
  identity: String(c?.identity ?? ""),
});

// --- buyers ------------------------------------------------------------------

export const buyersRoute = new Hono();

function normalizeBuyer(body: any): BuyerInput {
  return {
    name: String(body?.name ?? "Untitled buyer"),
    identity: cred(body?.identity),
    profileId: body?.profileId ? String(body.profileId) : undefined,
  };
}

buyersRoute.get("/", (c) => c.json(listBuyers()));
buyersRoute.post("/", async (c) => {
  const input = normalizeBuyer(await c.req.json().catch(() => ({})));
  if (!input.name.trim()) return c.json({ errors: ["name is required"] }, 400);
  return c.json(await createBuyer(input), 201);
});
buyersRoute.get("/:id", (c) => {
  const b = getBuyer(c.req.param("id"));
  return b ? c.json(b) : c.json({ error: "not found" }, 404);
});
buyersRoute.put("/:id", async (c) => {
  if (!getBuyer(c.req.param("id"))) return c.json({ error: "not found" }, 404);
  const input = normalizeBuyer(await c.req.json().catch(() => ({})));
  return c.json(await updateBuyer(c.req.param("id"), input));
});
buyersRoute.delete("/:id", async (c) => {
  try {
    const ok = await deleteBuyer(c.req.param("id"));
    return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
});

// --- suppliers ---------------------------------------------------------------

export const suppliersRoute = new Hono();

function normalizeSupplier(body: any): SupplierInput {
  const catalog: CatalogItem[] | undefined = Array.isArray(body?.catalog)
    ? body.catalog.map((it: any) => ({
        supplierPartId: String(it?.supplierPartId ?? ""),
        description: String(it?.description ?? ""),
        unitPrice: Number(it?.unitPrice ?? 0) || 0,
        currency: String(it?.currency ?? "USD"),
        uom: String(it?.uom ?? "EA"),
        unspsc: String(it?.unspsc ?? ""),
        manufacturerPartId: it?.manufacturerPartId ? String(it.manufacturerPartId) : undefined,
        manufacturerName: it?.manufacturerName ? String(it.manufacturerName) : undefined,
      }))
    : undefined;
  return {
    name: String(body?.name ?? "Untitled supplier"),
    identity: cred(body?.identity),
    punchoutUrl: body?.punchoutUrl ? String(body.punchoutUrl) : undefined,
    orderUrl: body?.orderUrl ? String(body.orderUrl) : undefined,
    catalog,
  };
}

suppliersRoute.get("/", (c) => c.json(listSuppliers()));
suppliersRoute.post("/", async (c) => {
  const input = normalizeSupplier(await c.req.json().catch(() => ({})));
  if (!input.name.trim()) return c.json({ errors: ["name is required"] }, 400);
  return c.json(await createSupplier(input), 201);
});
suppliersRoute.get("/:id", (c) => {
  const s = getSupplier(c.req.param("id"));
  return s ? c.json(s) : c.json({ error: "not found" }, 404);
});
suppliersRoute.put("/:id", async (c) => {
  if (!getSupplier(c.req.param("id"))) return c.json({ error: "not found" }, 404);
  const input = normalizeSupplier(await c.req.json().catch(() => ({})));
  return c.json(await updateSupplier(c.req.param("id"), input));
});
suppliersRoute.delete("/:id", async (c) => {
  try {
    const ok = await deleteSupplier(c.req.param("id"));
    return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
});
