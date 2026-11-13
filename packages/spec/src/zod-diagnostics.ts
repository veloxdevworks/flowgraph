import type { ZodIssue } from "zod";
import { GraphSpecSchema, NodeSpecSchema, type Diagnostic } from "./schema.js";

/** Levenshtein edit distance between two strings. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** The closest known key within edit distance 2, if any. */
export function suggestKey(unknown: string, known: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDist = 3;
  for (const k of known) {
    const d = editDistance(unknown, k);
    // A distance that rewrites the whole key is not a typo.
    if (d <= 2 && d < k.length && d < bestDist) {
      best = k;
      bestDist = d;
    }
  }
  return best;
}

type Scope =
  | { kind: "graph"; prefix: string; owner?: string }
  | { kind: "node"; prefix: string; id: string };

/** Walk `path` through `data`; return the graph/node object it ends on, or undefined for any other location. */
function scopeFor(path: (string | number)[], data: unknown): Scope | undefined {
  let scope: Scope = { kind: "graph", prefix: "" };
  let cur: unknown = data;
  let i = 0;
  while (i < path.length) {
    const seg = path[i]!;
    if (scope.kind === "graph" && seg === "nodes" && typeof path[i + 1] === "number") {
      const nodes = (cur as { nodes?: unknown } | null)?.nodes;
      const node = Array.isArray(nodes) ? nodes[path[i + 1] as number] : undefined;
      const rawId = (node as { id?: unknown } | null)?.id;
      const id = typeof rawId === "string" ? rawId : `[${path[i + 1]}]`;
      scope = { kind: "node", prefix: `${scope.prefix}${scope.prefix ? "." : ""}nodes.${id}`, id };
      cur = node;
      i += 2;
    } else if (scope.kind === "node" && seg === "spec") {
      scope = { kind: "graph", prefix: `${scope.prefix}.spec`, owner: scope.id };
      cur = (cur as { spec?: unknown } | null)?.spec;
      i += 1;
    } else {
      return undefined;
    }
  }
  return scope;
}

/**
 * Turn zod issues from parsing a GraphSpec into diagnostics. Unknown keys on the
 * graph, on a node, or on an inline subgraph `spec` become one `UNKNOWN_FIELD`
 * diagnostic per key; every other issue stays a `SCHEMA_ERROR`.
 */
export function diagnosticsFromZodIssues(issues: readonly ZodIssue[], data: unknown): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const issue of issues) {
    const scope = issue.code === "unrecognized_keys" ? scopeFor(issue.path, data) : undefined;
    if (issue.code === "unrecognized_keys" && scope) {
      const known = Object.keys(scope.kind === "node" ? NodeSpecSchema.shape : GraphSpecSchema.shape);
      const where =
        scope.kind === "node"
          ? `on node "${scope.id}"`
          : scope.owner
            ? `on the inline spec of node "${scope.owner}"`
            : "on the graph";
      for (const key of issue.keys) {
        const hint = suggestKey(key, known);
        out.push({
          severity: "error",
          code: "UNKNOWN_FIELD",
          message:
            `Unknown field "${key}" ${where}.` +
            (hint ? ` Did you mean "${hint}"?` : "") +
            " If this graph was written for a newer flowgraph, upgrade flowgraph.",
          path: `${scope.prefix}${scope.prefix ? "." : ""}${key}`,
        });
      }
      continue;
    }
    out.push({
      severity: "error",
      code: "SCHEMA_ERROR",
      message: `${issue.path.join(".")}: ${issue.message}`,
      path: issue.path.join("."),
    });
  }
  return out;
}
