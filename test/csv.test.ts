import { describe, expect, it } from "vitest";
import { csvToCatalogItems, parseCsv } from "../src/web/csv.js";

describe("parseCsv", () => {
  it("handles quoted fields, escaped quotes, commas and CRLF", () => {
    const rows = parseCsv('a,b\r\n"x,y","he said ""hi""",\n');
    expect(rows[0]).toEqual(["a", "b"]);
    expect(rows[1]).toEqual(["x,y", 'he said "hi"', ""]);
  });
  it("strips a leading BOM", () => {
    expect(parseCsv("﻿a,b")[0]).toEqual(["a", "b"]);
  });
});

describe("csvToCatalogItems", () => {
  it("maps headers (with aliases) and coerces types", () => {
    const csv = [
      "SKU,Description,Price,Currency,UoM,UNSPSC,AllowFractional",
      "WIDGET-001,Steel Widget,12.50,USD,EA,31161500,",
      "CABLE-2.5,Copper Cable,1.15,EUR,MTR,26121600,yes",
    ].join("\n");
    const { items, skipped } = csvToCatalogItems(csv);
    expect(skipped).toBe(0);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      supplierPartId: "WIDGET-001",
      description: "Steel Widget",
      unitPrice: 12.5,
      currency: "USD",
      uom: "EA",
      classifications: [{ domain: "UNSPSC", value: "31161500" }],
    });
    expect(items[0].allowFractional).toBeUndefined();
    expect(items[1].allowFractional).toBe(true);
  });

  it("parses a multi-classification column and aux id", () => {
    const csv = [
      "SupplierPartID,SupplierPartAuxiliaryID,Classifications",
      "P1,P1-AUX,UNSPSC:31161500;eCl@ss:27-06-01",
      "P2,,99887766", // bare value defaults to UNSPSC
    ].join("\n");
    const { items } = csvToCatalogItems(csv);
    expect(items[0].supplierPartAuxiliaryId).toBe("P1-AUX");
    expect(items[0].classifications).toEqual([
      { domain: "UNSPSC", value: "31161500" },
      { domain: "eCl@ss", value: "27-06-01" },
    ]);
    expect(items[1].classifications).toEqual([{ domain: "UNSPSC", value: "99887766" }]);
  });

  it("tolerates a decimal comma in the price", () => {
    const { items } = csvToCatalogItems("SupplierPartID,Price\nA,\"1,5\"");
    expect(items[0].unitPrice).toBe(1.5);
  });

  it("skips rows without a SupplierPartID and reports the count", () => {
    const { items, skipped } = csvToCatalogItems("SupplierPartID,Price\nA,1\n,2\n   ,3");
    expect(items).toHaveLength(1);
    expect(skipped).toBe(2);
  });

  it("throws when no SupplierPartID-like column is present", () => {
    expect(() => csvToCatalogItems("Foo,Bar\n1,2")).toThrow(/SupplierPartID/);
  });

  it("throws on an empty file", () => {
    expect(() => csvToCatalogItems("")).toThrow(/empty/i);
  });
});
