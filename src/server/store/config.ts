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
  db.data.buyers ||= [];
  db.data.suppliers ||= [];
  db.data.connections ||= [];
  db.data.profiles ||= [];
  db.data.productLists ||= [];

  // Refuse to open data written by a newer build: an old binary rewriting a
  // newer file would silently drop the fields it doesn't know about.
  const stored = db.data.schemaVersion ?? 0;
  if (stored > SCHEMA_VERSION) {
    throw new Error(
      `config.json uses schema v${stored}, but this punchout-simulator build supports up to v${SCHEMA_VERSION} — ` +
        `upgrade the tool, or point --data-dir at data written by this version`,
    );
  }

  // Ensure the built-in platform presets and the sample product list exist
  // (Generic is the resolution fallback). Idempotent — inserts missing ids only.
  // Seeds run before migrations: migrateProfiles refreshes the seeded Jaggaer row.
  seedBuiltinProfiles(db.data, now());
  seedBuiltinProductLists(db.data, now());

  for (const m of MIGRATIONS) {
    if (stored < m.to) m.run(db.data);
  }
  db.data.schemaVersion = SCHEMA_VERSION;
  await persist(db);
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
