import type { ZodIssue } from "zod";
import { NodeSpecSchema, graphSpecKnownKeys, type Diagnostic } from "./schema.js";
import { suggestKey } from "./suggest.js";

export { editDistance, suggestKey } from "./suggest.js";

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
 * Turn zod issues from parsing a GraphSpec into diagnostics. Unknown keys at any
 * depth become `UNKNOWN_FIELD` diagnostics: one per key on the graph, a node or an
 * inline subgraph `spec`, and one per object (with the zod message) elsewhere.
 * Every other issue stays a `SCHEMA_ERROR`.
 */
export function diagnosticsFromZodIssues(issues: readonly ZodIssue[], data: unknown): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const issue of issues) {
    const scope = issue.code === "unrecognized_keys" ? scopeFor(issue.path, data) : undefined;
    if (issue.code === "unrecognized_keys" && scope) {
      const known = scope.kind === "node" ? Object.keys(NodeSpecSchema.shape) : graphSpecKnownKeys();
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
            (key === "description" && scope.kind !== "node" ? " Use metadata.description." : key === "output" && scope.kind === "node" ? " Put output under with.output." : "") +
            (hint ? ` Did you mean "${hint}"?` : "") +
            (scope.kind === "graph" ? " Data of your own goes under extensions, keyed <vendor>.<name>." : "") +
            " If this graph was written for a newer flowgraph, upgrade flowgraph.",
          path: `${scope.prefix}${scope.prefix ? "." : ""}${key}`,
        });
      }
      continue;
    }
    if (issue.code === "unrecognized_keys") {
      const at = issue.path.join(".");
      out.push({
        severity: "error",
        code: "UNKNOWN_FIELD",
        message: at ? `${at}: ${issue.message}` : issue.message,
        path: issue.keys.length === 1 ? [...issue.path, issue.keys[0]!].join(".") : at,
      });
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
