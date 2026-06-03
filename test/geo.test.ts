import { describe, expect, it } from "vitest";
import { COUNTRIES, SUBDIVISIONS, countryName, postalCodeValid } from "../src/web/geo.js";

describe("geo reference data", () => {
  it("resolves a country name from its ISO code", () => {
    expect(countryName("US")).toBe("United States");
    expect(countryName("PL")).toBe("Poland");
    expect(countryName("ZZ")).toBeUndefined();
    expect(countryName(undefined)).toBeUndefined();
  });

  it("has unique ISO codes and includes the common ones", () => {
    const isos = COUNTRIES.map((c) => c.iso);
    expect(new Set(isos).size).toBe(isos.length);
    for (const iso of ["US", "CA", "GB", "DE", "PL", "JP"]) expect(isos).toContain(iso);
  });

  it("provides US states and CA provinces with code/name", () => {
    expect(SUBDIVISIONS.US.find((s) => s.code === "CA")?.name).toBe("California");
    expect(SUBDIVISIONS.CA.find((s) => s.code === "ON")?.name).toBe("Ontario");
    expect(SUBDIVISIONS.US.length).toBe(51); // 50 states + DC
  });

  it("validates postal codes per country, leniently", () => {
    expect(postalCodeValid("US", "94105")).toBe(true);
    expect(postalCodeValid("US", "9410")).toBe(false);
    expect(postalCodeValid("PL", "00-950")).toBe(true);
    expect(postalCodeValid("PL", "00950")).toBe(false);
    expect(postalCodeValid("CA", "K1A 0B1")).toBe(true);
    // unknown country or empty value → not validated
    expect(postalCodeValid("ZZ", "whatever")).toBe(true);
    expect(postalCodeValid("US", "")).toBe(true);
    expect(postalCodeValid(undefined, "94105")).toBe(true);
  });
});
