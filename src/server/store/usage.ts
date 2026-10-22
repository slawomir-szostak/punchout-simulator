import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { attachmentsDir, sessionsDir } from "./paths.js";

// Disk budget for what the open inbound surface (/sim, /punchout) can make us
// write: session logs + attachments. Those endpoints are unauthenticated by
// design, and on a plain localhost run any web page in the user's browser can
// blind-POST to them, so without a cap a flood fills the disk. The total is
// measured once (lazily) and then tracked incrementally by the writers.

const MB = 1024 * 1024;
export const DEFAULT_MAX_DATA_MB = 2048;

let maxBytes = DEFAULT_MAX_DATA_MB * MB;
let usedBytes: number | null = null; // null = not measured yet

export function setMaxDataMb(mb: number): void {
  maxBytes = mb * MB;
}

export function getMaxDataMb(): number {
  return Math.round(maxBytes / MB);
}

/** Forget the measured total (the data dir changed). */
export function resetUsage(): void {
  usedBytes = null;
}

function dirSize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of readdirSync(dir)) {
    try {
      const st = statSync(resolve(dir, name));
      if (st.isFile()) total += st.size;
    } catch {
      /* raced with a delete */
    }
  }
  return total;
}

export function dataUsageBytes(): number {
  usedBytes ??= dirSize(sessionsDir()) + dirSize(attachmentsDir());
  return usedBytes;
}

export function trackWrite(bytes: number): void {
  if (usedBytes !== null) usedBytes += bytes;
}

export function trackDelete(bytes: number): void {
  if (usedBytes !== null) usedBytes = Math.max(0, usedBytes - bytes);
}

export function overDataBudget(): boolean {
  return dataUsageBytes() >= maxBytes;
}
