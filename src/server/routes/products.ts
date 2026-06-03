import { Hono } from "hono";
import {
  createProductList,
  deleteProductList,
  getProductList,
  listProductLists,
  updateProductList,
  type ProductListInput,
} from "../store/config.js";
import { PRODUCT_LIST_PRESETS } from "../cxml/product-list-presets.js";
import type { CatalogItem, Classification } from "../cxml/types.js";

// CRUD for reusable Product Lists, plus a read-only library of built-in sample
// lists the UI can load into the editor. A supplier references one or more lists
// (Supplier.productListIds) and serves their union as its Mode-B catalog.

export const productsRoute = new Hono();
export const productListPresetsRoute = new Hono();

function normalizeClassifications(it: any): Classification[] {
  if (Array.isArray(it?.classifications)) {
    return it.classifications
      .map((c: any) => ({ domain: String(c?.domain ?? "UNSPSC"), value: String(c?.value ?? "") }))
      .filter((c: Classification) => c.value.trim().length > 0);
  }
  // Back-compat: accept a legacy single `unspsc` string.
  if (it?.unspsc) return [{ domain: "UNSPSC", value: String(it.unspsc) }];
  return [];
}

function normalizeItem(it: any): CatalogItem {
  return {
    supplierPartId: String(it?.supplierPartId ?? ""),
    supplierPartAuxiliaryId: it?.supplierPartAuxiliaryId ? String(it.supplierPartAuxiliaryId) : undefined,
    description: String(it?.description ?? ""),
    unitPrice: Number(it?.unitPrice ?? 0) || 0,
    currency: String(it?.currency ?? "USD"),
    uom: String(it?.uom ?? "EA"),
    classifications: normalizeClassifications(it),
    manufacturerPartId: it?.manufacturerPartId ? String(it.manufacturerPartId) : undefined,
    manufacturerName: it?.manufacturerName ? String(it.manufacturerName) : undefined,
    allowFractional: Boolean(it?.allowFractional),
  };
}

function normalizeProductList(body: any): ProductListInput {
  const items: CatalogItem[] = Array.isArray(body?.items) ? body.items.map(normalizeItem) : [];
  return {
    name: String(body?.name ?? "Untitled product list"),
    description: body?.description ? String(body.description) : undefined,
    items,
  };
}

productsRoute.get("/", (c) => c.json(listProductLists()));
productsRoute.post("/", async (c) => {
  const input = normalizeProductList(await c.req.json().catch(() => ({})));
  if (!input.name.trim()) return c.json({ errors: ["name is required"] }, 400);
  return c.json(await createProductList(input), 201);
});
productsRoute.get("/:id", (c) => {
  const p = getProductList(c.req.param("id"));
  return p ? c.json(p) : c.json({ error: "not found" }, 404);
});
productsRoute.put("/:id", async (c) => {
  if (!getProductList(c.req.param("id"))) return c.json({ error: "not found" }, 404);
  const input = normalizeProductList(await c.req.json().catch(() => ({})));
  return c.json(await updateProductList(c.req.param("id"), input));
});
productsRoute.delete("/:id", async (c) => {
  try {
    const ok = await deleteProductList(c.req.param("id"));
    return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
});

// Read-only built-in sample lists the UI loads to pre-fill a new (editable) list.
productListPresetsRoute.get("/", (c) => c.json(PRODUCT_LIST_PRESETS));
