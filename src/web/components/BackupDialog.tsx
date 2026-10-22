import { useRef, useState } from "react";
import { api } from "../api";
import { useModalFocus } from "../hooks/useModalFocus";
import { ConfirmButton } from "./PartyEditors";
import type { ConfigImportSummary } from "../types";

const COLLECTIONS = [
  ["buyers", "buyer"],
  ["suppliers", "supplier"],
  ["connections", "connection"],
  ["profiles", "profile"],
  ["productLists", "product list"],
] as const;

type Counts = Record<(typeof COLLECTIONS)[number][0], number>;

const describe = (counts: Partial<Counts>) =>
  COLLECTIONS.filter(([k]) => counts[k] != null)
    .map(([k, label]) => `${counts[k]} ${label}${counts[k] === 1 ? "" : "s"}`)
    .join(", ");

// Modal for exporting the whole configuration to a JSON file and importing one
// back (merge by id, or replace everything). Sessions/logs are not included.
// The file is parsed client-side first so the user sees what it holds before
// anything is written; the server re-validates and migrates it.
export function BackupDialog({ onClose, onImported }: { onClose: () => void; onImported: () => Promise<void> }) {
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [file, setFile] = useState<{ name: string; data: unknown; counts: Partial<Counts>; exportedAt?: string } | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ConfigImportSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useModalFocus(ref, onClose);

  const pick = (f: File) => {
    setError("");
    setResult(null);
    setFile(null);
    f.text().then((text) => {
      try {
        const data = JSON.parse(text);
        const counts: Partial<Counts> = {};
        for (const [k] of COLLECTIONS) if (Array.isArray(data?.[k])) counts[k] = data[k].length;
        if (Object.keys(counts).length === 0) throw new Error("This doesn't look like a punchout-simulator config export.");
        setFile({ name: f.name, data, counts, exportedAt: typeof data.exportedAt === "string" ? data.exportedAt : undefined });
      } catch (e) {
        setError(e instanceof SyntaxError ? "The file is not valid JSON." : e instanceof Error ? e.message : String(e));
      }
    });
  };

  const runImport = async () => {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const summary = await api.importConfig(file.data, mode);
      setResult(summary);
      setFile(null);
      await onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal backup-dialog" role="dialog" aria-modal="true" aria-label="Export / import configuration" tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div><strong>Export / import configuration</strong></div>
          <button className="btn-link" onClick={onClose}>close ✕</button>
        </div>
        <p className="hint">Buyers, suppliers, connections, buyer profiles and product lists, as one JSON file. Sessions and logs are not included.</p>

        <div className="editor-form">
          <fieldset>
            <legend>Export</legend>
            <label className="check-row">
              <input type="checkbox" checked={includeSecrets} onChange={(e) => setIncludeSecrets(e.target.checked)} />
              <span>
                Include shared secrets
                <span className="hint"> — stored in the file as plain text; leave off for a file you'll share</span>
              </span>
            </label>
            <div className="form-actions">
              <a className="btn-primary" href={api.configExportUrl(includeSecrets)} download>Download config</a>
            </div>
          </fieldset>

          <fieldset>
            <legend>Import</legend>
            <label className="check-row">
              <input type="radio" name="import-mode" checked={mode === "merge"} onChange={() => setMode("merge")} />
              <span>
                Merge
                <span className="hint"> — add the file's entries; ones with the same id are overwritten, the rest is kept</span>
              </span>
            </label>
            <label className="check-row">
              <input type="radio" name="import-mode" checked={mode === "replace"} onChange={() => setMode("replace")} />
              <span>
                Replace
                <span className="hint"> — discard the current configuration and use the file's</span>
              </span>
            </label>
            <p className="hint">A blank shared secret in the file keeps the one already stored for that connection.</p>

            <div className="form-actions">
              <button type="button" className="btn-secondary" onClick={() => fileRef.current?.click()}>Choose file…</button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) pick(f);
                e.target.value = ""; // allow re-picking the same file
              }}
            />

            {file && (
              <>
                <p className="hint">
                  <strong>{file.name}</strong>
                  {file.exportedAt && <> · exported {new Date(file.exportedAt).toLocaleString()}</>}
                  <br />
                  {describe(file.counts)}
                </p>
                <div className="form-actions">
                  {mode === "merge" ? (
                    <button className="btn-primary" onClick={runImport} disabled={busy}>Merge into current config</button>
                  ) : (
                    <ConfirmButton label="Replace current config" confirmLabel="Confirm replace?" onConfirm={runImport} onError={setError} />
                  )}
                  <button className="btn-secondary" onClick={() => setFile(null)} disabled={busy}>Cancel</button>
                </div>
              </>
            )}
            {result && (
              <p className="hint" role="status">
                {result.mode === "merge" ? "Merged" : "Replaced with"} {describe(result.imported)}. Now: {describe(result.total)}.
                {result.withoutSecret > 0 && (
                  <span className="warn-hint"> {result.withoutSecret} connection{result.withoutSecret === 1 ? " has" : "s have"} no shared secret — set {result.withoutSecret === 1 ? "it" : "them"} in Connections.</span>
                )}
              </p>
            )}
            {error && <p className="form-error" role="alert">{error}</p>}
          </fieldset>
        </div>
      </div>
    </div>
  );
}
