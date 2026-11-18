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

describe("Host-header gate (DNS-rebinding defense)", () => {
  it("rejects /api when the Host is neither loopback nor the public URL", async () => {
    const res = await app.request("/api/connections", {
      headers: { host: "evil.example.net", authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  it("allows the configured public-URL host", async () => {
    const res = await app.request("/api/connections", {
      headers: { host: "exposed.example.com", authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("allows a loopback Host", async () => {
    const res = await app.request("/api/connections", {
      headers: { host: "127.0.0.1:8080", authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("leaves the health probe open regardless of Host", async () => {
    const res = await app.request("/api/health", { headers: { host: "evil.example.net" } });
    expect(res.status).toBe(200);
  });

  it("does not gate the inbound buyer surface (/sim) on Host", async () => {
    const res = await app.request("/sim/nope/catalog", { headers: { host: "evil.example.net" } });
    expect(res.status).toBe(404);
  });
});

describe("secrets stay out of logs", () => {
  it("redacts SharedSecret even when the tag carries whitespace or attributes", async () => {
    const { redactSecrets } = await import("../src/server/store/log.js");
    for (const open of ["<SharedSecret>", "<SharedSecret >", '<SharedSecret xml:lang="en">', "<SharedSecret\n>"]) {
      const out = redactSecrets(`<Credential>${open}hunter2</SharedSecret></Credential>`);
      expect(out).not.toContain("hunter2");
      expect(out).toContain("***");
    }
    expect(redactSecrets("<SharedSecretHint>keep</SharedSecretHint>")).toContain("keep");
  });

  it("masks the API token in request log lines", async () => {
    const { redactToken } = await import("../src/server/app.js");
    expect(redactToken("<-- GET /api/stream?token=abc123")).toBe("<-- GET /api/stream?token=***");
    expect(redactToken("--> GET /api/config/export?secrets=1&token=abc123 200 3ms")).toBe(
      "--> GET /api/config/export?secrets=1&token=*** 200 3ms",
    );
    expect(redactToken("<-- GET /sim/demo/catalog?cookie=x")).toBe("<-- GET /sim/demo/catalog?cookie=x");
  });
});

describe("failed token attempts are throttled", () => {
  it("refuses a client after repeated wrong tokens, even with the right one", async () => {
    const fresh = createApp({ quiet: true });
    const from = (token: string) =>
      fresh.request("/api/connections", {
        headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.9" },
      });
    for (let i = 0; i < 30; i++) expect((await from("wrong")).status).toBe(401);
    const blocked = await from(TOKEN);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    // Another client is unaffected, and successes never count against anyone.
    const other = await fresh.request("/api/connections", {
      headers: { authorization: `Bearer ${TOKEN}`, "x-forwarded-for": "203.0.113.10" },
    });
    expect(other.status).toBe(200);
  });

  it("cannot be used by one client to lock out another", async () => {
    const fresh = createApp({ quiet: true });
    // Far more failures than any limit, spread over many (forged) client keys...
    for (let i = 0; i < 400; i++) {
      await fresh.request("/api/connections", {
        headers: { authorization: "Bearer wrong", "x-forwarded-for": `198.51.100.${i % 200}` },
      });
    }
    // ...still leaves an uninvolved client with the right token untouched.
    const res = await fresh.request("/api/connections", {
      headers: { authorization: `Bearer ${TOKEN}`, "x-forwarded-for": "203.0.113.77" },
    });
    expect(res.status).toBe(200);
  });

  it("keys a proxied client by the last X-Forwarded-For hop, not a forged first one", async () => {
    const fresh = createApp({ quiet: true });
    const from = (token: string, xff: string) =>
      fresh.request("/api/connections", { headers: { authorization: `Bearer ${token}`, "x-forwarded-for": xff } });
    // The guesser rotates the hop it controls; the proxy-appended hop stays the same.
    for (let i = 0; i < 30; i++) expect((await from("wrong", `10.0.0.${i}, 203.0.113.50`)).status).toBe(401);
    expect((await from("wrong", "10.9.9.9, 203.0.113.50")).status).toBe(429);
    // Forging the operator's address as the first hop does not lock the operator out.
    expect((await from(TOKEN, "203.0.113.60")).status).toBe(200);
  });

  it("past the overall budget, refuses clients that have failed but not ones that have not", async () => {
    const { authThrottle } = await import("../src/server/rate-limit.js");
    const t = authThrottle({ perClient: 100, globalMax: 3 });
    for (const ip of ["a", "b", "c"]) t.recordFailure(ip);
    expect(t.blockedFor("a")).toBeGreaterThan(0); // has failed → out for this window
    expect(t.blockedFor("operator")).toBe(0); // never failed → unaffected
  });

  it("never resets counters to make room when the client table is full", async () => {
    const { authThrottle } = await import("../src/server/rate-limit.js");
    const t = authThrottle({ perClient: 2, globalMax: 1000, maxClients: 2 });
    t.recordFailure("a");
    t.recordFailure("a");
    t.recordFailure("b");
    t.recordFailure("c"); // table full: not tracked, and nothing is evicted
    expect(t.blockedFor("a")).toBeGreaterThan(0);
    expect(t.blockedFor("c")).toBeGreaterThan(0);
  });

  it("keys IPv6 clients by /64 so rotating addresses does not reset the count", async () => {
    const { throttleKeyFor } = await import("../src/server/rate-limit.js");
    expect(throttleKeyFor("2001:db8:1:2::1")).toBe(throttleKeyFor("2001:0db8:0001:0002:ffff:ffff:ffff:ffff"));
    expect(throttleKeyFor("2001:db8:1:2::1")).not.toBe(throttleKeyFor("2001:db8:1:3::1"));
    expect(throttleKeyFor("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(throttleKeyFor("::ffff:192.0.2.7")).toBe("192.0.2.7");
    expect(throttleKeyFor("192.0.2.7")).toBe("192.0.2.7");
  });

  it("recovers when the window turns", async () => {
    const { authThrottle } = await import("../src/server/rate-limit.js");
    const t = authThrottle({ perClient: 2, windowMs: 30 });
    t.recordFailure("a");
    t.recordFailure("a");
    expect(t.blockedFor("a")).toBeGreaterThan(0);
    expect(t.blockedFor("b")).toBe(0);
    await new Promise((r) => setTimeout(r, 40));
    expect(t.blockedFor("a")).toBe(0);
  });
});
