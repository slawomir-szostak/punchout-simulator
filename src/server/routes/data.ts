import { Hono } from "hono";
import { getCart } from "../cart-store.js";
import { readAttachment } from "../store/attachments.js";
import { listSessions, readAllRecent, readSession } from "../store/log.js";
import { getPublicUrl } from "../runtime.js";

// Read-only endpoints backing the SPA: sessions, log records, the active cart,
// attachment downloads, and runtime info.

export const dataRoute = new Hono();

dataRoute.get("/health", (c) => c.json({ ok: true }));

dataRoute.get("/runtime", (c) =>
  c.json({ publicUrl: getPublicUrl(), callbackUrl: `${getPublicUrl()}/punchout/return` }),
);

dataRoute.get("/sessions", (c) => c.json(listSessions()));

dataRoute.get("/sessions/:id", (c) => c.json(readSession(c.req.param("id"))));

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
