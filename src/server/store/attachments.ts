import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AttachmentRef } from "../cxml/types.js";
import { normalizeContentId } from "../cxml/multipart.js";
import { attachmentsDir, ensureDirs } from "./paths.js";

// Attachments are stored as separate files data/attachments/<hash>, referenced
// from the JSON log record (hash + Content-ID). We never inline base64 into the
// JSONL. See spec section 7.

export function saveAttachment(
  data: Buffer,
  meta: { contentId: string; filename?: string; contentType: string; referenced?: boolean },
): AttachmentRef {
  ensureDirs();
  const hash = createHash("sha256").update(data).digest("hex");
  const path = resolve(attachmentsDir(), hash);
  if (!existsSync(path)) writeFileSync(path, data, { mode: 0o600 });
  return {
    contentId: normalizeContentId(meta.contentId),
    filename: meta.filename,
    contentType: meta.contentType,
    hash,
    size: data.length,
    referenced: meta.referenced,
  };
}

export function readAttachment(hash: string): Buffer | undefined {
  const safe = hash.replace(/[^a-f0-9]/gi, "");
  if (!safe) return undefined;
  const path = resolve(attachmentsDir(), safe);
  if (!existsSync(path)) return undefined;
  return readFileSync(path);
}
