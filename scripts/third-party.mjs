#!/usr/bin/env node
// Runs after the server build. The server bundle inlines every runtime package
// (tsup noExternal), so the published package has no dependencies. This reads
// the bundler's metafile to see exactly which packages ended up inside and
//
//   - fails the build if the bundle still imports anything but Node built-ins,
//   - writes dist/THIRD-PARTY-LICENSES.txt: each package, its version and its
//     licence text (their licences require the notice to travel with the code),
//   - writes dist/bundled-packages.json, the list CI audits for advisories.
//
// `--list` prints the package names only.
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const metaPath = join(root, "dist/server/metafile-esm.json");
const meta = JSON.parse(readFileSync(metaPath, "utf8"));

const builtins = new Set(builtinModules);
const external = new Set();
for (const out of Object.values(meta.outputs)) {
  for (const imp of out.imports ?? []) {
    if (!imp.external) continue;
    const name = imp.path.replace(/^node:/, "");
    if (!builtins.has(name) && !builtins.has(name.split("/")[0])) external.add(imp.path);
  }
}
if (external.size > 0) {
  console.error(`The server bundle still imports packages it should contain: ${[...external].join(", ")}`);
  process.exit(1);
}

// node_modules/a/node_modules/@scope/b/index.js -> the innermost package directory.
const dirs = new Set();
for (const input of Object.keys(meta.inputs)) {
  const at = input.lastIndexOf("node_modules/");
  if (at < 0) continue;
  const rest = input.slice(at + "node_modules/".length).split("/");
  const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  dirs.add(join(root, input.slice(0, at), "node_modules", name));
}

const packages = [...dirs]
  .map((dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const file = readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.|$)/i.test(f));
    return {
      name: pkg.name,
      version: pkg.version,
      license: typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? "UNKNOWN"),
      homepage: pkg.homepage ?? (typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url) ?? "",
      text: file ? readFileSync(join(dir, file), "utf8").trim() : "",
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

if (process.argv.includes("--list")) {
  console.log([...new Set(packages.map((p) => p.name))].join("\n"));
  process.exit(0);
}

const missing = packages.filter((p) => !p.text && !/^(MIT|ISC|BSD|Apache|0BSD|Unlicense)/i.test(p.license));
if (missing.length > 0) {
  console.error(`No licence text and no recognised licence for: ${missing.map((p) => p.name).join(", ")}`);
  process.exit(1);
}

const rule = "=".repeat(78);
const notices = [
  "punchout-simulator has no runtime dependencies: the packages below are",
  "built into dist/server/cli.js. Each is listed with the version that was",
  "built in and the licence it is distributed under.",
  "",
  ...packages.map((p) => `  ${p.name}@${p.version}  (${p.license})`),
  "",
  ...packages.flatMap((p) => [
    rule,
    `${p.name}@${p.version}  —  ${p.license}`,
    p.homepage,
    rule,
    "",
    p.text || `Licensed under ${p.license}. The package ships no separate licence file.`,
    "",
  ]),
].join("\n");

writeFileSync(join(root, "dist/THIRD-PARTY-LICENSES.txt"), notices);
writeFileSync(
  join(root, "dist/bundled-packages.json"),
  `${JSON.stringify(packages.map(({ name, version, license }) => ({ name, version, license })), null, 2)}\n`,
);
// The metafile has done its job; it does not belong in the published package.
if (existsSync(metaPath)) rmSync(metaPath);
console.log(`third-party: ${packages.length} packages built in — dist/THIRD-PARTY-LICENSES.txt`);
