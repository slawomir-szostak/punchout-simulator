import { describe, expect, it } from "vitest";
import {
  buildMultipartRelated,
  getBoundary,
  isMultipart,
  normalizeContentId,
  parseMultipartRelated,
  stripCidScheme,
} from "../src/server/cxml/multipart.js";

describe("normalizeContentId", () => {
  it("strips angle brackets and whitespace", () => {
    expect(normalizeContentId("  <abc@host> ")).toBe("abc@host");
    expect(normalizeContentId(undefined)).toBe("");
  });
});

describe("stripCidScheme", () => {
  it("removes a case-insensitive cid: prefix", () => {
    expect(stripCidScheme("CID:doc-1")).toBe("doc-1");
    expect(stripCidScheme("cid:doc-2")).toBe("doc-2");
  });
});

describe("isMultipart / getBoundary", () => {
  it("detects multipart and extracts the boundary", () => {
    const ct = 'multipart/related; boundary="xyz"; type="application/xml"';
    expect(isMultipart(ct)).toBe(true);
    expect(getBoundary(ct)).toBe("xyz");
    expect(isMultipart("text/xml")).toBe(false);
  });
});

describe("multipart round-trip", () => {
  it("builds then parses, preserving parts and Content-IDs", () => {
    const cxml = "<cXML>doc</cXML>";
    const built = buildMultipartRelated(cxml, [
      { contentId: "doc-1", filename: "a.txt", contentType: "text/plain", data: Buffer.from("hello") },
      { contentId: "doc-2", filename: "b.bin", contentType: "application/octet-stream", data: Buffer.from([1, 2, 3, 4]) },
    ]);

    expect(isMultipart(built.contentType)).toBe(true);

    const parsed = parseMultipartRelated(built.body, built.contentType);
    expect(parsed.root?.body.toString("utf8")).toBe(cxml);

    const doc1 = parsed.byContentId.get("doc-1");
    const doc2 = parsed.byContentId.get("doc-2");
    expect(doc1?.body.toString("utf8")).toBe("hello");
    expect(Array.from(doc2!.body)).toEqual([1, 2, 3, 4]);
    expect(doc1?.contentType).toBe("text/plain");
  });

  it("preserves binary payloads exactly", () => {
    const bytes = Buffer.from([0, 255, 13, 10, 0, 200, 100]);
    const built = buildMultipartRelated("<cXML/>", [
      { contentId: "bin", contentType: "application/octet-stream", data: bytes },
    ]);
    const parsed = parseMultipartRelated(built.body, built.contentType);
    expect(Array.from(parsed.byContentId.get("bin")!.body)).toEqual(Array.from(bytes));
  });

  it("base64-encodes attachment parts and decodes them back on parse", () => {
    // Binary that would corrupt as raw text but survives base64 cleanly.
    const bytes = Buffer.from([0, 255, 13, 10, 0, 200, 100, 1, 2]);
    const built = buildMultipartRelated(
      "<cXML/>",
      [{ contentId: "bin", contentType: "application/pdf", data: bytes }],
      { attachmentEncoding: "base64" },
    );

    const wire = built.body.toString("utf8");
    expect(wire).toContain("Content-Transfer-Encoding: base64");
    expect(wire).toContain(bytes.toString("base64"));

    // The parser decodes base64 parts back to their exact original bytes.
    const parsed = parseMultipartRelated(built.body, built.contentType);
    expect(parsed.byContentId.get("bin")!.headers["content-transfer-encoding"]).toBe("base64");
    expect(Array.from(parsed.byContentId.get("bin")!.body)).toEqual(Array.from(bytes));
  });

  it("wraps long base64 payloads at 76 columns (RFC 2045)", () => {
    const built = buildMultipartRelated(
      "<cXML/>",
      [{ contentId: "big", contentType: "application/octet-stream", data: Buffer.alloc(300, 0x41) }],
      { attachmentEncoding: "base64" },
    );
    const b64Lines = built.body
      .toString("utf8")
      .split("\r\n")
      .filter((l) => /^[A-Za-z0-9+/=]+$/.test(l) && l.length > 4);
    expect(b64Lines.length).toBeGreaterThan(1);
    expect(Math.max(...b64Lines.map((l) => l.length))).toBeLessThanOrEqual(76);
  });
});
