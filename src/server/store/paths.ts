import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { resetUsage } from "./usage.js";

// Resolves and owns the data directory layout. The CLI sets this once at boot
// (--data-dir, default ./data). See spec section 7.

let dataDir = resolve(process.cwd(), "data");

export function setDataDir(dir: string): void {
  dataDir = resolve(dir);
  resetUsage();
  ensureDirs();
}

export function getDataDir(): string {
  return dataDir;
}

export function sessionsDir(): string {
  return resolve(dataDir, "sessions");
}

export function attachmentsDir(): string {
  return resolve(dataDir, "attachments");
}

export function configPath(): string {
  return resolve(dataDir, "config.json");
}

// Session ids are BuyerCookies, i.e. text chosen by whoever sends the cXML, so
// they can't be used as file names directly. An id made only of filename-safe
// characters is used as is. Any other id gets a readable sanitized prefix plus
// a hash of the full id after a "~" — a character safe ids never contain — so
// two different ids can never share a file. (Plain sanitizing alone mapped
// "a/b", "a b" and "a_b" to the same log, letting one session write into
// another's.)
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{1,200}$/;

const sanitize = (id: string): string => id.replace(/[^a-zA-Z0-9._-]/g, "_");

/** File name (without extension) holding a session's log. */
export function sessionFileName(sessionId: string): string {
  if (SAFE_SESSION_ID.test(sessionId)) return sessionId;
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  return `${sanitize(sessionId).slice(0, 80)}~${digest}`;
}

export function sessionFile(sessionId: string): string {
  const path = resolve(sessionsDir(), `${sessionFileName(sessionId)}.jsonl`);
  if (SAFE_SESSION_ID.test(sessionId) || existsSync(path)) return path;
  // Logs written before 0.11.10 used the sanitized id alone. Keep using such a
  // file for the session that started it, so existing sessions stay readable.
  const legacy = resolve(sessionsDir(), `${sanitize(sessionId).slice(0, 200) || "unknown"}.jsonl`);
  return firstSessionIdIn(legacy) === sessionId ? legacy : path;
}

/** The sessionId of the first record in a log file, or undefined. */
function firstSessionIdIn(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    // The first line can be megabytes (it holds a cXML body); read it in chunks.
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(64 * 1024);
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) {
      const nl = buf.subarray(0, n).indexOf(0x0a);
      chunks.push(Buffer.from(buf.subarray(0, nl === -1 ? n : nl)));
      if (nl !== -1) break;
    }
    const id = JSON.parse(Buffer.concat(chunks).toString("utf8")).sessionId;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function ensureDirs(): void {
  // 0700: the data dir holds config (with the plaintext shared secret) and logs,
  // so keep it owner-only rather than world-readable (umask-proofed via chmod).
  for (const d of [dataDir, sessionsDir(), attachmentsDir()]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    try {
      chmodSync(d, 0o700);
    } catch {
      /* best-effort (e.g. Windows) */
    }
  }
}
