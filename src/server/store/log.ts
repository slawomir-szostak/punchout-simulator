import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { nanoid } from "nanoid";
import { bus } from "../bus.js";
import type { LogRecord } from "../cxml/types.js";
import { ensureDirs, sessionFile, sessionsDir } from "./paths.js";

// Request/response log: JSONL, append-only, partitioned per session
// (data/sessions/<sessionId>.jsonl). Appending one line is O(1); the filename
// is the session index. The server is the sole writer, so it emits the SSE
// event the moment it appends. See spec section 7.

export type LogInput = Omit<LogRecord, "id" | "ts"> & Partial<Pick<LogRecord, "id" | "ts">>;

// Never persist or surface the live Sender SharedSecret. The real secret still
// goes on the wire (the body sent to the supplier is independent of what we log);
// only the stored/streamed/displayed copy is masked. Applied centrally so every
// appendLog caller (flow, sim, punchout-return) is covered.
function redactSecrets(body: string | undefined): string {
  if (!body) return body ?? "";
  return body.replace(/(<SharedSecret>)[\s\S]*?(<\/SharedSecret>)/g, "$1***$2");
}

export function appendLog(input: LogInput): LogRecord {
  ensureDirs();
  const record: LogRecord = {
    ...input,
    body: redactSecrets(input.body),
    id: input.id ?? nanoid(12),
    ts: input.ts ?? new Date().toISOString(),
  };
  const line = JSON.stringify(record) + "\n";
  appendFileSync(sessionFile(record.sessionId), line, { encoding: "utf8", mode: 0o600 });
  updateSummaryCache(record, Buffer.byteLength(line));
  bus.emitLog(record);
  return record;
}

export function readSession(sessionId: string): LogRecord[] {
  const file = sessionFile(sessionId);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as LogRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is LogRecord => r !== null);
}

/** Delete a session's append-only log file. Returns true if a file was removed. */
export function deleteSession(sessionId: string): boolean {
  const file = resolve(sessionFile(sessionId));
  // sessionFile() already sanitizes the id; assert containment before a
  // destructive rm so it can never escape the sessions directory (defense in depth).
  if (!file.startsWith(resolve(sessionsDir()) + sep)) return false;
  if (!existsSync(file)) return false;
  rmSync(file);
  summaryCache.delete(sessionId);
  return true;
}

export interface SessionSummary {
  sessionId: string;
  connectionId?: string;
  count: number;
  firstTs?: string;
  lastTs?: string;
  docTypes: string[];
  hasErrors: boolean;
  /** PunchOutSetupRequest @operation for the session (create/edit/inspect), if any. */
  operation?: string;
}

// --- Summary cache -------------------------------------------------------------
//
// The SPA refetches /api/sessions on every SSE log event, so a naive
// listSessions() that re-reads and re-parses every JSONL file is quadratic in
// accumulated log volume. The server is the sole writer (appendLog/deleteSession
// above), so summaries are maintained incrementally at those chokepoints; the
// cached file size doubles as a consistency check, so a file changed by anything
// else (or written before boot) is lazily re-parsed — one stat per file instead
// of a read+parse.

interface CacheEntry {
  summary: SessionSummary;
  /** Size of the .jsonl when the summary was computed; mismatch → re-parse. */
  size: number;
}

const summaryCache = new Map<string, CacheEntry>();
let summaryCacheDir = "";

/** Reset the cache when the sessions dir changes (tests call setDataDir). */
function syncCacheDir(): void {
  const dir = sessionsDir();
  if (summaryCacheDir !== dir) {
    summaryCache.clear();
    summaryCacheDir = dir;
  }
}

const setupOperation = (r: LogRecord): string | undefined =>
  r.docType === "SetupRequest" ? /<PunchOutSetupRequest[^>]*\boperation="([^"]+)"/.exec(r.body)?.[1] : undefined;

function summarize(sessionId: string, records: LogRecord[]): SessionSummary {
  const setup = records.find((r) => r.docType === "SetupRequest");
  return {
    sessionId: records[0].sessionId ?? sessionId,
    connectionId: records[0].connectionId,
    count: records.length,
    firstTs: records[0].ts,
    lastTs: records[records.length - 1].ts,
    docTypes: [...new Set(records.map((r) => r.docType))],
    hasErrors: records.some((r) => r.validation && !r.validation.ok),
    operation: setup ? setupOperation(setup) : undefined,
  };
}

/** Fold one appended record into the cached summary (appendLog chokepoint). */
function updateSummaryCache(record: LogRecord, lineBytes: number): void {
  syncCacheDir();
  const entry = summaryCache.get(record.sessionId);
  if (!entry) return; // cold for this session — next listSessions parses the file
  const s = entry.summary;
  s.count += 1;
  s.lastTs = record.ts;
  if (!s.docTypes.includes(record.docType)) s.docTypes.push(record.docType);
  if (record.validation && !record.validation.ok) s.hasErrors = true;
  s.operation ??= setupOperation(record);
  entry.size += lineBytes;
}

export function listSessions(): SessionSummary[] {
  ensureDirs();
  syncCacheDir();
  const files = readdirSync(sessionsDir()).filter((f) => f.endsWith(".jsonl"));
  const seen = new Set<string>();
  const summaries: SessionSummary[] = [];
  for (const file of files) {
    const sessionId = file.replace(/\.jsonl$/, "");
    seen.add(sessionId);
    const size = statSync(resolve(sessionsDir(), file), { throwIfNoEntry: false })?.size ?? -1;
    let entry = summaryCache.get(sessionId);
    if (!entry || entry.size !== size) {
      const records = readSession(sessionId);
      if (records.length === 0) continue;
      entry = { summary: summarize(sessionId, records), size };
      summaryCache.set(sessionId, entry);
    }
    summaries.push(entry.summary);
  }
  // Drop cache entries whose file disappeared outside deleteSession.
  for (const id of summaryCache.keys()) {
    if (!seen.has(id)) summaryCache.delete(id);
  }
  return summaries.sort((a, b) => (b.lastTs ?? "").localeCompare(a.lastTs ?? ""));
}

export function readAllRecent(limit = 200): LogRecord[] {
  return listSessions()
    .flatMap((s) => readSession(s.sessionId))
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .slice(-limit);
}
