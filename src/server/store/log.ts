import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
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
  appendFileSync(sessionFile(record.sessionId), JSON.stringify(record) + "\n", "utf8");
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

export interface SessionSummary {
  sessionId: string;
  connectionId?: string;
  count: number;
  firstTs?: string;
  lastTs?: string;
  docTypes: string[];
  hasErrors: boolean;
}

export function listSessions(): SessionSummary[] {
  ensureDirs();
  const files = readdirSync(sessionsDir()).filter((f) => f.endsWith(".jsonl"));
  const summaries: SessionSummary[] = [];
  for (const file of files) {
    const sessionId = file.replace(/\.jsonl$/, "");
    const records = readSession(sessionId);
    if (records.length === 0) continue;
    summaries.push({
      sessionId: records[0].sessionId ?? sessionId,
      connectionId: records[0].connectionId,
      count: records.length,
      firstTs: records[0].ts,
      lastTs: records[records.length - 1].ts,
      docTypes: [...new Set(records.map((r) => r.docType))],
      hasErrors: records.some((r) => r.validation && !r.validation.ok),
    });
  }
  return summaries.sort((a, b) => (b.lastTs ?? "").localeCompare(a.lastTs ?? ""));
}

export function readAllRecent(limit = 200): LogRecord[] {
  return listSessions()
    .flatMap((s) => readSession(s.sessionId))
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .slice(-limit);
}
