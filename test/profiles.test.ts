import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import {
  createBuyer,
  createProfile,
  deleteProfile,
  dtdVersionFor,
  effectiveProfile,
  getProfile,
  initConfig,
  listProfiles,
  profileForBuyer,
} from "../src/server/store/config.js";
import { setDataDir } from "../src/server/store/paths.js";
import type { Buyer, Connection } from "../src/server/cxml/types.js";

// A minimal Connection with overridable behavior fields, for resolution tests.
function conn(over: Partial<Connection> = {}): Connection {
  return {
    id: "c1", name: "c1", buyerId: "b", supplierId: "s", mode: "virtual-buyer",
    sharedSecret: "x", deploymentMode: "test",
    createdAt: "", updatedAt: "", ...over,
  };
}
const buyerWith = (profileId?: string): Buyer => ({
  id: "b", name: "B", identity: { domain: "DUNS", identity: "1" }, profileId, createdAt: "", updatedAt: "",
});

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  setDataDir(mkdtempSync(join(tmpdir(), "pos-profiles-")));
  await initConfig();
  app = createApp({ quiet: true });
});

describe("built-in preset seeding", () => {
  it("seeds the Generic and Coupa presets on init", () => {
    const ids = listProfiles().map((p) => p.id);
    expect(ids).toContain("generic");
    expect(ids).toContain("coupa");
    expect(getProfile("coupa")?.dtdVersions.PunchOutOrderMessage).toBe("1.2.023");
  });
});

describe("profile resolution", () => {
  it("profileForBuyer falls back to Generic when unset or dangling", () => {
    expect(profileForBuyer(buyerWith(undefined)).id).toBe("generic");
    expect(profileForBuyer(buyerWith("does-not-exist")).id).toBe("generic");
    expect(profileForBuyer(buyerWith("coupa")).id).toBe("coupa");
  });

  it("effectiveProfile takes versions/UA from the profile but lets the connection override encoding", () => {
    const eff = effectiveProfile(conn({ attachmentEncoding: "binary" }), buyerWith("coupa"));
    expect(eff.userAgent).toBe("Coupa Procurement");
    expect(eff.attachmentEncoding).toBe("binary"); // connection override wins over Coupa's base64
    expect(dtdVersionFor(eff, "PunchOutOrderMessage")).toBe("1.2.023");
    expect(dtdVersionFor(eff, "OrderRequest")).toBe("1.2.014"); // falls back to default
  });
});

describe("profiles route", () => {
  it("CRUD round-trips a custom profile", async () => {
    const createRes = await app.request("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "My Profile", userAgent: "X", dtdVersions: { default: "1.2.050" } }),
    });
    const created = await createRes.json();
    expect(created.id).toBeTruthy();
    expect(created.dtdVersions.default).toBe("1.2.050");

    const got = await (await app.request(`/api/profiles/${created.id}`)).json();
    expect(got.name).toBe("My Profile");

    const del = await app.request(`/api/profiles/${created.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
  });

  it("exposes the built-in preset library", async () => {
    const presets = await (await app.request("/api/profile-presets")).json();
    expect(presets.map((p: any) => p.id)).toContain("ariba");
  });

  it("blocks deleting a profile referenced by a buyer (409)", async () => {
    const profile = await createProfile({
      name: "Referenced", dtdVersions: { default: "1.2.045" }, userAgent: "x",
      setupOperation: "create", attachmentEncoding: "binary",
      cartReturnTransport: "cxml-urlencoded", extrinsics: [],
    });
    await createBuyer({ name: "Ref Buyer", identity: { domain: "DUNS", identity: "9" }, profileId: profile.id });

    await expect(deleteProfile(profile.id)).rejects.toThrow(/referenced by a buyer/);

    const res = await app.request(`/api/profiles/${profile.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
  });
});
