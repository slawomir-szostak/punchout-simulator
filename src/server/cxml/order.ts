import { XMLParser } from "fast-xml-parser";
import { ELEMENT_ORDER } from "./element-order.js";

// The DTD fixes the order of an element's children, and a receiver that
// validates against it rejects a document that has the right elements in the
// wrong order. The object tree the rest of the validator reads has lost that
// order, so this reads the document again, keeping it.
const ordered = new XMLParser({ preserveOrder: true, ignoreAttributes: true, parseTagValue: false });

/** Child name -> position, per parent element. */
const RANKS = new Map<string, Map<string, number>>(
  Object.entries(ELEMENT_ORDER).map(([parent, spec]) => [
    parent,
    new Map(spec.split(",").flatMap((group, i) => group.split("|").map((name) => [name, i] as [string, number]))),
  ]),
);

export interface OrderIssue {
  /** Where the parent is, with an index for repeated elements: cXML/Request/OrderRequest/ItemOut[2] */
  path: string;
  parent: string;
  /** The child that comes too late… */
  child: string;
  /** …and the one it should have come before. */
  before: string;
  /** The children that are present, in the order the DTD wants them. */
  expected: string[];
}

const MAX_ISSUES = 20;

const tagOf = (node: Record<string, unknown>): string | undefined =>
  Object.keys(node).find((k) => k !== ":@" && k !== "#text" && !k.startsWith("?") && !k.startsWith("!"));

/** One issue per element whose children are out of the DTD's order — the first one it finds there. */
export function findOrderIssues(raw: string): OrderIssue[] {
  let tree: unknown;
  try {
    tree = ordered.parse(raw);
  } catch {
    return [];
  }
  const issues: OrderIssue[] = [];

  function visit(nodes: unknown, parent: string, path: string): void {
    if (!Array.isArray(nodes) || issues.length >= MAX_ISSUES) return;
    const children = nodes
      .map((n) => ({ node: n as Record<string, unknown>, tag: tagOf(n as Record<string, unknown>) }))
      .filter((c): c is { node: Record<string, unknown>; tag: string } => c.tag != null);

    const ranks = RANKS.get(parent);
    if (ranks) {
      let latest: { tag: string; rank: number } | undefined;
      for (const { tag } of children) {
        const rank = ranks.get(tag);
        if (rank == null) continue; // not ranked by the DTD, or not a child it knows
        if (latest && rank < latest.rank) {
          const present = [...new Set(children.map((c) => c.tag).filter((t) => ranks.has(t)))];
          present.sort((a, b) => ranks.get(a)! - ranks.get(b)!);
          issues.push({ path, parent, child: tag, before: latest.tag, expected: present });
          break;
        }
        if (!latest || rank > latest.rank) latest = { tag, rank };
      }
    }

    const total = new Map<string, number>();
    for (const { tag } of children) total.set(tag, (total.get(tag) ?? 0) + 1);
    const seen = new Map<string, number>();
    for (const { node, tag } of children) {
      // Extrinsic is declared ANY: what it holds is the sender's own business.
      if (tag === "Extrinsic") continue;
      const n = (seen.get(tag) ?? 0) + 1;
      seen.set(tag, n);
      const step = total.get(tag)! > 1 ? `${tag}[${n}]` : tag;
      visit(node[tag], tag, path ? `${path}/${step}` : step);
    }
  }

  visit(tree, "", "");
  return issues;
}
