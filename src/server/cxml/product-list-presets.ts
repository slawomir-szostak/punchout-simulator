import type { ProductList } from "./types.js";

// Built-in sample Product Lists. These are the source of truth for both the rows
// seeded into config.json on first run AND the read-only library the editor can
// load into a new list. Keeping them here in one place avoids the seeded copy
// and the loadable preset drifting apart.
//
// The "sample" assortment replaces the old 3-item demo catalog as the default a
// supplier serves out of the box. A couple of items are sold by a divisible unit
// of measure (metre / litre) and set `allowFractional` so the Mode-B catalog
// accepts quantities like 1.5.

export type ProductListPreset = Omit<ProductList, "createdAt" | "updatedAt">;

export const PRODUCT_LIST_PRESETS: ProductListPreset[] = [
  {
    id: "sample",
    name: "Sample assortment",
    builtin: true,
    description: "A representative office & industrial supplies catalog (~20 items).",
    items: [
      { supplierPartId: "WIDGET-001", supplierPartAuxiliaryId: "WIDGET-001-STD", description: "Premium Steel Widget", unitPrice: 12.5, currency: "USD", uom: "EA", classifications: [{ domain: "UNSPSC", value: "31161500" }], manufacturerPartId: "MFR-W001", manufacturerName: "Acme Manufacturing" },
      { supplierPartId: "BOLT-250", supplierPartAuxiliaryId: "BOLT-250-CONTRACT-A", description: "M8 Hex Bolt (pack of 250)", unitPrice: 34.0, currency: "USD", uom: "PK", classifications: [{ domain: "UNSPSC", value: "31161600" }], manufacturerPartId: "MFR-B250", manufacturerName: "Acme Manufacturing" },
      { supplierPartId: "NUT-M8-500", description: "M8 Hex Nut (pack of 500)", unitPrice: 28.5, currency: "USD", uom: "PK", classifications: [{ domain: "UNSPSC", value: "31161700" }], manufacturerPartId: "MFR-N8500", manufacturerName: "Acme Manufacturing" },
      { supplierPartId: "WASHER-M8", description: "M8 Flat Washer (pack of 1000)", unitPrice: 19.95, currency: "USD", uom: "PK", classifications: [{ domain: "UNSPSC", value: "31161800" }], manufacturerName: "Acme Manufacturing" },
      { supplierPartId: "TAPE-RED", supplierPartAuxiliaryId: "TAPE-RED-50M", description: "Industrial Marking Tape, Red", unitPrice: 5.75, currency: "USD", uom: "RL", classifications: [{ domain: "UNSPSC", value: "31201500" }] },
      { supplierPartId: "TAPE-YEL", supplierPartAuxiliaryId: "TAPE-YEL-50M", description: "Industrial Marking Tape, Yellow", unitPrice: 5.75, currency: "USD", uom: "RL", classifications: [{ domain: "UNSPSC", value: "31201500" }] },
      // Multiple classifications: UNSPSC + a supplier-specific commodity scheme.
      { supplierPartId: "CABLE-CU-2.5", supplierPartAuxiliaryId: "CABLE-CU-2.5-RAL", description: "Copper Cable 2.5mm² (by the metre)", unitPrice: 1.15, currency: "EUR", uom: "MTR", classifications: [{ domain: "UNSPSC", value: "26121600" }, { domain: "eCl@ss", value: "27-06-01-01" }], manufacturerPartId: "WIRE-25", manufacturerName: "Volt Industries", allowFractional: true },
      { supplierPartId: "CABLE-CU-4.0", supplierPartAuxiliaryId: "CABLE-CU-4.0-RAL", description: "Copper Cable 4.0mm² (by the metre)", unitPrice: 1.8, currency: "EUR", uom: "MTR", classifications: [{ domain: "UNSPSC", value: "26121600" }, { domain: "eCl@ss", value: "27-06-01-02" }], manufacturerPartId: "WIRE-40", manufacturerName: "Volt Industries", allowFractional: true },
      { supplierPartId: "PAINT-WHT", description: "Acrylic Wall Paint, White (by the litre)", unitPrice: 8.4, currency: "USD", uom: "LTR", classifications: [{ domain: "UNSPSC", value: "31211500" }], manufacturerName: "ColorWorks", allowFractional: true },
      { supplierPartId: "LUBE-OIL", description: "Machine Lubricating Oil (by the litre)", unitPrice: 6.9, currency: "USD", uom: "LTR", classifications: [{ domain: "UNSPSC", value: "15121800" }], manufacturerName: "SlickPro", allowFractional: true },
      { supplierPartId: "GLOVE-NIT-M", supplierPartAuxiliaryId: "GLOVE-NIT-M-CE", description: "Nitrile Gloves, Medium (box of 100)", unitPrice: 9.95, currency: "GBP", uom: "BX", classifications: [{ domain: "UNSPSC", value: "46181504" }], manufacturerName: "SafeHands" },
      { supplierPartId: "GLOVE-NIT-L", supplierPartAuxiliaryId: "GLOVE-NIT-L-CE", description: "Nitrile Gloves, Large (box of 100)", unitPrice: 9.95, currency: "GBP", uom: "BX", classifications: [{ domain: "UNSPSC", value: "46181504" }], manufacturerName: "SafeHands" },
      { supplierPartId: "GOGGLE-STD", description: "Safety Goggles, Anti-fog", unitPrice: 4.6, currency: "GBP", uom: "EA", classifications: [{ domain: "UNSPSC", value: "46181702" }], manufacturerName: "SafeHands" },
      { supplierPartId: "HELMET-WHT", description: "Hard Hat, White", unitPrice: 9.8, currency: "GBP", uom: "EA", classifications: [{ domain: "UNSPSC", value: "46181701" }], manufacturerName: "SafeHands" },
      { supplierPartId: "PAPER-A4", description: "Copy Paper A4 80gsm (ream of 500)", unitPrice: 18.0, currency: "PLN", uom: "RM", classifications: [{ domain: "UNSPSC", value: "14111507" }], manufacturerName: "PaperCo" },
      { supplierPartId: "PEN-BLU-12", description: "Ballpoint Pens, Blue (pack of 12)", unitPrice: 12.99, currency: "PLN", uom: "PK", classifications: [{ domain: "UNSPSC", value: "44121701" }], manufacturerName: "WriteRight" },
      { supplierPartId: "BINDER-A4", description: "Lever Arch Binder A4, Black", unitPrice: 11.5, currency: "PLN", uom: "EA", classifications: [{ domain: "UNSPSC", value: "44122011" }], manufacturerName: "Officeline" },
      { supplierPartId: "TONER-BLK", supplierPartAuxiliaryId: "TN-1000-OEM", description: "Laser Toner Cartridge, Black", unitPrice: 64.0, currency: "USD", uom: "EA", classifications: [{ domain: "UNSPSC", value: "44103105" }], manufacturerPartId: "TN-1000", manufacturerName: "PrintMax" },
      { supplierPartId: "BATT-AA-24", description: "Alkaline Batteries AA (pack of 24)", unitPrice: 14.5, currency: "USD", uom: "PK", classifications: [{ domain: "UNSPSC", value: "26111702" }], manufacturerName: "PowerCell" },
      { supplierPartId: "DRILL-BIT-SET", supplierPartAuxiliaryId: "DBS-19-HSS", description: "HSS Drill Bit Set (19 pieces)", unitPrice: 22.75, currency: "USD", uom: "ST", classifications: [{ domain: "UNSPSC", value: "27112700" }], manufacturerPartId: "DBS-19", manufacturerName: "Acme Manufacturing" },
      { supplierPartId: "GAFF-CLEAN", description: "All-purpose Cleaner Concentrate (by the litre)", unitPrice: 3.6, currency: "USD", uom: "LTR", classifications: [{ domain: "UNSPSC", value: "47131800" }], manufacturerName: "CleanLine", allowFractional: true },
    ],
  },
];

/** The seeded sample list — also used as the Mode-B default assortment. */
export const SAMPLE_PRODUCT_LIST: ProductList = {
  ...(PRODUCT_LIST_PRESETS[0] as ProductListPreset),
  createdAt: "",
  updatedAt: "",
};

/** Idempotently insert any missing built-in sample lists as ProductList rows. */
export function seedBuiltinProductLists(
  data: { productLists: ProductList[] },
  now: string,
): void {
  for (const preset of PRODUCT_LIST_PRESETS) {
    if (!data.productLists.some((p) => p.id === preset.id)) {
      data.productLists.push({ ...preset, createdAt: now, updatedAt: now });
    }
  }
}
