import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { inboundRateLimit } from "../src/server/rate-limit.js";
import { setRuntime } from "../src/server/runtime.js";

// The open inbound surface (/sim, /punchout) is rate-limited only when the tool
// is exposed (a token is configured). Localhost runs are exempt.

afterEach(() => setRuntime({ token: undefined }));

function appWith(limit: ReturnType<typeof inboundRateLimit>) {
  const app = new Hono();
  app.use("/sim/*", limit);
  app.post("/sim/x/punchout", (c) => c.json({ ok: true }));
  return app;
}

const post = (app: Hono, headers: Record<string, string> = {}) =>
  app.request("/sim/x/punchout", { method: "POST", headers });

describe("inbound rate limit", () => {
  it("does nothing on plain localhost runs (no token)", async () => {
    const app = appWith(inboundRateLimit({ perClient: 1, globalMax: 1 }));
    expect((await post(app)).status).toBe(200);
    expect((await post(app)).status).toBe(200);
  });

  it("caps per-client requests per window when exposed", async () => {
    setRuntime({ token: "t" });
    const app = appWith(inboundRateLimit({ perClient: 2, globalMax: 100 }));
    expect((await post(app)).status).toBe(200);
    expect((await post(app)).status).toBe(200);
    const limited = await post(app);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  it("keys clients by X-Forwarded-For but still enforces the global cap", async () => {
    setRuntime({ token: "t" });
    const app = appWith(inboundRateLimit({ perClient: 2, globalMax: 3 }));
    expect((await post(app, { "x-forwarded-for": "1.1.1.1" })).status).toBe(200);
    expect((await post(app, { "x-forwarded-for": "2.2.2.2" })).status).toBe(200);
    expect((await post(app, { "x-forwarded-for": "3.3.3.3" })).status).toBe(200);
    // Fourth distinct client is under its per-client cap but over the global one.
    expect((await post(app, { "x-forwarded-for": "4.4.4.4" })).status).toBe(429);
  });

  it("resets counters after the window elapses", async () => {
    setRuntime({ token: "t" });
    const app = appWith(inboundRateLimit({ perClient: 1, globalMax: 100, windowMs: 30 }));
    expect((await post(app)).status).toBe(200);
    expect((await post(app)).status).toBe(429);
    await new Promise((r) => setTimeout(r, 40));
    expect((await post(app)).status).toBe(200);
  });
});
