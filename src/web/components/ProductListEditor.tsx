import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { CatalogItem, Classification, ProductList } from "../types";
import { api } from "../api";
import { Actions, useDraft, type SaveProps } from "./PartyEditors";

// Editor for a reusable Product List — a named set of catalog products that one
// or more Suppliers serve as their Mode-B catalog. Mirrors ProfileEditor: a
// "Load built-in preset" selector fills the form from the sample library, and
// repeatable rows edit each product (with a per-item fractional-quantity toggle).

const blankList = (): Partial<ProductList> => ({ name: "", description: "", items: [] });

const blankItem = (): CatalogItem => ({
  supplierPartId: "",
  description: "",
  unitPrice: 0,
  currency: "USD",
  uom: "EA",
  classifications: [{ domain: "UNSPSC", value: "" }],
  allowFractional: false,
});

export function ProductListEditor({ list, onSave, onDelete }: { list: ProductList | null } & SaveProps) {
  const [draft, setDraft] = useDraft<Partial<ProductList>>(list ?? blankList(), list?.id ?? "new");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [presets, setPresets] = useState<ProductList[]>([]);

  useEffect(() => {
    api.listProductListPresets().then(setPresets).catch(() => setPresets([]));
  }, []);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      await onSave(draft);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const items = draft.items ?? [];
  const setItem = (i: number, patch: Partial<CatalogItem>) =>
    setDraft({ ...draft, items: items.map((it, j) => (j === i ? { ...it, ...patch } : it)) });
  const addItem = () => setDraft({ ...draft, items: [...items, blankItem()] });
  const removeItem = (i: number) => setDraft({ ...draft, items: items.filter((_, j) => j !== i) });

  const setClass = (i: number, ci: number, patch: Partial<Classification>) =>
    setItem(i, { classifications: (items[i].classifications ?? []).map((c, j) => (j === ci ? { ...c, ...patch } : c)) });
  const addClass = (i: number) =>
    setItem(i, { classifications: [...(items[i].classifications ?? []), { domain: "UNSPSC", value: "" }] });
  const removeClass = (i: number, ci: number) =>
    setItem(i, { classifications: (items[i].classifications ?? []).filter((_, j) => j !== ci) });

  const loadPreset = (id: string) => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    // Fill from the preset but keep editing/creating the current row, not the
    // read-only library item. Append a tag so a duplicate name is obvious.
    setDraft({
      ...draft,
      name: draft.name?.trim() ? draft.name : `${preset.name} (copy)`,
      description: preset.description,
      items: preset.items.map((it) => ({ ...it })),
    });
  };

  return (
    <div className="editor-form">
      <p className="hint">
        A product list is a named set of catalog items. Assign it to one or more Suppliers; each
        supplier serves the union of its lists as its Mode-B catalog.
      </p>

      <div className="form-row">
        <label>Load built-in preset <span className="hint">(fills the items below — then customize)</span></label>
        <select value="" onChange={(e) => e.target.value && loadPreset(e.target.value)}>
          <option value="">— choose a preset —</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>{p.name} ({p.items.length} items)</option>
          ))}
        </select>
      </div>

      <div className="form-row">
        <label>Name</label>
        <input value={draft.name ?? ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="My assortment" />
      </div>
      <div className="form-row">
        <label>Description <span className="hint">(optional)</span></label>
        <input value={draft.description ?? ""} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Q3 industrial catalog" />
      </div>

      <fieldset>
        <legend>Products <span className="hint">({items.length})</span></legend>
        {items.length === 0 && <p className="hint">No items yet — add some or load a preset above.</p>}
        {items.map((it, i) => (
          <div className="product-card" key={i}>
            <div className="product-card-head">
              <span className="hint">Item {i + 1}</span>
              <button className="btn-link" onClick={() => removeItem(i)}>remove item</button>
            </div>
            <div className="product-card-grid">
              <Field label="SupplierPartID">
                <input value={it.supplierPartId} onChange={(e) => setItem(i, { supplierPartId: e.target.value })} />
              </Field>
              <Field label="SupplierPartAuxiliaryID">
                <input value={it.supplierPartAuxiliaryId ?? ""} onChange={(e) => setItem(i, { supplierPartAuxiliaryId: e.target.value || undefined })} />
              </Field>
              <Field label="Description" grow>
                <input value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} />
              </Field>
            </div>
            <div className="product-card-grid">
              <Field label="Unit price">
                <input type="number" step="0.01" value={it.unitPrice} onChange={(e) => setItem(i, { unitPrice: Number(e.target.value) })} />
              </Field>
              <Field label="Currency">
                <input value={it.currency} onChange={(e) => setItem(i, { currency: e.target.value })} />
              </Field>
              <Field label="Unit of measure">
                <input value={it.uom} onChange={(e) => setItem(i, { uom: e.target.value })} />
              </Field>
              <Field label="ManufacturerPartID">
                <input value={it.manufacturerPartId ?? ""} onChange={(e) => setItem(i, { manufacturerPartId: e.target.value || undefined })} />
              </Field>
              <Field label="ManufacturerName">
                <input value={it.manufacturerName ?? ""} onChange={(e) => setItem(i, { manufacturerName: e.target.value || undefined })} />
              </Field>
              <label className="check-inline" title="Allow fractional order quantities (e.g. 1.5)">
                <input type="checkbox" checked={!!it.allowFractional} onChange={(e) => setItem(i, { allowFractional: e.target.checked })} />
                fractional qty
              </label>
            </div>
            <div className="product-card-class">
              <span className="field-label">Classifications <span className="hint">(domain + value; cXML needs at least one)</span></span>
              {(it.classifications ?? []).map((c, ci) => (
                <span className="class-row" key={ci}>
                  <input placeholder="domain (e.g. UNSPSC)" value={c.domain} onChange={(e) => setClass(i, ci, { domain: e.target.value })} />
                  <input placeholder="value (e.g. 31161500)" value={c.value} onChange={(e) => setClass(i, ci, { value: e.target.value })} />
                  <button className="btn-link" onClick={() => removeClass(i, ci)} title="remove classification">✕</button>
                </span>
              ))}
              <button className="btn-link" onClick={() => addClass(i)}>+ classification</button>
            </div>
          </div>
        ))}
        <button className="btn-secondary" onClick={addItem}>+ Add item</button>
      </fieldset>

      {list?.builtin && (
        <p className="hint">This is a built-in sample list. Saving edits it in place; deleting removes it (it can be re-seeded on next start).</p>
      )}

      <Actions saving={saving} err={err} isNew={!list} noun="product list" onSave={save} onDelete={list && onDelete ? () => onDelete(list.id) : undefined} />
    </div>
  );
}

// A compact labeled field for the product card: a small caption above its input,
// so the field stays identifiable once the value is typed (placeholders vanish).
function Field({ label, grow, children }: { label: string; grow?: boolean; children: ReactNode }) {
  return (
    <label className={`product-field${grow ? " grow" : ""}`}>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}
