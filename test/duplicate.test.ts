import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { createSupplier, getConnection, initConfig } from "../src/server/store/config.js";
import { setDataDir } from "../src/server/store/paths.js";
import { setRuntime } from "../src/server/runtime.js";
import { seedDemoIfEmpty } from "../src/server/seed.js";

// Duplicating a connection in the UI creates it with `copySecretFrom`: the
// client never sees the stored secret, so the server copies it — only while the
// supplier is unchanged, since the secret belongs to that supplier's endpoint.

let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  setDataDir(mkdtempSync(join(tmpdir(), "pos-dup-")));
  setRuntime({ port: 0, publicUrl: "http://localhost:0", token: undefined });
  await initConfig();
  await seedDemoIfEmpty(); // connection "demo": demo-buyer → demo-supplier, secret "demo-secret"
  app = createApp({ quiet: true });
});

const create = (body: Record<string, unknown>) =>
  app.request("/api/connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Variant", buyerId: "demo-buyer", supplierId: "demo-supplier", ...body }),
  });

describe("POST /api/connections with copySecretFrom", () => {
  it("copies the source's secret server-side and still masks it in the response", async () => {
    const res = await create({ copySecretFrom: "demo" });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.sharedSecret).toBe("");
    expect(created.hasSharedSecret).toBe(true);
    expect(getConnection(created.id)?.sharedSecret).toBe("demo-secret");
  });

  it("prefers a secret typed into the draft", async () => {
    const created = await (await create({ copySecretFrom: "demo", sharedSecret: "typed" })).json();
    expect(getConnection(created.id)?.sharedSecret).toBe("typed");
  });

  it("refuses to carry the secret to a different supplier", async () => {
    await createSupplier({ id: "other", name: "Other", identity: { domain: "DUNS", identity: "5" } });
    const res = await create({ supplierId: "other", copySecretFrom: "demo" });
    expect(res.status).toBe(400);
    expect((await res.json()).errors[0]).toMatch(/same supplier/);
  });

  it("reports a source that no longer exists", async () => {
    const res = await create({ copySecretFrom: "gone" });
    expect(res.status).toBe(400);
    expect((await res.json()).errors[0]).toMatch(/no longer exists/);
  });
});
