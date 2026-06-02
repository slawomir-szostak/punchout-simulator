import { nanoid } from "nanoid";

// Hand-assembled multipart/related per spec sections 6 and 11. Part 1 is the
// cXML document; parts 2..n are files, each carrying a Content-ID that the XML
// references via <Attachment><URL>cid:XXX</URL>.

export interface MultipartAttachment {
  contentId: string; // without angle brackets
  filename?: string;
  contentType: string;
  data: Buffer;
}

export interface BuiltMultipart {
  body: Buffer;
  contentType: string;
  boundary: string;
}

/** Strip angle brackets and surrounding whitespace from a Content-ID. */
export function normalizeContentId(cid: string | undefined): string {
  if (!cid) return "";
  return cid.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
}

/** Strip the `cid:` scheme prefix from an Attachment URL (case-insensitive). */
export function stripCidScheme(url: string | undefined): string {
  if (!url) return "";
  return url.trim().replace(/^cid:/i, "").trim();
}

/** Encode a buffer as base64 wrapped at 76 chars per RFC 2045 (CRLF separators). */
function base64Wrapped(data: Buffer): Buffer {
  const lines = data.toString("base64").match(/.{1,76}/g) ?? [];
  return Buffer.from(lines.join("\r\n"), "utf8");
}

export function buildMultipartRelated(
  cxml: string,
  attachments: MultipartAttachment[],
  opts: {
    mainContentId?: string;
    boundary?: string;
    /** Transfer encoding for attachment parts. Defaults to "binary" (raw bytes). */
    attachmentEncoding?: "binary" | "base64";
  } = {},
): BuiltMultipart {
  const boundary = opts.boundary || `cxml-${nanoid(20)}`;
  const useBase64 = opts.attachmentEncoding === "base64";
  const mainCid = opts.mainContentId ?? `cxml-main@punchout-simulator`;
  const CRLF = "\r\n";
  const parts: Buffer[] = [];

  const pushPart = (headers: string[], data: Buffer) => {
    parts.push(Buffer.from(`--${boundary}${CRLF}`, "utf8"));
    parts.push(Buffer.from(headers.join(CRLF) + CRLF + CRLF, "utf8"));
    parts.push(data);
    parts.push(Buffer.from(CRLF, "utf8"));
  };

  pushPart(
    [
      `Content-Type: application/xml; charset=UTF-8`,
      `Content-Transfer-Encoding: binary`,
      `Content-ID: <${mainCid}>`,
    ],
    Buffer.from(cxml, "utf8"),
  );

  for (const att of attachments) {
    const disposition = att.filename
      ? `Content-Disposition: attachment; filename="${att.filename}"`
      : `Content-Disposition: attachment`;
    pushPart(
      [
        `Content-Type: ${att.contentType}`,
        `Content-Transfer-Encoding: ${useBase64 ? "base64" : "binary"}`,
        `Content-ID: <${normalizeContentId(att.contentId)}>`,
        disposition,
      ],
      useBase64 ? base64Wrapped(att.data) : att.data,
    );
  }

  parts.push(Buffer.from(`--${boundary}--${CRLF}`, "utf8"));

  return {
    body: Buffer.concat(parts),
    boundary,
    contentType: `multipart/related; boundary="${boundary}"; type="application/xml"; start="<${mainCid}>"`,
  };
}

export interface ParsedPart {
  headers: Record<string, string>;
  contentId: string; // normalized
  contentType?: string;
  body: Buffer;
}

export interface ParsedMultipart {
  parts: ParsedPart[];
  /** The first part (or the one matching `start`) — the cXML document. */
  root?: ParsedPart;
  byContentId: Map<string, ParsedPart>;
}

export function getBoundary(contentType: string): string | undefined {
  const m = /boundary="?([^";]+)"?/i.exec(contentType);
  return m?.[1];
}

/** Extract the `start` parameter (the root part's Content-ID) from a multipart content-type. */
export function getStartCid(contentType: string): string | undefined {
  const m = /start="?<?([^">]+)>?"?/i.exec(contentType);
  return m ? normalizeContentId(m[1]) : undefined;
}

export function isMultipart(contentType: string | undefined): boolean {
  return !!contentType && /^multipart\//i.test(contentType.trim());
}

export function parseMultipartRelated(
  body: Buffer,
  contentType: string,
): ParsedMultipart {
  const boundary = getBoundary(contentType);
  if (!boundary) {
    return { parts: [], byContentId: new Map() };
  }
  const delimiter = Buffer.from(`--${boundary}`, "utf8");
  const segments = splitBuffer(body, delimiter);
  const parts: ParsedPart[] = [];

  for (const seg of segments) {
    // Skip the preamble, the closing "--" marker and empty segments.
    const trimmed = trimLeadingCrlf(seg);
    if (trimmed.length === 0) continue;
    if (trimmed.length >= 2 && trimmed[0] === 0x2d && trimmed[1] === 0x2d) {
      continue; // closing boundary "--boundary--"
    }
    const splitIdx = findHeaderBodySplit(trimmed);
    if (splitIdx < 0) continue;
    const headerText = trimmed.subarray(0, splitIdx).toString("utf8");
    let bodyBuf = trimmed.subarray(splitIdx);
    bodyBuf = stripBoundaryTrailingCrlf(bodyBuf);

    const headers: Record<string, string> = {};
    for (const line of headerText.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        headers[line.slice(0, idx).trim().toLowerCase()] = line
          .slice(idx + 1)
          .trim();
      }
    }
    // Decode the part to its actual content bytes per its transfer encoding, so
    // every consumer sees the real file (a base64 part decodes back to binary).
    if (headers["content-transfer-encoding"]?.toLowerCase() === "base64") {
      bodyBuf = Buffer.from(bodyBuf.toString("utf8"), "base64");
    }
    parts.push({
      headers,
      contentId: normalizeContentId(headers["content-id"]),
      contentType: headers["content-type"],
      body: bodyBuf,
    });
  }

  const start = normalizeContentId(/start="?<?([^">]+)>?"?/i.exec(contentType)?.[1]);
  const byContentId = new Map<string, ParsedPart>();
  for (const p of parts) if (p.contentId) byContentId.set(p.contentId, p);
  const root =
    (start && byContentId.get(start)) ||
    parts.find((p) => /xml/i.test(p.contentType ?? "")) ||
    parts[0];

  return { parts, root, byContentId };
}

// --- buffer helpers -----------------------------------------------------------

function splitBuffer(buf: Buffer, delimiter: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  let idx = buf.indexOf(delimiter, start);
  while (idx !== -1) {
    out.push(buf.subarray(start, idx));
    start = idx + delimiter.length;
    idx = buf.indexOf(delimiter, start);
  }
  out.push(buf.subarray(start));
  return out;
}

function trimLeadingCrlf(buf: Buffer): Buffer {
  let i = 0;
  while (i < buf.length && (buf[i] === 0x0d || buf[i] === 0x0a)) i++;
  return buf.subarray(i);
}

function stripBoundaryTrailingCrlf(buf: Buffer): Buffer {
  let end = buf.length;
  while (end > 0 && (buf[end - 1] === 0x0d || buf[end - 1] === 0x0a)) end--;
  return buf.subarray(0, end);
}

/** Index of the start of the body (just after the blank line). */
function findHeaderBodySplit(buf: Buffer): number {
  const crlfcrlf = buf.indexOf("\r\n\r\n");
  const lflf = buf.indexOf("\n\n");
  if (crlfcrlf !== -1 && (lflf === -1 || crlfcrlf < lflf)) return crlfcrlf + 4;
  if (lflf !== -1) return lflf + 2;
  return -1;
}
