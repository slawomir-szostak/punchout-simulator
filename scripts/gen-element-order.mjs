#!/usr/bin/env node
// Regenerates src/server/cxml/element-order.ts from the cXML DTD.
//
//   node scripts/gen-element-order.mjs <dir with <version>/cXML.dtd> [version]
//
// The DTD fixes the order of an element's children. This reads every content
// model of the newest DTD and writes, per element, the order its children must
// appear in. It then replays the older DTDs against that table and reports any
// pair of children whose order an older version does not require the same way,
// so the table never asks more of a document than its own DTD does: such
// children are left out.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, wanted] = process.argv.slice(2);
if (!dir) {
  console.error("usage: gen-element-order.mjs <dtd dir> [version]");
  process.exit(1);
}
const byVersion = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const versions = readdirSync(dir).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort(byVersion);
const newest = wanted ?? versions[versions.length - 1];

/** Content models of a DTD, with comments removed and parameter entities expanded. */
function contentModels(file) {
  const dtd = readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const entities = new Map();
  for (const m of dtd.matchAll(/<!ENTITY\s+%\s+([\w.:-]+)\s+(["'])([\s\S]*?)\2\s*>/g)) {
    if (!entities.has(m[1])) entities.set(m[1], m[3]);
  }
  const expand = (s, depth = 0) =>
    depth > 20 ? s : s.replace(/%([\w.:-]+);/g, (_, n) => (entities.has(n) ? expand(entities.get(n), depth + 1) : ""));
  const models = new Map();
  for (const m of dtd.matchAll(/<!ELEMENT\s+([\w.:-]+)\s+([\s\S]*?)>/g)) {
    models.set(m[1], expand(m[2]).replace(/\s+/g, ""));
  }
  return models;
}

/** Parses "(A,(B|C)*,D?)" into a tree of seq / choice / name nodes. */
function parseModel(src) {
  let i = 0;
  const occurrence = () => ("?*+".includes(src[i] ?? "\0") ? src[i++] : "");
  function group() {
    i++; // (
    const items = [];
    let kind = "seq";
    for (;;) {
      if (src[i] === "(") items.push(group());
      else {
        const m = /^[#\w.:-]+/.exec(src.slice(i));
        if (!m) throw new Error(`cannot parse "${src}" at ${i}`);
        i += m[0].length;
        items.push({ kind: "name", name: m[0], occ: occurrence() });
      }
      if (src[i] === ",") i++;
      else if (src[i] === "|") {
        kind = "choice";
        i++;
      } else if (src[i] === ")") {
        i++;
        return { kind, items, occ: occurrence() };
      } else throw new Error(`cannot parse "${src}" at ${i}`);
    }
  }
  return group();
}

/**
 * Child name -> rank. Children of a sequence get rising ranks; the branches of
 * a choice start from the same rank (only one of them occurs); everything in a
 * repeating group shares one rank, because its members may interleave. A name
 * the model places at two different ranks cannot be ranked and is dropped.
 */
function ranks(model) {
  if (!model.startsWith("(") || model.includes("#PCDATA")) return null;
  const rank = new Map();
  const dropped = new Set();
  const put = (name, r) => {
    if (rank.has(name) && rank.get(name) !== r) dropped.add(name);
    rank.set(name, r);
  };
  // Returns the next free rank.
  function walk(node, at, flat) {
    if (node.kind === "name") {
      put(node.name, at);
      return at + 1;
    }
    const repeats = flat || node.occ === "*" || node.occ === "+";
    if (repeats) {
      for (const it of node.items) walk(it, at, true);
      return at + 1;
    }
    if (node.kind === "choice") return Math.max(...node.items.map((it) => walk(it, at, false)));
    let next = at;
    for (const it of node.items) next = walk(it, next, false);
    return next;
  }
  walk(parseModel(model), 0, false);
  for (const d of dropped) rank.delete(d);
  return rank;
}

function table(version) {
  const out = new Map();
  for (const [element, model] of contentModels(join(dir, version, "cXML.dtd"))) {
    const r = ranks(model);
    if (r && new Set(r.values()).size > 1) out.set(element, r);
  }
  return out;
}

const order = table(newest);

// An older DTD must require every ordered pair the same way, or the pair goes.
let removed = 0;
for (const version of versions.filter((v) => v !== newest)) {
  const older = table(version);
  const olderModels = contentModels(join(dir, version, "cXML.dtd"));
  for (const [element, rank] of order) {
    if (!olderModels.has(element)) continue;
    const old = older.get(element) ?? new Map();
    const oldChildren = olderModels.get(element);
    for (const a of [...rank.keys()]) {
      for (const b of [...rank.keys()]) {
        if (!rank.has(a) || !rank.has(b) || rank.get(a) >= rank.get(b)) continue;
        const known = (n) => new RegExp(`[(,|]${n}[),|?*+]`).test(oldChildren);
        if (!known(a) || !known(b)) continue;
        if (old.has(a) && old.has(b) && old.get(a) < old.get(b)) continue;
        console.error(`${element}: ${a} before ${b} is not required by ${version} — dropping ${b}`);
        rank.delete(b);
        removed++;
      }
    }
  }
}

const lines = [];
for (const [element, rank] of [...order].sort(([a], [b]) => a.localeCompare(b))) {
  const groups = new Map();
  for (const [name, r] of rank) groups.set(r, [...(groups.get(r) ?? []), name]);
  if (groups.size < 2) continue;
  const text = [...groups].sort(([a], [b]) => a - b).map(([, names]) => names.join("|")).join(",");
  lines.push(`  ${JSON.stringify(element)}: ${JSON.stringify(text)},`);
}

const file = `// GENERATED by scripts/gen-element-order.mjs from the cXML ${newest} DTD — do not edit.
//
// The order the DTD fixes for an element's children: groups separated by ","
// must appear in that order; names joined by "|" share a position (a choice, or
// members of a repeating group). Children the DTD does not rank are absent, as
// are pairs an older DTD (${versions[0]} onwards) does not order the same way.
export const ELEMENT_ORDER_DTD = ${JSON.stringify(newest)};

export const ELEMENT_ORDER: Record<string, string> = {
${lines.join("\n")}
};
`;
writeFileSync(new URL("../src/server/cxml/element-order.ts", import.meta.url), file);
console.error(`${lines.length} elements from cXML ${newest}; ${removed} pair(s) dropped for older DTDs`);
