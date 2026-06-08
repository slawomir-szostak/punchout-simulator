import type { LogRecord } from "./types";
import { formatXml, looksLikeXml } from "./xml-format";

// Export a session's flow as a print-ready document and hand it to the browser's
// native "Save as PDF". No PDF dependency: we open a self-contained HTML report
// in a new window and trigger print — faithful, offline, and ideal for capturing
// test evidence (every exchanged message with its validation result).

// Letter is the default paper in the US, Canada and a handful of other regions;
// the rest of the world uses A4. We pick from the browser locale's region.
const LETTER_REGIONS = new Set(["US", "CA", "MX", "PH", "CL", "CO", "CR", "DO", "GT", "NI", "PA", "PR", "SV", "VE"]);

export function pageSizeForLocale(locale: string = navigator.language || "en"): "A4" | "Letter" {
  const region = (locale.split("-")[1] || "").toUpperCase();
  return LETTER_REGIONS.has(region) ? "Letter" : "A4";
}

export interface FlowPdfMeta {
  /** Heading, e.g. the connection name. */
  title: string;
  /** Sub-heading, e.g. "Demo Buyer → Demo Supplier". */
  subtitle?: string;
  sessionId: string;
  operation?: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function validationHtml(r: LogRecord): string {
  const v = r.validation;
  if (!v) return "";
  if (v.ok && v.issues.length === 0) {
    return `<p class="val ok">Validation: OK</p>`;
  }
  const items = v.issues
    .map(
      (i) =>
        `<li class="sev-${esc(i.severity)}"><span class="sev">${esc(i.severity)}</span> <code>${esc(i.code)}</code> — ${esc(i.message)}${
          i.path ? ` <span class="path">(${esc(i.path)})</span>` : ""
        }</li>`,
    )
    .join("");
  const label = v.ok ? "Validation: passed (with warnings)" : "Validation: FAILED";
  return `<p class="val ${v.ok ? "warn" : "err"}">${label}</p><ul class="issues">${items}</ul>`;
}

function stepHtml(r: LogRecord, n: number): string {
  const dir = r.direction === "out" ? "OUT ↑" : "IN ↓";
  const body = looksLikeXml(r.body) ? formatXml(r.body) : r.body;
  const meta: string[] = [new Date(r.ts).toLocaleString()];
  if (r.status != null) meta.push(`HTTP ${r.status}`);
  if (r.contentType) meta.push(esc(r.contentType));
  const atts =
    r.attachments && r.attachments.length
      ? `<p class="atts">Attachments: ${r.attachments
          .map((a) => `${esc(a.filename ?? a.contentId)} (${a.size} B)`)
          .join(", ")}</p>`
      : "";
  return `<section class="step">
    <h2><span class="num">${n}</span> <span class="dir dir-${r.direction}">${dir}</span> ${esc(r.docType)}
      ${r.note ? `<span class="note">${esc(r.note)}</span>` : ""}</h2>
    <p class="meta">${meta.join(" · ")}</p>
    ${validationHtml(r)}
    ${atts}
    <pre>${esc(body)}</pre>
  </section>`;
}

export function exportFlowPdf(meta: FlowPdfMeta, records: LogRecord[]): void {
  const size = pageSizeForLocale();
  const generated = new Date().toLocaleString();
  const steps = records.length
    ? records.map((r, i) => stepHtml(r, i + 1)).join("\n")
    : `<p class="empty">No messages have been exchanged in this session yet.</p>`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(meta.title)} — PunchOut flow</title>
<style>
  @page { size: ${size}; margin: 16mm; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #1c2330; margin: 0; }
  header.cover { border-bottom: 2px solid #1b3a6b; padding-bottom: 10px; margin-bottom: 16px; }
  header.cover h1 { font-size: 20px; color: #1b3a6b; margin: 0 0 2px; }
  header.cover .sub { color: #4b5563; font-size: 13px; }
  header.cover .kv { color: #6b7280; font-size: 11px; margin-top: 6px; }
  header.cover .kv code { background: #eef1f5; padding: 1px 4px; border-radius: 3px; }
  .badge { display: inline-block; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 4px; background: #fbe9c7; color: #8a5a00; margin-left: 6px; }
  .step { page-break-inside: avoid; margin: 0 0 16px; }
  .step h2 { font-size: 13px; color: #1b3a6b; margin: 0 0 3px; border-bottom: 1px solid #d3dae6; padding-bottom: 3px; }
  .step .num { display: inline-block; min-width: 18px; height: 18px; line-height: 18px; text-align: center; background: #1b3a6b; color: #fff; border-radius: 50%; font-size: 11px; margin-right: 4px; }
  .dir { font-size: 11px; font-weight: 700; }
  .dir-out { color: #1d6f42; } .dir-in { color: #1b5e9b; }
  .note { background: #fbe9c7; color: #8a5a00; font-size: 10px; padding: 1px 6px; border-radius: 4px; margin-left: 6px; }
  .meta { color: #6b7280; font-size: 11px; margin: 2px 0; }
  .val { font-size: 11px; font-weight: 700; margin: 4px 0 2px; }
  .val.ok { color: #1d6f42; } .val.warn { color: #8a5a00; } .val.err { color: #b1361f; }
  ul.issues { margin: 2px 0 6px; padding-left: 16px; font-size: 11px; }
  ul.issues .sev { font-weight: 700; text-transform: uppercase; font-size: 9px; }
  .sev-error .sev { color: #b1361f; } .sev-warning .sev { color: #8a5a00; } .sev-info .sev { color: #1b5e9b; }
  ul.issues .path { color: #6b7280; }
  .atts { font-size: 11px; color: #4b5563; margin: 2px 0; }
  pre { background: #f6f8fb; border: 1px solid #e1e7f0; border-radius: 5px; padding: 8px 10px; font-size: 9.5px; line-height: 1.4; white-space: pre-wrap; word-wrap: break-word; font-family: "DejaVu Sans Mono", ui-monospace, monospace; }
  .empty { color: #6b7280; font-style: italic; }
  footer { margin-top: 18px; border-top: 1px solid #d3dae6; padding-top: 6px; color: #9aa0a6; font-size: 10px; }
  @media screen { body { max-width: 900px; margin: 24px auto; padding: 0 16px; } }
</style></head>
<body>
  <header class="cover">
    <h1>${esc(meta.title)}${meta.operation && meta.operation !== "create" ? `<span class="badge">${esc(meta.operation)}</span>` : ""}</h1>
    ${meta.subtitle ? `<div class="sub">${esc(meta.subtitle)}</div>` : ""}
    <div class="kv">PunchOut flow · Session (BuyerCookie): <code>${esc(meta.sessionId)}</code> · ${records.length} message(s) · Generated ${esc(generated)}</div>
  </header>
  ${steps}
  <footer>Generated by punchout-simulator · ${size} · ${esc(generated)} · Shared secrets are redacted in captured messages.</footer>
  <script>window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 80); });</script>
</body></html>`;

  const win = window.open("", "_blank");
  if (!win) {
    alert("Pop-up blocked — allow pop-ups for this site, then click Export PDF again.");
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
}
