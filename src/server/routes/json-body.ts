import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

/**
 * Read a JSON request body, distinguishing "no body" from "broken body".
 *
 * An absent or empty body yields `{}` so callers keep their default-everything
 * behaviour. A body that is present but not valid JSON is a client error and is
 * rejected with 400 — instead of being silently coerced to `{}`, which for this
 * tool could mean building and sending a cXML document the user never asked for.
 */
// Returns `any`: every caller already treats the body as untyped input and
// funnels it through a `normalize(body: any)` coercion step.
export async function readJsonBody(c: Context): Promise<any> {
  const raw = await c.req.text();
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HTTPException(400, { message: "request body is not valid JSON" });
  }
}
