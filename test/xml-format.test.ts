import { describe, expect, it } from "vitest";
import { formatXml, looksLikeXml } from "../src/web/xml-format.js";

describe("formatXml", () => {
  it("indents nested elements by depth", () => {
    const out = formatXml(`<cXML><Header><From>x</From></Header></cXML>`);
    expect(out).toBe(["<cXML>", "  <Header>", "    <From>x</From>", "  </Header>", "</cXML>"].join("\n"));
  });

  it("keeps text content on one line (never splits a text-bearing element)", () => {
    const out = formatXml(`<a><Description>foo bar</Description></a>`);
    expect(out).toContain("<Description>foo bar</Description>");
    // The description must not be broken across lines.
    expect(out).not.toMatch(/<Description>\n/);
  });

  it("preserves significant whitespace inside text content", () => {
    const out = formatXml(`<a><b>  keep  inner  </b></a>`);
    expect(out).toContain("<b>  keep  inner  </b>");
  });

  it("does not indent under the XML declaration or DOCTYPE", () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE cXML SYSTEM "http://x/cXML.dtd"><cXML><Header/></cXML>`;
    const lines = formatXml(xml).split("\n");
    expect(lines[0]).toBe(`<?xml version="1.0"?>`);
    expect(lines[1]).toBe(`<!DOCTYPE cXML SYSTEM "http://x/cXML.dtd">`);
    expect(lines[2]).toBe(`<cXML>`);
    // self-closing element stays at depth 1 and does not increment depth
    expect(lines[3]).toBe(`  <Header/>`);
    expect(lines[4]).toBe(`</cXML>`);
  });

  it("returns empty/blank input unchanged", () => {
    expect(formatXml("")).toBe("");
    expect(formatXml("   ")).toBe("   ");
  });
});

describe("looksLikeXml", () => {
  it("recognizes cXML and generic XML", () => {
    expect(looksLikeXml(`<?xml version="1.0"?><cXML/>`)).toBe(true);
    expect(looksLikeXml(`  <cXML></cXML>`)).toBe(true);
    expect(looksLikeXml(`<OrderRequest/>`)).toBe(true);
  });
  it("rejects non-XML (e.g. raw multipart headers)", () => {
    expect(looksLikeXml(`Content-Type: multipart/related; boundary=x`)).toBe(false);
    expect(looksLikeXml(``)).toBe(false);
  });
});
