import { Hono } from "hono";
import { readJsonBody } from "./json-body.js";
import {
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  updateProfile,
  type ProfileInput,
} from "../store/config.js";
import { PROFILE_PRESETS } from "../cxml/profile-presets.js";
import type {
  AddressMode,
  AttachmentEncoding,
  CartReturnTransport,
  DtdVersionMap,
  ProfileExtrinsic,
  SetupOperation,
} from "../cxml/types.js";

// CRUD for reusable procurement-platform Profiles, plus a read-only library of
// built-in presets the UI can load into the editor.

export const profilesRoute = new Hono();
export const profilePresetsRoute = new Hono();

const VERSION_KEYS = [
  "SetupRequest",
  "SetupResponse",
  "PunchOutOrderMessage",
  "OrderRequest",
  "OrderResponse",
] as const;

function normalizeDtdVersions(v: any): DtdVersionMap {
  const out: DtdVersionMap = { default: String(v?.default ?? "1.2.045") };
  for (const k of VERSION_KEYS) {
    if (v?.[k]) (out as unknown as Record<string, string>)[k] = String(v[k]);
  }
  return out;
}

function normalizeExtrinsics(v: any): ProfileExtrinsic[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((e: any) => ({
      name: String(e?.name ?? ""),
      value: String(e?.value ?? ""),
      scope: (e?.scope === "order" ? "order" : "setup") as ProfileExtrinsic["scope"],
    }))
    .filter((e) => e.name.trim().length > 0);
}

function normalizeProfile(body: any): ProfileInput {
  const setupOperation: SetupOperation = ["create", "edit", "inspect"].includes(body?.setupOperation)
    ? body.setupOperation
    : "create";
  const attachmentEncoding: AttachmentEncoding = body?.attachmentEncoding === "base64" ? "base64" : "binary";
  const cartReturnTransport: CartReturnTransport = ["cxml-urlencoded", "cxml-base64", "raw"].includes(
    body?.cartReturnTransport,
  )
    ? body.cartReturnTransport
    : "cxml-urlencoded";
  const addressMode: AddressMode = ["id-only", "full", "both"].includes(body?.addressMode)
    ? body.addressMode
    : "full";
  return {
    name: String(body?.name ?? "Untitled profile"),
    platform: body?.platform ? String(body.platform) : undefined,
    dtdVersions: normalizeDtdVersions(body?.dtdVersions),
    userAgent: String(body?.userAgent ?? "punchout-simulator"),
    setupOperation,
    attachmentEncoding,
    cartReturnTransport,
    extrinsics: normalizeExtrinsics(body?.extrinsics),
    addressMode,
    shipToInSetup: Boolean(body?.shipToInSetup),
    contactInSetup: Boolean(body?.contactInSetup),
    // `builtin` is never set from the wire — only code-seeded presets carry it.
  };
}

profilesRoute.get("/", (c) => c.json(listProfiles()));
profilesRoute.post("/", async (c) => {
  const input = normalizeProfile(await readJsonBody(c));
  if (!input.name.trim()) return c.json({ errors: ["name is required"] }, 400);
  return c.json(await createProfile(input), 201);
});
profilesRoute.get("/:id", (c) => {
  const p = getProfile(c.req.param("id"));
  return p ? c.json(p) : c.json({ error: "not found" }, 404);
});
profilesRoute.put("/:id", async (c) => {
  if (!getProfile(c.req.param("id"))) return c.json({ error: "not found" }, 404);
  const input = normalizeProfile(await readJsonBody(c));
  return c.json(await updateProfile(c.req.param("id"), input));
});
profilesRoute.delete("/:id", async (c) => {
  try {
    const ok = await deleteProfile(c.req.param("id"));
    return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
});

// Read-only built-in preset library (Ariba/Coupa/Jaggaer/...). The UI loads one
// of these to pre-fill the profile editor for a new (editable) profile.
profilePresetsRoute.get("/", (c) => c.json(PROFILE_PRESETS));
