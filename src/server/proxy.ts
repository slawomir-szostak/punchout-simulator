import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

// Corporate-proxy support for the tool's outbound server-to-server cXML.
//
// Node's global `fetch` (undici) does NOT honour HTTP_PROXY/HTTPS_PROXY/NO_PROXY
// on its own — unlike curl, Postman, or most CLIs. On a locked-down corporate
// network (commonly Windows), a direct connection to an external supplier is
// silently black-holed, so a SetupRequest/OrderRequest hangs until the 30s
// abort and surfaces as "HTTP 0 / This operation was aborted". Wiring undici's
// EnvHttpProxyAgent as the global dispatcher makes `fetch` respect the standard
// proxy env vars on every platform.

const LOOPBACK = ["localhost", "127.0.0.1", "::1"];

// Strip any user:pass@ credentials from a proxy URL before logging it.
export function redactProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
      return u.toString();
    }
    return url;
  } catch {
    return url;
  }
}

// Merge the caller's NO_PROXY with loopback hosts so the tool's own /sim
// self-calls (and any localhost supplier) always bypass the proxy. Dedupes,
// preserves existing entries, and is case-insensitive on the host names.
export function mergeNoProxy(existing: string | undefined): string {
  const have = (existing ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const lower = new Set(have.map((s) => s.toLowerCase()));
  const merged = [...have];
  for (const h of LOOPBACK) if (!lower.has(h)) merged.push(h);
  return merged.join(",");
}

export interface ProxySettings {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy: string;
  enabled: boolean;
}

// Read proxy configuration from an env-like object (defaults to process.env).
// Accepts both upper- and lower-case variable names (curl/wget convention).
export function detectProxy(env: Record<string, string | undefined> = process.env): ProxySettings {
  const httpProxy = env.HTTP_PROXY || env.http_proxy || undefined;
  const httpsProxy = env.HTTPS_PROXY || env.https_proxy || undefined;
  return {
    httpProxy,
    httpsProxy,
    noProxy: mergeNoProxy(env.NO_PROXY || env.no_proxy),
    enabled: !!(httpProxy || httpsProxy),
  };
}

// Install the proxy dispatcher when a proxy env var is present. Idempotent-safe
// to call once at startup. Returns the settings used (or null when no proxy is
// configured, leaving fetch to connect directly). `log` is injectable for tests.
export function setupProxy(
  env: Record<string, string | undefined> = process.env,
  log: (msg: string) => void = (m) => console.log(m),
): ProxySettings | null {
  const s = detectProxy(env);
  if (!s.enabled) return null;

  // Ensure loopback bypass is visible to EnvHttpProxyAgent (it reads NO_PROXY).
  env.NO_PROXY = s.noProxy;
  env.no_proxy = s.noProxy;
  setGlobalDispatcher(new EnvHttpProxyAgent());

  const via = s.httpsProxy ? redactProxyUrl(s.httpsProxy) : redactProxyUrl(s.httpProxy ?? "");
  log(`  proxy:      outbound cXML via ${via} (NO_PROXY=${s.noProxy})`);
  return s;
}
