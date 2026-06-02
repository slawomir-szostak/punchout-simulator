import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { nanoid } from "nanoid";
import type {
  Buyer,
  Connection,
  Credential,
  ResolvedConnection,
  Supplier,
} from "../cxml/types.js";
import { configPath, ensureDirs } from "./paths.js";

// Connection configs live in a single config.json via lowdb. The model is
// normalized into three collections (spec sections 7 and 14): reusable Buyer
// and Supplier entities, and Connection edges that pair them.

interface Schema {
  buyers: Buyer[];
  suppliers: Supplier[];
  connections: Connection[];
}

let db: Low<Schema> | null = null;

export async function initConfig(): Promise<void> {
  ensureDirs();
  const adapter = new JSONFile<Schema>(configPath());
  db = new Low<Schema>(adapter, { buyers: [], suppliers: [], connections: [] });
  await db.read();
  db.data ||= { buyers: [], suppliers: [], connections: [] };
  db.data.buyers ||= [];
  db.data.suppliers ||= [];
  db.data.connections ||= [];
  migrateLegacy(db.data);
  await db.write();
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
  await d.write();
  return buyer;
}

export async function updateBuyer(id: string, patch: Partial<BuyerInput>): Promise<Buyer | undefined> {
  const d = requireDb();
  const existing = d.data.buyers.find((b) => b.id === id);
  if (!existing) return undefined;
  Object.assign(existing, patch, { id, updatedAt: now() });
  await d.write();
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
  if (removed) await d.write();
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
  await d.write();
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
  await d.write();
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
  if (removed) await d.write();
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
  await d.write();
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
  await d.write();
  return existing;
}

export async function deleteConnection(id: string): Promise<boolean> {
  const d = requireDb();
  const before = d.data.connections.length;
  d.data.connections = d.data.connections.filter((c) => c.id !== id);
  const removed = d.data.connections.length < before;
  if (removed) await d.write();
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
      authStyle: c.authStyle ?? "SharedSecret",
      createdAt: c.createdAt ?? now(),
      updatedAt: now(),
    });
  }
  data.connections = migrated;
}
