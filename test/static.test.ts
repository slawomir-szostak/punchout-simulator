import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";

// The SPA is served from an ABSOLUTE webRoot (@hono/node-server joins
// root + request path). A cwd-relative root broke on Windows when the npm
// prefix and the cwd sat on different drives, so absolute must keep working
// regardless of what process.cwd() is.

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  const webRoot = mkdtempSync(join(tmpdir(), "pos-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>pos</title>", "utf8");
  mkdirSync(join(webRoot, "assets"));
  writeFileSync(join(webRoot, "assets", "app.js"), "console.log(1)", "utf8");
  app = createApp({ webRoot, quiet: true });
});

describe("static SPA serving (absolute webRoot)", () => {
  it("serves index.html at /", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>pos</title>");
  });

  it("serves asset files", async () => {
    const res = await app.request("/assets/app.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log(1)");
  });

  it("falls back to index.html for unknown SPA routes", async () => {
    const res = await app.request("/connections/abc");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>pos</title>");
  });

  it("rejects path traversal", async () => {
    const res = await app.request("/../package.json");
    // Either normalized to a miss (SPA fallback) or rejected — never file contents.
    expect(await res.text()).not.toContain('"name"');
  });
});
