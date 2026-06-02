import type {
  Buyer,
  Cart,
  Connection,
  ConnectionWithParties,
  LogRecord,
  OrderResult,
  Profile,
  SessionSummary,
  SetupResult,
  Supplier,
} from "./types";

// --- API auth token --------------------------------------------------------
// When the tool is exposed (a non-loopback --public-url), the server requires a
// token on /api/*. The operator opens the printed `…/?token=XYZ` URL; we capture
// it once, persist it, and attach it to every request. On a plain localhost run
// no token is required and this is all inert.

const TOKEN_KEY = "pos-api-token";

function captureToken(): string {
  try {
    const url = new URL(window.location.href);
    const t = url.searchParams.get("token");
    if (t) {
      localStorage.setItem(TOKEN_KEY, t);
      url.searchParams.delete("token");
      window.history.replaceState({}, "", url.toString());
      return t;
    }
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

const token = typeof window !== "undefined" ? captureToken() : "";

function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

/** Append the token as a query param — for URLs that can't carry a header
 *  (EventSource, anchor hrefs). No-op when no token is in play. */
export function withToken(url: string): string {
  if (!token) return url;
  return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? body.errors?.join(", ") ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function crud<T>(base: string) {
  return {
    list: () => authFetch(base).then((r) => jsonOrThrow<T[]>(r)),
    create: (data: unknown) =>
      authFetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }).then(
        (r) => jsonOrThrow<T>(r),
      ),
    update: (id: string, data: unknown) =>
      authFetch(`${base}/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }).then(
        (r) => jsonOrThrow<T>(r),
      ),
    remove: (id: string) =>
      authFetch(`${base}/${id}`, { method: "DELETE" }).then((r) => jsonOrThrow<{ ok: boolean }>(r)),
  };
}

export const api = {
  buyers: crud<Buyer>("/api/buyers"),
  suppliers: crud<Supplier>("/api/suppliers"),
  profiles: crud<Profile>("/api/profiles"),

  listProfilePresets: () => authFetch("/api/profile-presets").then((r) => jsonOrThrow<Profile[]>(r)),

  listConnections: () =>
    authFetch("/api/connections").then((r) => jsonOrThrow<ConnectionWithParties[]>(r)),

  createConnection: (data: Partial<Connection>) =>
    authFetch("/api/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    }).then((r) => jsonOrThrow<Connection>(r)),

  updateConnection: (id: string, data: Partial<Connection>) =>
    authFetch(`/api/connections/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    }).then((r) => jsonOrThrow<Connection>(r)),

  deleteConnection: (id: string) =>
    authFetch(`/api/connections/${id}`, { method: "DELETE" }).then((r) =>
      jsonOrThrow<{ ok: boolean }>(r),
    ),

  setupPreview: (id: string) =>
    authFetch(`/api/connections/${id}/setup/preview`).then((r) =>
      jsonOrThrow<{ buyerCookie: string; xml: string; browserFormPostUrl: string }>(r),
    ),

  sendSetup: (id: string, body: { buyerCookie?: string; xml?: string }) =>
    authFetch(`/api/connections/${id}/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => jsonOrThrow<SetupResult>(r)),

  orderPreview: (id: string, body: unknown) =>
    authFetch(`/api/connections/${id}/order/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => jsonOrThrow<{ xml: string; orderId: string }>(r)),

  sendOrder: (id: string, body: unknown) =>
    authFetch(`/api/connections/${id}/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => jsonOrThrow<OrderResult>(r)),

  getCart: (sessionId: string) =>
    authFetch(`/api/cart/${encodeURIComponent(sessionId)}`).then((r) =>
      r.ok ? (r.json() as Promise<Cart>) : null,
    ),

  listSessions: () => authFetch("/api/sessions").then((r) => jsonOrThrow<SessionSummary[]>(r)),

  getSession: (id: string) =>
    authFetch(`/api/sessions/${encodeURIComponent(id)}`).then((r) => jsonOrThrow<LogRecord[]>(r)),

  rawMessage: (sessionId: string, recordId: string) =>
    authFetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/records/${encodeURIComponent(recordId)}/raw`,
    ).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))),

  recent: (limit = 200) =>
    authFetch(`/api/recent?limit=${limit}`).then((r) => jsonOrThrow<LogRecord[]>(r)),

  runtime: () =>
    authFetch("/api/runtime").then((r) => jsonOrThrow<{ publicUrl: string; callbackUrl: string }>(r)),
};
