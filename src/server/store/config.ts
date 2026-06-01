import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { nanoid } from "nanoid";
import type { Connection } from "../cxml/types.js";
import { configPath, ensureDirs } from "./paths.js";

// Connection configs live in a single config.json via lowdb (a JSON document
// store, not relational) — mutable and tiny. The collection is role-neutral
// (`connections`, each with a `mode`) so Mode B slots in without a rewrite.
// See spec section 7.

interface Schema {
  connections: Connection[];
}

let db: Low<Schema> | null = null;

export async function initConfig(): Promise<void> {
  ensureDirs();
  const adapter = new JSONFile<Schema>(configPath());
  db = new Low<Schema>(adapter, { connections: [] });
  await db.read();
  db.data ||= { connections: [] };
  await db.write();
}

function requireDb(): Low<Schema> {
  if (!db) throw new Error("config store not initialized — call initConfig() first");
  return db;
}

export function listConnections(): Connection[] {
  return requireDb().data.connections;
}

export function getConnection(id: string): Connection | undefined {
  return requireDb().data.connections.find((c) => c.id === id);
}

export type ConnectionInput = Omit<Connection, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<Connection, "id">>;

export async function createConnection(input: ConnectionInput): Promise<Connection> {
  const now = new Date().toISOString();
  const conn: Connection = {
    ...input,
    id: input.id ?? nanoid(8),
    createdAt: now,
    updatedAt: now,
  };
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
  Object.assign(existing, patch, { id, updatedAt: new Date().toISOString() });
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
