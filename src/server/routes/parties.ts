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
import type { Address, Contact, Credential } from "../cxml/types.js";

// CRUD for the reusable Buyer and Supplier entities (spec sections 7, 14).

const cred = (c: any): Credential => ({
  domain: String(c?.domain ?? ""),
  identity: String(c?.identity ?? ""),
});

const str = (v: any): string | undefined => (v != null && String(v) !== "" ? String(v) : undefined);

// Normalize an address, returning undefined when every field is empty so a buyer
// without an address doesn't carry an empty object.
function address(a: any): Address | undefined {
  if (a == null || typeof a !== "object") return undefined;
  const out: Address = {
    addressId: str(a.addressId),
    addressIdDomain: str(a.addressIdDomain),
    name: str(a.name),
    deliverTo: str(a.deliverTo),
    street: str(a.street),
    city: str(a.city),
    state: str(a.state),
    postalCode: str(a.postalCode),
    countryIsoCode: str(a.countryIsoCode),
    countryName: str(a.countryName),
    email: str(a.email),
    phone: str(a.phone),
  };
  return Object.values(out).some((v) => v != null) ? out : undefined;
}

function contact(c: any): Contact | undefined {
  const a = address(c);
  const role = str(c?.role);
  if (!a && !role) return undefined;
  return { ...(a ?? {}), role: role ?? "endUser" };
}

// --- buyers ------------------------------------------------------------------

export const buyersRoute = new Hono();

function normalizeBuyer(body: any): BuyerInput {
  return {
    name: String(body?.name ?? "Untitled buyer"),
    identity: cred(body?.identity),
    profileId: body?.profileId ? String(body.profileId) : undefined,
    shipTo: address(body?.shipTo),
    billTo: address(body?.billTo),
    contact: contact(body?.contact),
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
  // The catalog now lives in standalone Product Lists; a supplier just references
  // them. Legacy inline `catalog` is migrated at startup, not written from here.
  const productListIds: string[] = Array.isArray(body?.productListIds)
    ? body.productListIds.map((id: any) => String(id))
    : [];
  return {
    name: String(body?.name ?? "Untitled supplier"),
    identity: cred(body?.identity),
    punchoutUrl: body?.punchoutUrl ? String(body.punchoutUrl) : undefined,
    orderUrl: body?.orderUrl ? String(body.orderUrl) : undefined,
    productListIds,
    allowMixedCurrency: Boolean(body?.allowMixedCurrency),
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
