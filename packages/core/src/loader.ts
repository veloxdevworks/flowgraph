/**
 * Stage 1 of compilation: load a YAML file and return a validated GraphSpec.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { GraphSpecSchema, type GraphSpec, type Diagnostic } from "@veloxdevworks/flowgraph-spec";
import { graphLintDiagnostics } from "./runtime/validate-graph.js";

export async function loadGraph(
  filePath: string,
  opts: { cwd?: string } = {},
): Promise<{ spec: GraphSpec | null; diagnostics: Diagnostic[] }> {
  const cwd = opts.cwd ?? process.cwd();
  const resolved = path.resolve(cwd, filePath);

  let raw: string;
  try {
    raw = await fs.readFile(resolved, "utf-8");
  } catch {
    return {
      spec: null,
      diagnostics: [{ severity: "error", code: "FILE_NOT_FOUND", message: `Cannot read: ${resolved}` }],
    };
  }

  const expanded = expandEnvVars(raw);

  let parsed: unknown;
  try {
    parsed = parseYaml(expanded);
  } catch (err) {
    return {
      spec: null,
      diagnostics: [{ severity: "error", code: "YAML_PARSE_ERROR", message: `YAML parse error: ${String(err)}` }],
    };
  }

  const result = GraphSpecSchema.safeParse(parsed);
  if (!result.success) {
    return {
      spec: null,
      diagnostics: result.error.issues.map((i) => ({
        severity: "error" as const,
        code: "SCHEMA_ERROR",
        message: `${i.path.join(".")}: ${i.message}`,
        path: i.path.join("."),
      })),
    };
  }

  return { spec: result.data, diagnostics: [] };
}

function expandEnvVars(yaml: string): string {
  return yaml.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::-(.*?))?\}/g, (_m, name: string, def: string) => {
    return process.env[name] ?? def ?? "";
  });
}

/** Offline lint — no side effects, no network */
export function validateSpec(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const nodeIds = new Set(spec.nodes.map((n) => n.id));

  // Duplicate ids
  const seen = new Set<string>();
  for (const node of spec.nodes) {
    if (seen.has(node.id)) {
      diagnostics.push({ severity: "error", code: "DUPLICATE_NODE_ID", message: `Duplicate node id: "${node.id}"` });
    }
    seen.add(node.id);
  }

  // Edge references
  for (const edge of spec.edges) {
    const check = (ref: string) => {
      if (ref === "START" || ref === "END") return;
      if (!nodeIds.has(ref)) {
        diagnostics.push({ severity: "error", code: "UNKNOWN_NODE_REF", message: `Edge references unknown node "${ref}"` });
      }
    };
    check(edge.from);
    if ("to" in edge) { const tos = Array.isArray(edge.to) ? edge.to : [edge.to]; for (const t of tos) check(t); }
    if ("branch" in edge) { for (const b of edge.branch) check(b.to); }
  }

  // Must have START edge
  if (!spec.edges.some((e) => e.from === "START")) {
    diagnostics.push({ severity: "error", code: "NO_START_EDGE", message: 'Graph has no edge from "START"' });
  }

  // Unreachable nodes
  const allTargets = new Set<string>();
  for (const edge of spec.edges) {
    if ("to" in edge) { const tos = Array.isArray(edge.to) ? edge.to : [edge.to]; for (const t of tos) allTargets.add(t); }
    if ("branch" in edge) { for (const b of edge.branch) allTargets.add(b.to); }
  }
  for (const node of spec.nodes) {
    if (!allTargets.has(node.id)) {
      diagnostics.push({ severity: "warning", code: "NO_INBOUND_EDGE", message: `Node "${node.id}" has no inbound edges` });
    }
  }

  diagnostics.push(...graphLintDiagnostics(spec));

  return diagnostics;
}
