import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { initConfig } from "../src/server/store/config.js";
import { setDataDir } from "../src/server/store/paths.js";
import { setRuntime } from "../src/server/runtime.js";

// Runs in its own file so the global runtime token does not leak into other
// suites (vitest isolates files). Simulates an "exposed" deployment with a token.
const TOKEN = "test-token-123";
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  setDataDir(mkdtempSync(join(tmpdir(), "pos-sec-")));
  await initConfig();
  setRuntime({ port: 0, publicUrl: "https://exposed.example.com", token: TOKEN });
  app = createApp({ quiet: true });
});

describe("API token gate (exposed deployment)", () => {
  it("rejects /api without the token", async () => {
    const res = await app.request("/api/connections");
    expect(res.status).toBe(401);
  });

  it("accepts a Bearer token", async () => {
    const res = await app.request("/api/connections", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
  });

  it("accepts a ?token= query (for EventSource / links)", async () => {
    const res = await app.request(`/api/connections?token=${TOKEN}`);
    expect(res.status).toBe(200);
  });

  it("leaves the health probe open", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
  });

  it("leaves the inbound buyer surface (/sim) open", async () => {
    // unknown supplier -> 404 from the handler, NOT 401 from the gate
    const res = await app.request("/sim/nope/catalog");
    expect(res.status).toBe(404);
  });

  it("rejects a wrong token", async () => {
    const res = await app.request("/api/connections", { headers: { "x-pos-token": "nope" } });
    expect(res.status).toBe(401);
  });
});
