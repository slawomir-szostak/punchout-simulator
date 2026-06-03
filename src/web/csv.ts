import type { CatalogItem, Classification } from "./types";

// Client-side CSV import for product lists. Kept dependency-free and pure (no
// DOM) so it's unit-testable and runs in the browser without an upload endpoint.

// Minimal RFC-4180-ish parser: handles quoted fields, "" escapes, and CRLF/LF.
export function parseCsv(input: string): string[][] {
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* swallow; handled with the following \n */ }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

// Header → CatalogItem field. Generous aliases so real exports map without edits.
const HEADER_ALIASES: Record<string, string> = {
  supplierpartid: "supplierPartId", partid: "supplierPartId", part: "supplierPartId", sku: "supplierPartId", id: "supplierPartId",
  supplierpartauxiliaryid: "supplierPartAuxiliaryId", auxiliaryid: "supplierPartAuxiliaryId", auxid: "supplierPartAuxiliaryId", aux: "supplierPartAuxiliaryId",
  description: "description", desc: "description", name: "description", title: "description",
  unitprice: "unitPrice", price: "unitPrice", cost: "unitPrice",
  currency: "currency", cur: "currency", ccy: "currency",
  uom: "uom", unitofmeasure: "uom", unit: "uom",
  unspsc: "unspsc",
  classificationdomain: "classificationDomain", domain: "classificationDomain",
  classification: "classification", classificationvalue: "classification", commoditycode: "classification",
  classifications: "classifications",
  manufacturerpartid: "manufacturerPartId", mfrpartid: "manufacturerPartId", mpn: "manufacturerPartId",
  manufacturername: "manufacturerName", mfrname: "manufacturerName", manufacturer: "manufacturerName", brand: "manufacturerName",
  allowfractional: "allowFractional", fractional: "allowFractional", decimalqty: "allowFractional",
};

const TRUTHY = new Set(["1", "true", "yes", "y", "x", "t"]);

export interface CsvImportResult {
  items: CatalogItem[];
  /** Rows skipped because they had no SupplierPartID. */
  skipped: number;
}

/**
 * Map CSV text to CatalogItems. The first row is a header (column order is free).
 * Throws if the file is empty or has no SupplierPartID-like column.
 */
export function csvToCatalogItems(text: string): CsvImportResult {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (rows.length === 0) throw new Error("The CSV file is empty.");
  const headers = rows[0].map((h) => HEADER_ALIASES[norm(h)] ?? "");
  if (!headers.includes("supplierPartId")) {
    throw new Error('No SupplierPartID column found. The first row must be a header with at least a "SupplierPartID" (or SKU / Part) column.');
  }
  const col = (key: string) => headers.indexOf(key);
  const cell = (row: string[], key: string) => {
    const i = col(key);
    return i >= 0 ? (row[i] ?? "").trim() : "";
  };

  const items: CatalogItem[] = [];
  let skipped = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const supplierPartId = cell(row, "supplierPartId");
    if (!supplierPartId) { skipped++; continue; }

    const priceStr = cell(row, "unitPrice");
    let unitPrice = Number(priceStr);
    if (Number.isNaN(unitPrice)) unitPrice = Number(priceStr.replace(",", ".")); // tolerate decimal comma
    if (Number.isNaN(unitPrice)) unitPrice = 0;

    items.push({
      supplierPartId,
      supplierPartAuxiliaryId: cell(row, "supplierPartAuxiliaryId") || undefined,
      description: cell(row, "description"),
      unitPrice,
      currency: cell(row, "currency") || "USD",
      uom: cell(row, "uom") || "EA",
      classifications: parseClassifications(row, cell),
      manufacturerPartId: cell(row, "manufacturerPartId") || undefined,
      manufacturerName: cell(row, "manufacturerName") || undefined,
      allowFractional: TRUTHY.has(cell(row, "allowFractional").toLowerCase()) || undefined,
    });
  }
  return { items, skipped };
}

// Classifications, in priority order:
//   1. a `Classifications` column: "UNSPSC:31161500;eCl@ss:27-06-01" (";"-separated,
//      "domain:value"; a bare value defaults to the UNSPSC domain)
//   2. a `ClassificationDomain` + `Classification` pair (single)
//   3. a `UNSPSC` column (single, domain UNSPSC)
function parseClassifications(row: string[], cell: (row: string[], key: string) => string): Classification[] {
  const multi = cell(row, "classifications");
  if (multi) {
    return multi
      .split(";")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const ci = p.indexOf(":");
        return ci >= 0
          ? { domain: p.slice(0, ci).trim() || "UNSPSC", value: p.slice(ci + 1).trim() }
          : { domain: "UNSPSC", value: p };
      })
      .filter((c) => c.value);
  }
  const value = cell(row, "classification");
  if (value) return [{ domain: cell(row, "classificationDomain") || "UNSPSC", value }];
  const unspsc = cell(row, "unspsc");
  if (unspsc) return [{ domain: "UNSPSC", value: unspsc }];
  return [];
}

/** A header row + two example rows, for the "Download template" link. */
export const CSV_TEMPLATE = [
  "SupplierPartID,SupplierPartAuxiliaryID,Description,UnitPrice,Currency,UoM,UNSPSC,ManufacturerPartID,ManufacturerName,AllowFractional",
  "WIDGET-001,WIDGET-001-STD,Premium Steel Widget,12.50,USD,EA,31161500,MFR-W001,Acme Manufacturing,",
  'CABLE-CU-2.5,,"Copper Cable 2.5mm², per metre",1.15,EUR,MTR,26121600,WIRE-25,Volt Industries,yes',
  "",
].join("\n");
