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

/** A supplier response larger than this is cut off (a broken or hostile
 *  endpoint must not be able to stream us out of memory). cXML responses are
 *  small; 25 MB leaves room for one with attachments. */
export const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;

class ResponseTooLarge extends Error {}

async function readCapped(res: Response, max: number, controller: AbortController): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    controller.abort();
    throw new ResponseTooLarge();
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > max) {
      controller.abort();
      throw new ResponseTooLarge();
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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
    const buf = await readCapped(res, MAX_RESPONSE_BYTES, controller);
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
      error: describeFetchError(e, timeoutMs),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn a thrown fetch error into something diagnosable. Node's `fetch` wraps the
 * real reason (ECONNREFUSED, ENOTFOUND, TLS failures) in `e.cause`, so the bare
 * message is usually just "fetch failed"; we surface the cause, and translate an
 * abort into the timeout-with-proxy-hint that the most common field failure (a
 * corporate proxy swallowing the connection) actually needs.
 */
function describeFetchError(e: unknown, timeoutMs: number): string {
  if (e instanceof ResponseTooLarge) {
    return `response larger than ${MAX_RESPONSE_BYTES / (1024 * 1024)} MB — not read`;
  }
  if (!(e instanceof Error)) return String(e);
  if (e.name === "AbortError") {
    const secs = Math.round(timeoutMs / 1000);
    return `timed out after ${secs}s — endpoint unreachable. If you're behind a corporate proxy, set HTTPS_PROXY (see README).`;
  }
  const cause = (e as { cause?: unknown }).cause;
  const detail =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : (cause as { code?: string } | undefined)?.code;
  return detail ? `${e.message} (${detail})` : e.message;
}
