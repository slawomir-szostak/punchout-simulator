#!/usr/bin/env node
// `npm audit`, narrowed to what reaches users. The published package has no
// dependencies — its runtime packages are built into the server bundle — so
// `npm audit --omit=dev` has nothing to look at. This checks the advisories
// against the packages the build actually inlined (dist/bundled-packages.json,
// written by scripts/third-party.mjs) and fails on moderate or worse. Dev-only
// tooling is left out: it never reaches the published package.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const bundled = new Set(JSON.parse(readFileSync(new URL("../dist/bundled-packages.json", import.meta.url), "utf8")).map((p) => p.name));
const run = spawnSync("npm", ["audit", "--json"], { encoding: "utf8", shell: process.platform === "win32" });
let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  console.error("npm audit did not return JSON:\n" + (run.stderr || run.stdout));
  process.exit(2);
}
if (report.error) {
  console.error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
  process.exit(2);
}
const serious = new Set(["moderate", "high", "critical"]);
const found = Object.values(report.vulnerabilities ?? {}).filter((v) => bundled.has(v.name) && serious.has(v.severity));
if (found.length === 0) {
  console.log(`audit: no moderate+ advisories in the ${bundled.size} packages built into the bundle`);
  process.exit(0);
}
for (const v of found) {
  const titles = v.via.filter((x) => typeof x === "object").map((x) => `${x.title} (${x.url})`);
  console.error(`${v.severity.toUpperCase()}  ${v.name} ${v.range}\n  ${titles.join("\n  ") || `via ${v.via.join(", ")}`}`);
}
process.exit(1);
