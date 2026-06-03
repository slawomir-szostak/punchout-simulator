import { Hono } from "hono";
import { getCart } from "../cart-store.js";
import { readAttachment } from "../store/attachments.js";
import { listSessions, readAllRecent, readSession } from "../store/log.js";
import { getBuyer, getConnection, getSupplier } from "../store/config.js";
import { getPublicUrl, getVersion } from "../runtime.js";
import {
  buildMultipartRelated,
  getBoundary,
  getStartCid,
  isMultipart,
  type MultipartAttachment,
} from "../cxml/multipart.js";
import type { LogRecord } from "../cxml/types.js";

// Read-only endpoints backing the SPA: sessions, log records, the active cart,
// attachment downloads, and runtime info.

export const dataRoute = new Hono();

// Reconstruct the raw wire message for a record: the stored headers, then the
// body. For an OrderRequest the log only keeps the cXML document, but the wire
// body was a multipart/related envelope — we never inline attachment bytes into
// the JSONL (see store/attachments.ts), so re-assemble it on demand from the
// document + the attachments on disk, reusing the record's original boundary and
// root Content-ID so the result matches what went over the wire.
function rawMessage(record: LogRecord): string {
  const ct = record.contentType ?? record.headers?.["Content-Type"] ?? record.headers?.["content-type"];
  let body = record.body;
  if (ct && isMultipart(ct) && record.attachments && record.attachments.length > 0) {
    const parts: MultipartAttachment[] = record.attachments.map((a) => ({
      contentId: a.contentId,
      filename: a.filename,
      contentType: a.contentType,
      data: readAttachment(a.hash) ?? Buffer.alloc(0),
    }));
    const built = buildMultipartRelated(record.body, parts, {
      boundary: getBoundary(ct),
      mainContentId: getStartCid(ct),
      attachmentEncoding: record.attachmentEncoding,
    });
    body = built.body.toString("utf8");
  }
  const headerLines = Object.entries(record.headers ?? {}).map(([k, v]) => `${k}: ${v}`);
  return headerLines.length > 0 ? `${headerLines.join("\r\n")}\r\n\r\n${body}` : body;
}

dataRoute.get("/health", (c) => c.json({ ok: true }));

dataRoute.get("/runtime", (c) =>
  c.json({ publicUrl: getPublicUrl(), callbackUrl: `${getPublicUrl()}/punchout/return`, version: getVersion() }),
);

// Enrich each session summary with the resolved parties + mode so the session
// list is human-readable. A summary's connectionId is a real Connection id for
// Mode-A-initiated sessions, or a Supplier id for inbound Mode-B traffic.
dataRoute.get("/sessions", (c) => {
  const enriched = listSessions().map((s) => {
    const conn = s.connectionId ? getConnection(s.connectionId) : undefined;
    if (conn) {
      return {
        ...s,
        connectionName: conn.name,
        mode: conn.mode,
        buyerName: getBuyer(conn.buyerId)?.name,
        supplierName: getSupplier(conn.supplierId)?.name,
        inbound: false,
      };
    }
    const supplier = s.connectionId ? getSupplier(s.connectionId) : undefined;
    return {
      ...s,
      supplierName: supplier?.name,
      mode: supplier ? "virtual-supplier" : undefined,
      inbound: !!supplier, // an external buyer hit our /sim
    };
  });
  return c.json(enriched);
});

dataRoute.get("/sessions/:id", (c) => c.json(readSession(c.req.param("id"))));

// Full raw wire message for one record (headers + reconstructed multipart body).
dataRoute.get("/sessions/:sessionId/records/:recordId/raw", (c) => {
  const record = readSession(c.req.param("sessionId")).find((r) => r.id === c.req.param("recordId"));
  if (!record) return c.json({ error: "not found" }, 404);
  c.header("Content-Type", "text/plain; charset=utf-8");
  return c.body(rawMessage(record));
});

dataRoute.get("/recent", (c) => {
  const limit = Number(c.req.query("limit") ?? "200");
  return c.json(readAllRecent(Number.isFinite(limit) ? limit : 200));
});

dataRoute.get("/cart/:sessionId", (c) => {
  const cart = getCart(c.req.param("sessionId"));
  return cart ? c.json(cart) : c.json({ error: "no cart for session" }, 404);
});

dataRoute.get("/attachments/:hash", (c) => {
  const data = readAttachment(c.req.param("hash"));
  if (!data) return c.json({ error: "not found" }, 404);
  c.header("Content-Type", "application/octet-stream");
  return c.body(data as any);
});
