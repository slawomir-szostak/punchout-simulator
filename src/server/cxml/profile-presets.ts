import type { Profile } from "./types.js";

// Built-in procurement-platform profiles. These are the source of truth for both
// the rows seeded into config.json on first run AND the in-memory fallback used
// when a buyer has no profile (or its profile row is missing). Keeping them here
// in one place avoids the seeded copy and the fallback drifting apart.
//
// The per-document-type DTD versions, UserAgent strings and transports below are
// realistic but representative — useful to exercise each code path, not a
// guarantee that a given live tenant pins exactly these versions. The "Generic"
// profile reproduces the tool's historical hardcoded behavior.

export type ProfilePreset = Omit<Profile, "createdAt" | "updatedAt">;

export const PROFILE_PRESETS: ProfilePreset[] = [
  {
    id: "generic",
    name: "Generic cXML",
    platform: "Generic",
    builtin: true,
    dtdVersions: { default: "1.2.045" },
    userAgent: "punchout-simulator",
    setupOperation: "create",
    attachmentEncoding: "binary",
    cartReturnTransport: "cxml-urlencoded",
    extrinsics: [],
    addressMode: "full",
    shipToInSetup: false,
    contactInSetup: false,
  },
  {
    id: "ariba",
    name: "SAP Ariba",
    platform: "Ariba",
    builtin: true,
    dtdVersions: { default: "1.2.045", PunchOutOrderMessage: "1.2.045" },
    userAgent: "Ariba Network/1.0",
    setupOperation: "create",
    attachmentEncoding: "base64",
    cartReturnTransport: "cxml-urlencoded",
    extrinsics: [{ name: "User", value: "${buyerCookie}", scope: "setup" }],
    // Ariba sends ShipTo (addressID + postal) already in the SetupRequest so the
    // supplier can return ship-to-specific pricing/availability.
    addressMode: "both",
    shipToInSetup: true,
    contactInSetup: false,
  },
  {
    id: "coupa",
    name: "Coupa",
    platform: "Coupa",
    builtin: true,
    // Coupa publishes specific DTD versions per document type.
    dtdVersions: { default: "1.2.014", PunchOutOrderMessage: "1.2.023" },
    userAgent: "Coupa Procurement",
    setupOperation: "create",
    attachmentEncoding: "base64",
    cartReturnTransport: "cxml-urlencoded",
    extrinsics: [],
    addressMode: "both",
    shipToInSetup: false,
    contactInSetup: false,
  },
  // Jaggaer (formerly SciQuest) is observed sending TWO different UserAgent
  // strings in the wild — the modern "JAGGAER" and the legacy "SciQuest" — so we
  // ship both presets. They are identical except for name + userAgent, letting
  // you faithfully reproduce whichever tenant you're testing against. DTD 1.2.011
  // is confirmed on real OrderRequests for both; setup requests are assumed to
  // use the same version (set as `default`, easily overridden per document type).
  {
    id: "jaggaer",
    name: "Jaggaer",
    platform: "Jaggaer",
    builtin: true,
    dtdVersions: { default: "1.2.011" },
    userAgent: "JAGGAER",
    setupOperation: "create",
    attachmentEncoding: "binary",
    cartReturnTransport: "cxml-urlencoded",
    extrinsics: [],
    addressMode: "full",
    shipToInSetup: false,
    contactInSetup: false,
  },
  {
    id: "jaggaer-sciquest",
    name: "Jaggaer (SciQuest)",
    platform: "Jaggaer",
    builtin: true,
    dtdVersions: { default: "1.2.011" },
    userAgent: "SciQuest",
    setupOperation: "create",
    attachmentEncoding: "binary",
    cartReturnTransport: "cxml-urlencoded",
    extrinsics: [],
    addressMode: "full",
    shipToInSetup: false,
    contactInSetup: false,
  },
  {
    id: "oracle",
    name: "Oracle iProcurement",
    platform: "Oracle",
    builtin: true,
    dtdVersions: { default: "1.2.008" },
    userAgent: "Oracle iProcurement",
    setupOperation: "create",
    attachmentEncoding: "binary",
    cartReturnTransport: "cxml-urlencoded",
    extrinsics: [],
    addressMode: "full",
    shipToInSetup: false,
    contactInSetup: false,
  },
  {
    id: "sap-srm",
    name: "SAP SRM / Business Network",
    platform: "SAP",
    builtin: true,
    // NOTE: real SAP SRM speaks OCI (form parameters), which this cXML-only tool
    // cannot emit. This profile models the cXML/Business-Network side: base64
    // attachments and a base64 cart return.
    dtdVersions: { default: "1.2.040" },
    userAgent: "SAP Business Network",
    setupOperation: "create",
    attachmentEncoding: "base64",
    cartReturnTransport: "cxml-base64",
    extrinsics: [],
    // SAP is location/plant-code centric — addresses by reference.
    addressMode: "id-only",
    shipToInSetup: false,
    contactInSetup: false,
  },
  {
    id: "workday",
    name: "Workday",
    platform: "Workday",
    builtin: true,
    dtdVersions: { default: "1.2.045" },
    userAgent: "Workday Strategic Sourcing",
    setupOperation: "create",
    attachmentEncoding: "base64",
    cartReturnTransport: "cxml-urlencoded",
    extrinsics: [],
    addressMode: "full",
    shipToInSetup: false,
    contactInSetup: false,
  },
];

/** In-memory Generic profile — the ultimate resolution fallback. */
export const GENERIC_PROFILE: Profile = {
  ...(PROFILE_PRESETS[0] as ProfilePreset),
  createdAt: "",
  updatedAt: "",
};

/** Idempotently insert any missing built-in presets as Profile rows. */
export function seedBuiltinProfiles(
  data: { profiles: Profile[] },
  now: string,
): void {
  for (const preset of PROFILE_PRESETS) {
    if (!data.profiles.some((p) => p.id === preset.id)) {
      data.profiles.push({ ...preset, createdAt: now, updatedAt: now });
    }
  }
}
