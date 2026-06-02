import type {
  Cart,
  Connection,
  LogRecord,
  OrderResult,
  SessionSummary,
  SetupResult,
} from "./types";

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? body.errors?.join(", ") ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listConnections: () =>
    fetch("/api/connections").then((r) => jsonOrThrow<Connection[]>(r)),

  createConnection: (data: Partial<Connection>) =>
    fetch("/api/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    }).then((r) => jsonOrThrow<Connection>(r)),

  updateConnection: (id: string, data: Partial<Connection>) =>
    fetch(`/api/connections/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    }).then((r) => jsonOrThrow<Connection>(r)),

  deleteConnection: (id: string) =>
    fetch(`/api/connections/${id}`, { method: "DELETE" }).then((r) =>
      jsonOrThrow<{ ok: boolean }>(r),
    ),

  setupPreview: (id: string) =>
    fetch(`/api/connections/${id}/setup/preview`).then((r) =>
      jsonOrThrow<{ buyerCookie: string; xml: string; browserFormPostUrl: string }>(r),
    ),

  sendSetup: (id: string, body: { buyerCookie?: string; xml?: string }) =>
    fetch(`/api/connections/${id}/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => jsonOrThrow<SetupResult>(r)),

  orderPreview: (id: string, body: unknown) =>
    fetch(`/api/connections/${id}/order/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => jsonOrThrow<{ xml: string; orderId: string }>(r)),

  sendOrder: (id: string, body: unknown) =>
    fetch(`/api/connections/${id}/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => jsonOrThrow<OrderResult>(r)),

  getCart: (sessionId: string) =>
    fetch(`/api/cart/${encodeURIComponent(sessionId)}`).then((r) =>
      r.ok ? (r.json() as Promise<Cart>) : null,
    ),

  listSessions: () => fetch("/api/sessions").then((r) => jsonOrThrow<SessionSummary[]>(r)),

  getSession: (id: string) =>
    fetch(`/api/sessions/${encodeURIComponent(id)}`).then((r) => jsonOrThrow<LogRecord[]>(r)),

  recent: (limit = 200) =>
    fetch(`/api/recent?limit=${limit}`).then((r) => jsonOrThrow<LogRecord[]>(r)),

  runtime: () =>
    fetch("/api/runtime").then((r) => jsonOrThrow<{ publicUrl: string; callbackUrl: string }>(r)),
};
