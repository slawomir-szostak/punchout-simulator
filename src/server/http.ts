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

export async function sendCxml(
  url: string,
  body: string | Buffer,
  contentType = "text/xml; charset=UTF-8",
  timeoutMs = 30000,
): Promise<CxmlResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: body as any,
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
