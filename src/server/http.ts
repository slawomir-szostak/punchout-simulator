// Server-to-server cXML transport. SetupRequest and OrderRequest go out from
// the tool here (no CORS, unlike a browser) — spec section 5.

export interface CxmlResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  rawBody: Buffer;
  contentType?: string;
  error?: string;
}

/**
 * Validate an outbound target before we POST to it. We restrict the scheme and
 * reject credentials embedded in the URL, and (below) we do not auto-follow
 * redirects to other hosts. We deliberately do NOT block private/loopback IPs:
 * the documented primary use is pointing the tool at a supplier on
 * localhost/staging. Exposure of who can configure these URLs is controlled by
 * the API auth (see app.ts), not by an IP allow-list here.
 */
function assertSafeOutboundUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`unsupported URL scheme "${u.protocol}" (only http/https allowed)`);
  }
  if (u.username || u.password) {
    throw new Error("credentials embedded in the URL are not allowed");
  }
}

export async function sendCxml(
  url: string,
  body: string | Buffer,
  contentType = "text/xml; charset=UTF-8",
  timeoutMs = 30000,
): Promise<CxmlResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    assertSafeOutboundUrl(url);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: body as any,
      // Do not transparently follow redirects to a different host (SSRF pivot);
      // a 3xx is surfaced to the caller as the response instead.
      redirect: "manual",
      signal: controller.signal,
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      headers,
      body: buf.toString("utf8"),
      rawBody: buf,
      contentType: res.headers.get("content-type") ?? undefined,
    };
  } catch (e) {
    return {
      status: 0,
      headers: {},
      body: "",
      rawBody: Buffer.alloc(0),
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}
