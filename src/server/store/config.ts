import { chmodSync } from "node:fs";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { nanoid } from "nanoid";
import type {
  AddressMode,
  AttachmentEncoding,
  Buyer,
  CartReturnTransport,
  CatalogItem,
  Connection,
  Credential,
  DocType,
  DtdVersionMap,
  Profile,
  ProfileExtrinsic,
  ProductList,
  ResolvedConnection,
  SetupOperation,
  Supplier,
} from "../cxml/types.js";
import { GENERIC_PROFILE, PROFILE_PRESETS, seedBuiltinProfiles } from "../cxml/profile-presets.js";
import { seedBuiltinProductLists } from "../cxml/product-list-presets.js";
import { configPath, ensureDirs } from "./paths.js";

// Connection configs live in a single config.json via lowdb. The model is
// normalized into three collections (spec sections 7 and 14): reusable Buyer
// and Supplier entities, and Connection edges that pair them.

interface Schema {
  /** Version of the persisted shape; bumped by each entry in MIGRATIONS. */
  schemaVersion?: number;
  buyers: Buyer[];
  suppliers: Supplier[];
  connections: Connection[];
  profiles: Profile[];
  productLists: ProductList[];
}

/** The schema version this build reads and writes (== highest MIGRATIONS.to). */
export const SCHEMA_VERSION = 4;

// Ordered, versioned migrations. A stored file at version N gets every
// migration with to > N applied, in order, then is stamped SCHEMA_VERSION.
// Files from before versioning have no schemaVersion and run the full chain
// (every step is also idempotent, matching the historical always-run behavior).
// Add new migrations at the END with to = SCHEMA_VERSION + 1, then bump
// SCHEMA_VERSION — and add a fixture to test/migrations.test.ts.
const MIGRATIONS: Array<{ to: number; run: (data: Schema) => void }> = [
  { to: 1, run: migrateLegacy }, // flat from/to connections → Buyer/Supplier/Connection rows
  { to: 2, run: migrateInlineCatalogs }, // inline Supplier.catalog → standalone ProductList
  { to: 3, run: migrateProfiles }, // address-emission backfill + Jaggaer preset refresh
  { to: 4, run: migrateClassifications }, // item.unspsc → classifications[]
];

const emptySchema = (): Schema => ({ buyers: [], suppliers: [], connections: [], profiles: [], productLists: [] });

let db: Low<Schema> | null = null;

export async function initConfig(): Promise<void> {
  ensureDirs();
  const adapter = new JSONFile<Schema>(configPath());
  db = new Low<Schema>(adapter, emptySchema());
  await db.read();
  db.data ||= emptySchema();
  upgradeSchema(db.data);
  await persist(db);
}

/**
 * Bring a stored (or imported) document up to SCHEMA_VERSION in place: fill
 * missing collections, seed the built-ins, run the pending migrations, stamp it.
 * Throws — before mutating anything — on data written by a newer build.
 */
function upgradeSchema(data: Schema): void {
  // Refuse to open data written by a newer build: an old binary rewriting a
  // newer file would silently drop the fields it doesn't know about.
  const stored = data.schemaVersion ?? 0;
  if (stored > SCHEMA_VERSION) {
    throw new Error(
      `config.json uses schema v${stored}, but this punchout-simulator build supports up to v${SCHEMA_VERSION} — ` +
        `upgrade the tool, or point --data-dir at data written by this version`,
    );
  }
  data.buyers ||= [];
  data.suppliers ||= [];
  data.connections ||= [];
  data.profiles ||= [];
  data.productLists ||= [];

  // Ensure the built-in platform presets and the sample product list exist
  // (Generic is the resolution fallback). Idempotent — inserts missing ids only.
  // Seeds run before migrations: migrateProfiles refreshes the seeded Jaggaer row.
  seedBuiltinProfiles(data, now());
  seedBuiltinProductLists(data, now());

  for (const m of MIGRATIONS) {
    if (stored < m.to) m.run(data);
  }
  data.schemaVersion = SCHEMA_VERSION;
}

// config.json holds the plaintext shared secret — keep it owner-only. lowdb
// writes via temp-file + rename, so the mode must be re-applied after every
// write(), not just once at init.
async function persist(d: Low<Schema>): Promise<void> {
  await d.write();
  try {
    chmodSync(configPath(), 0o600);
  } catch {
    /* best-effort (e.g. Windows) */
  }
}

function requireDb(): Low<Schema> {
  if (!db) throw new Error("config store not initialized — call initConfig() first");
  return db;
}

const now = () => new Date().toISOString();

// --- Buyers ------------------------------------------------------------------

export type BuyerInput = Omit<Buyer, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<Buyer, "id">>;

export const listBuyers = (): Buyer[] => requireDb().data.buyers;
export const getBuyer = (id: string): Buyer | undefined =>
  requireDb().data.buyers.find((b) => b.id === id);

export async function createBuyer(input: BuyerInput): Promise<Buyer> {
  const buyer: Buyer = { ...input, id: input.id ?? nanoid(8), createdAt: now(), updatedAt: now() };
  const d = requireDb();
  d.data.buyers.push(buyer);
  await persist(d);
  return buyer;
}

export async function updateBuyer(id: string, patch: Partial<BuyerInput>): Promise<Buyer | undefined> {
  const d = requireDb();
  const existing = d.data.buyers.find((b) => b.id === id);
  if (!existing) return undefined;
  Object.assign(existing, patch, { id, updatedAt: now() });
  await persist(d);
  return existing;
}

export async function deleteBuyer(id: string): Promise<boolean> {
  const d = requireDb();
  if (d.data.connections.some((c) => c.buyerId === id)) {
    throw new Error("buyer is referenced by a connection");
  }
  const before = d.data.buyers.length;
  d.data.buyers = d.data.buyers.filter((b) => b.id !== id);
  const removed = d.data.buyers.length < before;
  if (removed) await persist(d);
  return removed;
}

// --- Suppliers ---------------------------------------------------------------

export type SupplierInput = Omit<Supplier, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<Supplier, "id">>;

export const listSuppliers = (): Supplier[] => requireDb().data.suppliers;
export const getSupplier = (id: string): Supplier | undefined =>
  requireDb().data.suppliers.find((s) => s.id === id);

export async function createSupplier(input: SupplierInput): Promise<Supplier> {
  const supplier: Supplier = { ...input, id: input.id ?? nanoid(8), createdAt: now(), updatedAt: now() };
  const d = requireDb();
  d.data.suppliers.push(supplier);
  await persist(d);
  return supplier;
}

export async function updateSupplier(
  id: string,
  patch: Partial<SupplierInput>,
): Promise<Supplier | undefined> {
  const d = requireDb();
  const existing = d.data.suppliers.find((s) => s.id === id);
  if (!existing) return undefined;
  Object.assign(existing, patch, { id, updatedAt: now() });
  await persist(d);
  return existing;
}

export async function deleteSupplier(id: string): Promise<boolean> {
  const d = requireDb();
  if (d.data.connections.some((c) => c.supplierId === id)) {
    throw new Error("supplier is referenced by a connection");
  }
  const before = d.data.suppliers.length;
  d.data.suppliers = d.data.suppliers.filter((s) => s.id !== id);
  const removed = d.data.suppliers.length < before;
  if (removed) await persist(d);
  return removed;
}

// --- Connections -------------------------------------------------------------

export type ConnectionInput = Omit<Connection, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<Connection, "id">>;

export const listConnections = (): Connection[] => requireDb().data.connections;
export const getConnection = (id: string): Connection | undefined =>
  requireDb().data.connections.find((c) => c.id === id);

export async function createConnection(input: ConnectionInput): Promise<Connection> {
  const conn: Connection = { ...input, id: input.id ?? nanoid(8), createdAt: now(), updatedAt: now() };
  const d = requireDb();
  d.data.connections.push(conn);
  await persist(d);
  return conn;
}

export async function updateConnection(
  id: string,
  patch: Partial<ConnectionInput>,
): Promise<Connection | undefined> {
  const d = requireDb();
  const existing = d.data.connections.find((c) => c.id === id);
  if (!existing) return undefined;
  Object.assign(existing, patch, { id, updatedAt: now() });
  await persist(d);
  return existing;
}

export async function deleteConnection(id: string): Promise<boolean> {
  const d = requireDb();
  const before = d.data.connections.length;
  d.data.connections = d.data.connections.filter((c) => c.id !== id);
  const removed = d.data.connections.length < before;
  if (removed) await persist(d);
  return removed;
}

/** Resolve a connection together with its buyer and supplier. */
export function resolveConnection(id: string): ResolvedConnection | undefined {
  const connection = getConnection(id);
  if (!connection) return undefined;
  const buyer = getBuyer(connection.buyerId);
  const supplier = getSupplier(connection.supplierId);
  if (!buyer || !supplier) return undefined;
  return { connection, buyer, supplier };
}

/** Find the connection (if any) linking a supplier to a buyer with `from`. */
export function findConnectionBySupplierAndBuyerIdentity(
  supplierId: string,
  from: Credential | undefined,
): ResolvedConnection | undefined {
  const d = requireDb();
  for (const connection of d.data.connections) {
    if (connection.supplierId !== supplierId) continue;
    const buyer = getBuyer(connection.buyerId);
    if (!buyer) continue;
    if (from && buyer.identity.domain === from.domain && buyer.identity.identity === from.identity) {
      const supplier = getSupplier(supplierId);
      if (supplier) return { connection, buyer, supplier };
    }
  }
  return undefined;
}

// --- Profiles ----------------------------------------------------------------

export type ProfileInput = Omit<Profile, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<Profile, "id">>;

export const listProfiles = (): Profile[] => requireDb().data.profiles;
export const getProfile = (id: string): Profile | undefined =>
  requireDb().data.profiles.find((p) => p.id === id);

export async function createProfile(input: ProfileInput): Promise<Profile> {
  const profile: Profile = { ...input, id: input.id ?? nanoid(8), createdAt: now(), updatedAt: now() };
  const d = requireDb();
  d.data.profiles.push(profile);
  await persist(d);
  return profile;
}

export async function updateProfile(id: string, patch: Partial<ProfileInput>): Promise<Profile | undefined> {
  const d = requireDb();
  const existing = d.data.profiles.find((p) => p.id === id);
  if (!existing) return undefined;
  Object.assign(existing, patch, { id, updatedAt: now() });
  await persist(d);
  return existing;
}

export async function deleteProfile(id: string): Promise<boolean> {
  const d = requireDb();
  if (d.data.buyers.some((b) => b.profileId === id)) {
    throw new Error("profile is referenced by a buyer");
  }
  const before = d.data.profiles.length;
  d.data.profiles = d.data.profiles.filter((p) => p.id !== id);
  const removed = d.data.profiles.length < before;
  if (removed) await persist(d);
  return removed;
}

// --- Effective-profile resolution --------------------------------------------
//
// A Profile holds platform DEFAULTS; a Connection's concrete attachmentEncoding
// overrides it per pair (it is always explicit, so it wins). Everything else
// (versions, UserAgent, operation, transport, extrinsics) comes from the buyer's
// profile, falling back to the built-in Generic profile so a buyer with no
// profile behaves exactly as the tool did historically.

export interface EffectiveProfile {
  dtdVersions: DtdVersionMap;
  userAgent: string;
  setupOperation: SetupOperation;
  attachmentEncoding: AttachmentEncoding;
  cartReturnTransport: CartReturnTransport;
  extrinsics: ProfileExtrinsic[];
  addressMode: AddressMode;
  shipToInSetup: boolean;
  contactInSetup: boolean;
}

/** The buyer's profile row, or the in-memory Generic preset if unset/missing. */
export function profileForBuyer(buyer: Buyer): Profile {
  const p = buyer.profileId ? getProfile(buyer.profileId) : undefined;
  return p ?? getProfile("generic") ?? GENERIC_PROFILE;
}

/** Layer a connection's overrides over the buyer's resolved profile. */
export function effectiveProfile(connection: Connection, buyer: Buyer): EffectiveProfile {
  const p = profileForBuyer(buyer);
  return {
    dtdVersions: p.dtdVersions,
    userAgent: p.userAgent,
    setupOperation: p.setupOperation,
    // Connection attachmentEncoding is concrete by construction → explicit override.
    attachmentEncoding: connection.attachmentEncoding ?? p.attachmentEncoding,
    cartReturnTransport: p.cartReturnTransport,
    extrinsics: p.extrinsics,
    addressMode: p.addressMode,
    shipToInSetup: p.shipToInSetup,
    contactInSetup: p.contactInSetup,
  };
}

/** Per-document-type DTD version, falling back to the profile's default. */
export function dtdVersionFor(eff: EffectiveProfile, docType: DocType): string {
  return (eff.dtdVersions as unknown as Record<string, string | undefined>)[docType] ?? eff.dtdVersions.default;
}

// --- Product lists -----------------------------------------------------------

export type ProductListInput = Omit<ProductList, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<ProductList, "id">>;

export const listProductLists = (): ProductList[] => requireDb().data.productLists;
export const getProductList = (id: string): ProductList | undefined =>
  requireDb().data.productLists.find((p) => p.id === id);

export async function createProductList(input: ProductListInput): Promise<ProductList> {
  const list: ProductList = { ...input, id: input.id ?? nanoid(8), createdAt: now(), updatedAt: now() };
  const d = requireDb();
  d.data.productLists.push(list);
  await persist(d);
  return list;
}

export async function updateProductList(
  id: string,
  patch: Partial<ProductListInput>,
): Promise<ProductList | undefined> {
  const d = requireDb();
  const existing = d.data.productLists.find((p) => p.id === id);
  if (!existing) return undefined;
  Object.assign(existing, patch, { id, updatedAt: now() });
  await persist(d);
  return existing;
}

export async function deleteProductList(id: string): Promise<boolean> {
  const d = requireDb();
  if (d.data.suppliers.some((s) => s.productListIds?.includes(id))) {
    throw new Error("product list is referenced by a supplier");
  }
  const before = d.data.productLists.length;
  d.data.productLists = d.data.productLists.filter((p) => p.id !== id);
  const removed = d.data.productLists.length < before;
  if (removed) await persist(d);
  return removed;
}

/**
 * The catalog a supplier serves in Mode B: the union of its referenced product
 * lists' items, in order. Missing list ids are skipped. Returns an empty array
 * when the supplier references no lists (callers fall back to the demo catalog).
 */
export function catalogForSupplier(supplier: Supplier): CatalogItem[] {
  const ids = supplier.productListIds ?? [];
  return ids.flatMap((id) => getProductList(id)?.items ?? []);
}

// --- Export / import ---------------------------------------------------------
//
// A snapshot is the config.json document plus a small envelope. Import accepts
// either a snapshot or a bare config.json, at any schema version this build can
// read (older ones run the migration chain), and validates the whole result
// before touching the live store — a rejected import writes nothing.

export const SNAPSHOT_FORMAT = "punchout-simulator-config";

const COLLECTIONS = ["buyers", "suppliers", "connections", "profiles", "productLists"] as const;

// Ids end up in URL paths (/sim/<supplierId>/…, /api/<collection>/<id>) and in
// server-rendered HTML. The API only ever mints nanoid/preset ids, but an
// imported file could carry anything — e.g. markup that becomes stored XSS on
// the app's own origin — so imports are held to the same safe alphabet (and no
// "." / ".." path segments).
const SAFE_ID = /^(?!\.+$)[A-Za-z0-9._-]{1,64}$/;
type CollectionName = (typeof COLLECTIONS)[number];

export interface ConfigSnapshot extends Schema {
  format: typeof SNAPSHOT_FORMAT;
  exportedAt: string;
  appVersion?: string;
}

export type ImportMode = "merge" | "replace";

export interface ImportSummary {
  mode: ImportMode;
  /** Rows per collection in the imported file (after migration). */
  imported: Record<CollectionName, number>;
  /** Rows per collection in the store after the import. */
  total: Record<CollectionName, number>;
  /** Connections left with no shared secret (e.g. from a secret-less export). */
  withoutSecret: number;
}

/** Thrown for a file that can't be imported; `errors` are user-facing. */
export class ConfigImportError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join("; "));
  }
}

/**
 * Snapshot the live config. Shared secrets are write-only over the API (see
 * routes/connections.ts), so they're blanked unless explicitly asked for.
 */
export function exportConfig(opts: { appVersion?: string; includeSecrets?: boolean } = {}): ConfigSnapshot {
  const data = requireDb().data;
  return {
    format: SNAPSHOT_FORMAT,
    exportedAt: now(),
    appVersion: opts.appVersion,
    schemaVersion: SCHEMA_VERSION,
    ...Object.fromEntries(COLLECTIONS.map((k) => [k, data[k]])),
    connections: opts.includeSecrets ? data.connections : data.connections.map((c) => ({ ...c, sharedSecret: "" })),
  } as ConfigSnapshot;
}

/**
 * Import a snapshot. "replace" swaps the whole config for the file's; "merge"
 * upserts by id — rows in the file overwrite same-id rows, everything else in
 * the store is kept.
 */
export async function importConfig(raw: unknown, mode: ImportMode): Promise<ImportSummary> {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigImportError(["file is not a JSON object"]);
  }
  const input = raw as Record<string, unknown>;
  if (input.format != null && input.format !== SNAPSHOT_FORMAT) {
    throw new ConfigImportError([`unknown format "${String(input.format)}"`]);
  }

  const errors: string[] = [];
  if (!COLLECTIONS.some((k) => k in input)) errors.push("file contains no configuration collections");
  for (const k of COLLECTIONS) {
    const rows = input[k];
    if (rows == null) continue;
    if (!Array.isArray(rows)) {
      errors.push(`${k} must be an array`);
      continue;
    }
    const seen = new Set<string>();
    rows.forEach((row, i) => {
      const id = (row as { id?: unknown } | null)?.id;
      if (row == null || typeof row !== "object" || typeof id !== "string" || id === "") {
        errors.push(`${k}[${i}] has no id`);
      } else if (!SAFE_ID.test(id)) {
        errors.push(`${k}[${i}] has an invalid id (allowed: letters, digits, ".", "_", "-"; up to 64 characters)`);
      } else if (seen.has(id)) {
        errors.push(`${k} has duplicate id "${id}"`);
      } else {
        seen.add(id);
      }
    });
  }
  if (errors.length > 0) throw new ConfigImportError(errors);

  // Work on a copy: migrations mutate in place, and the caller's object (or the
  // live store, on failure) must stay untouched.
  const incoming = structuredClone({
    schemaVersion: typeof input.schemaVersion === "number" ? input.schemaVersion : undefined,
    ...Object.fromEntries(COLLECTIONS.map((k) => [k, input[k] ?? []])),
  }) as Schema;
  const inputIds = Object.fromEntries(
    COLLECTIONS.map((k) => [k, new Set(incoming[k].map((r: { id: string }) => r.id))]),
  ) as Record<CollectionName, Set<string>>;
  try {
    upgradeSchema(incoming);
  } catch (e) {
    throw new ConfigImportError([e instanceof Error ? e.message : String(e)]);
  }

  // upgradeSchema seeds any built-in missing from the file. Those rows aren't
  // the file's content: a merge must not let them reset the store's (possibly
  // edited) built-ins. Rows a migration created have fresh ids and stay.
  const d = requireDb();
  type Row = { id: string };
  const fromFile = (k: CollectionName): Row[] =>
    (incoming[k] as Row[]).filter((r) => inputIds[k].has(r.id) || !(d.data[k] as Row[]).some((x) => x.id === r.id));
  const next: Schema =
    mode === "replace"
      ? incoming
      : ({
          schemaVersion: SCHEMA_VERSION,
          ...Object.fromEntries(COLLECTIONS.map((k) => [k, mergeById(d.data[k] as Row[], fromFile(k))])),
        } as Schema);

  // A blank secret means "unchanged", as on PUT /connections/:id: a secret-less
  // export round-trips without wiping the secrets already stored here. Only
  // while the secret would still go where it went before, though — same parties,
  // same identities, same supplier endpoints — otherwise a file could re-point a
  // connection (or its supplier's URLs) elsewhere and inherit the secret.
  const sameEndpoint = (a?: Supplier, b?: Supplier) =>
    !!a && !!b && JSON.stringify([a.identity, a.punchoutUrl, a.orderUrl]) === JSON.stringify([b.identity, b.punchoutUrl, b.orderUrl]);
  const sameIdentity = (a?: Buyer, b?: Buyer) => !!a && !!b && JSON.stringify(a.identity) === JSON.stringify(b.identity);
  next.connections = next.connections.map((c) => {
    if (c.sharedSecret) return c;
    const stored = d.data.connections.find((x) => x.id === c.id);
    const keep =
      !!stored?.sharedSecret &&
      stored.buyerId === c.buyerId &&
      stored.supplierId === c.supplierId &&
      sameIdentity(d.data.buyers.find((x) => x.id === c.buyerId), next.buyers.find((x) => x.id === c.buyerId)) &&
      sameEndpoint(d.data.suppliers.find((x) => x.id === c.supplierId), next.suppliers.find((x) => x.id === c.supplierId));
    return keep ? { ...c, sharedSecret: stored!.sharedSecret } : c;
  });

  // Referential integrity of the result. A dangling profileId / productListId
  // degrades gracefully at runtime (Generic profile / skipped list), but a
  // connection without both of its parties can't run at all.
  const buyerIds = new Set(next.buyers.map((b) => b.id));
  const supplierIds = new Set(next.suppliers.map((s) => s.id));
  for (const c of next.connections) {
    if (!buyerIds.has(c.buyerId)) errors.push(`connection "${c.name ?? c.id}" references missing buyer "${c.buyerId}"`);
    if (!supplierIds.has(c.supplierId)) {
      errors.push(`connection "${c.name ?? c.id}" references missing supplier "${c.supplierId}"`);
    }
  }
  if (errors.length > 0) throw new ConfigImportError(errors);

  const imported = Object.fromEntries(COLLECTIONS.map((k) => [k, fromFile(k).length])) as ImportSummary["imported"];
  d.data = next;
  await persist(d);
  return {
    mode,
    imported,
    total: Object.fromEntries(COLLECTIONS.map((k) => [k, next[k].length])) as ImportSummary["total"],
    withoutSecret: next.connections.filter((c) => !c.sharedSecret).length,
  };
}

/** Upsert `incoming` rows into `current` by id, keeping `current`'s order. */
function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const byId = new Map(incoming.map((r) => [r.id, r]));
  const merged = current.map((r) => byId.get(r.id) ?? r);
  const existing = new Set(current.map((r) => r.id));
  return [...merged, ...incoming.filter((r) => !existing.has(r.id))];
}

// --- Legacy migration --------------------------------------------------------

/**
 * Convert pre-normalization flat connections (which embedded from/to/sender +
 * punchoutUrl/orderUrl/catalog directly) into Buyer/Supplier/Connection rows.
 * De-duplicates buyers and suppliers by identity.
 */
function migrateLegacy(data: Schema): void {
  const legacy = data.connections.filter((c: any) => "from" in c || "to" in c);
  if (legacy.length === 0) return;

  const buyerKey = (c: Credential) => `${c.domain}|${c.identity}`;
  const findOrAddBuyer = (name: string, identity: Credential): string => {
    const found = data.buyers.find((b) => buyerKey(b.identity) === buyerKey(identity));
    if (found) return found.id;
    const buyer: Buyer = { id: nanoid(8), name, identity, createdAt: now(), updatedAt: now() };
    data.buyers.push(buyer);
    return buyer.id;
  };
  const findOrAddSupplier = (s: Partial<Supplier> & { identity: Credential }): string => {
    const found = data.suppliers.find((x) => buyerKey(x.identity) === buyerKey(s.identity));
    if (found) return found.id;
    const supplier: Supplier = {
      id: nanoid(8),
      name: s.name ?? "Supplier",
      identity: s.identity,
      punchoutUrl: s.punchoutUrl,
      orderUrl: s.orderUrl,
      catalog: s.catalog,
      createdAt: now(),
      updatedAt: now(),
    };
    data.suppliers.push(supplier);
    return supplier.id;
  };

  const migrated: Connection[] = [];
  for (const c of data.connections as any[]) {
    if (!("from" in c) && !("to" in c)) {
      migrated.push(c as Connection);
      continue;
    }
    // For virtual-supplier the tool presents `from`/`sender` as the supplier.
    const isSupplierMode = c.mode === "virtual-supplier";
    const buyerCred: Credential = isSupplierMode ? c.to : c.from;
    const supplierCred: Credential = isSupplierMode ? c.from : c.to;
    const buyerId = findOrAddBuyer(isSupplierMode ? "Buyer" : c.name, buyerCred);
    const supplierId = findOrAddSupplier({
      name: isSupplierMode ? c.name : "Supplier",
      identity: supplierCred,
      punchoutUrl: c.punchoutUrl,
      orderUrl: c.orderUrl,
      catalog: c.catalog,
    });
    migrated.push({
      id: c.id ?? nanoid(8),
      name: c.name ?? "Connection",
      buyerId,
      supplierId,
      mode: c.mode ?? "virtual-buyer",
      sharedSecret: c.sharedSecret ?? "",
      senderIdentity: c.sender,
      deploymentMode: c.deploymentMode ?? "test",
      createdAt: c.createdAt ?? now(),
      updatedAt: now(),
    });
  }
  data.connections = migrated;
}

/**
 * Migrate the old inline `Supplier.catalog` into a standalone Product List the
 * supplier references. Idempotent: only suppliers with a non-empty legacy catalog
 * and no `productListIds` yet are converted; the inline `catalog` is then cleared.
 */
function migrateInlineCatalogs(data: Schema): void {
  for (const supplier of data.suppliers) {
    const legacy = supplier.catalog;
    if (!legacy || legacy.length === 0) {
      delete (supplier as { catalog?: CatalogItem[] }).catalog;
      continue;
    }
    if (supplier.productListIds && supplier.productListIds.length > 0) {
      delete (supplier as { catalog?: CatalogItem[] }).catalog;
      continue;
    }
    const list: ProductList = {
      id: nanoid(8),
      name: `${supplier.name} catalog`,
      items: legacy,
      createdAt: now(),
      updatedAt: now(),
    };
    data.productLists.push(list);
    supplier.productListIds = [list.id];
    delete (supplier as { catalog?: CatalogItem[] }).catalog;
  }
}

/**
 * Backfill address-emission fields (addressMode / shipToInSetup / contactInSetup)
 * on profiles persisted before those fields existed. Built-in rows take their
 * preset values (so e.g. Coupa becomes "both"); others default to full/false.
 * Idempotent — only fills fields that are absent.
 */
function migrateProfiles(data: Schema): void {
  for (const p of data.profiles as any[]) {
    if (p.addressMode != null && p.shipToInSetup != null && p.contactInSetup != null) continue;
    const preset = PROFILE_PRESETS.find((x) => x.id === p.id);
    p.addressMode ??= preset?.addressMode ?? "full";
    p.shipToInSetup ??= preset?.shipToInSetup ?? false;
    p.contactInSetup ??= preset?.contactInSetup ?? false;
  }

  // The built-in Jaggaer profile originally shipped with a placeholder name
  // ("JAGGAER"), UserAgent ("JAGGAER Procurement") and DTD 1.2.021. Real tenants
  // send UserAgent "JAGGAER" (and a legacy "SciQuest" variant, now its own
  // preset) on DTD 1.2.011. Refresh the seeded row to the observed values, but
  // ONLY while it is still the untouched original (don't clobber a user edit).
  // The "jaggaer-sciquest" row is added by seedBuiltinProfiles.
  const jaggaer = (data.profiles as any[]).find((p) => p.id === "jaggaer" && p.builtin);
  if (jaggaer && jaggaer.name === "JAGGAER" && jaggaer.userAgent === "JAGGAER Procurement") {
    jaggaer.name = "Jaggaer";
    jaggaer.userAgent = "JAGGAER";
    if (jaggaer.dtdVersions?.default === "1.2.021") jaggaer.dtdVersions.default = "1.2.011";
  }
}

/**
 * Convert the old single `item.unspsc` string into the `classifications` array.
 * Idempotent: items that already carry `classifications` are left untouched.
 * Runs after inline-catalog migration so generated lists are covered too.
 */
function migrateClassifications(data: Schema): void {
  for (const list of data.productLists) {
    for (const item of list.items as Array<CatalogItem & { unspsc?: string }>) {
      if (!Array.isArray(item.classifications) || item.classifications.length === 0) {
        item.classifications = item.unspsc ? [{ domain: "UNSPSC", value: String(item.unspsc) }] : [];
      }
      delete item.unspsc;
    }
  }
}
