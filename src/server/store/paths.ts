import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Resolves and owns the data directory layout. The CLI sets this once at boot
// (--data-dir, default ./data). See spec section 7.

let dataDir = resolve(process.cwd(), "data");

export function setDataDir(dir: string): void {
  dataDir = resolve(dir);
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

export function sessionFile(sessionId: string): string {
  // Sanitize so a hostile/odd BuyerCookie cannot escape the sessions dir.
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200) || "unknown";
  return resolve(sessionsDir(), `${safe}.jsonl`);
}

export function ensureDirs(): void {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(sessionsDir(), { recursive: true });
  mkdirSync(attachmentsDir(), { recursive: true });
}
