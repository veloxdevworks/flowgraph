/**
 * Stage 1 of compilation: load a YAML file and return a validated GraphSpec.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { GraphSpecSchema, diagnosticsFromZodIssues, type GraphSpec, type Diagnostic } from "@flowgraph/spec";
import {
  envExpansionCollisionDiagnostics,
  LOAD_TIME_ENV_VAR_RE,
} from "./runtime/env-expansion-lint.js";
import {
  declaredRouteTargets,
  graphLintDiagnostics,
  graphHasPlacement,
  placementNestedMessage,
  subgraphOutputSites,
  unknownSubgraphOutputDiagnostics,
} from "./runtime/validate-graph.js";
import { registry } from "./registry.js";
import { setGraphFile, subgraphAliases } from "./runtime/graph-files.js";
import "./nodes/index.js";

export {
  envExpansionCollisionDiagnostics,
  NODE_BODY_ENV_EXPANSION,
} from "./runtime/env-expansion-lint.js";

type LoadResult = { spec: GraphSpec | null; diagnostics: Diagnostic[] };
const filePlacement = new WeakSet<GraphSpec>();

export async function loadGraph(
  filePath: string,
  opts: { cwd?: string; seen?: Set<string> } = {},
): Promise<LoadResult> {
  return loadGraphFile(filePath, opts, new Map());
}

async function loadGraphFile(
  filePath: string,
  opts: { cwd?: string; seen?: Set<string> },
  cache: Map<string, Promise<LoadResult>>,
): Promise<LoadResult> {
  const requested = path.resolve(opts.cwd ?? process.cwd(), filePath);
  const resolved = await fs.realpath(requested).catch(() => requested);
  const ancestors = new Set(opts.seen);
  if (ancestors.has(resolved)) {
    return { spec: null, diagnostics: [{ severity: "error", code: "SUBGRAPH_CYCLE", message: `Subgraph import cycle: ${[...ancestors, resolved].join(" → ")}` }] };
  }
  const cached = cache.get(resolved);
  if (cached) return cached;
  ancestors.add(resolved);
  const pending = readGraph(resolved, ancestors, cache);
  cache.set(resolved, pending);
  return pending;
}

async function readGraph(resolved: string, seen: Set<string>, cache: Map<string, Promise<LoadResult>>): Promise<LoadResult> {
  let raw: string;
  try { raw = await fs.readFile(resolved, "utf-8"); }
  catch { return { spec: null, diagnostics: [{ severity: "error", code: "FILE_NOT_FOUND", message: `Cannot read: ${resolved}` }] }; }
  const envCollisionDiags = envExpansionCollisionDiagnostics(raw);
  let parsed: unknown;
  try { parsed = normalizeNodeTypeAliases(parseYaml(expandEnvVars(raw))); }
  catch (err) {
    return { spec: null, diagnostics: [{ severity: "error", code: "YAML_PARSE_ERROR", message: `YAML parse error: ${String(err)}` }, ...envCollisionDiags] };
  }
  const result = GraphSpecSchema.safeParse(parsed);
  if (!result.success) return { spec: null, diagnostics: [...diagnosticsFromZodIssues(result.error.issues, parsed), ...envCollisionDiags] };
  const spec = result.data;
  setGraphFile(spec, resolved);
  const dir = path.dirname(resolved);
  const diagnostics = [...envCollisionDiags];
  let fatal = false;

  // Check declarations even when unused; this never imports or executes a module.
  for (const [index, imp] of (spec.imports ?? []).entries()) {
    const entry = Object.entries(imp).find(([key]) => key !== "as");
    const ref = entry?.[1];
    if (typeof ref !== "string" || !(path.isAbsolute(ref) || ref.startsWith("."))) continue;
    try { await fs.access(path.resolve(dir, ref)); }
    catch {
      fatal = true;
      diagnostics.push({ severity: "error", code: "IMPORT_NOT_FOUND", message: `Import "${ref}" in ${resolved} cannot be read`, path: `imports[${index}]` });
    }
  }

  const sites = subgraphOutputSites(spec);
  const usedFiles = new Set<string>();
  for (const site of sites) {
    if (!site.uses || site.inline) continue;
    const aliases = subgraphAliases(site.graph);
    const ref = aliases[site.uses] ?? site.uses;
    if (!isGraphFileRef(ref)) continue;
    const childPath = path.resolve(dir, ref);
    usedFiles.add(childPath);
    const child = await loadGraphFile(childPath, { seen }, cache);
    diagnostics.push(...child.diagnostics);
    if (!child.spec) { fatal = true; continue; }
    if (site.out) diagnostics.push(...unknownSubgraphOutputDiagnostics(site, child.spec));
    if (graphHasPlacement(child.spec) || filePlacement.has(child.spec)) {
      filePlacement.add(spec);
      diagnostics.push(site.placed
        ? { severity: "error", code: "PLACEMENT_NESTED", message: placementNestedMessage(site.id), path: `nodes.${site.id}.runsOn` }
        : { severity: "error", code: "PLACEMENT_NOT_TOP_LEVEL", message: `Subgraph node "${site.id}" uses a graph that sets runsOn. Only top-level nodes are placed; set runsOn on "${site.id}" instead.`, path: `nodes.${site.id}.uses` });
    }
  }
  // Unused graph declarations can contain cycles too.
  for (const imp of spec.imports ?? []) {
    if (!("subgraph" in imp) || !isGraphFileRef(imp.subgraph)) continue;
    const childPath = path.resolve(dir, imp.subgraph);
    if (usedFiles.has(childPath)) continue;
    const child = await loadGraphFile(childPath, { seen }, cache);
    diagnostics.push(...child.diagnostics);
    if (!child.spec) fatal = true;
  }
  const unique = [...new Map(diagnostics.map((d) => [`${d.code}:${d.path}:${d.message}`, d])).values()];
  return { spec: fatal ? null : spec, diagnostics: unique };
}

function isGraphFileRef(ref: string): boolean {
  return ref.endsWith(".yaml") || ref.endsWith(".yml") || ref.startsWith(".") || ref.includes("/") || ref.includes("\\");
}

function expandEnvVars(yaml: string): string {
  return yaml.replace(LOAD_TIME_ENV_VAR_RE, (_m, name: string, def: string) => {
    return process.env[name] ?? def ?? "";
  });
}

/** Deprecated YAML node type → canonical type. */
const NODE_TYPE_ALIASES: Readonly<Record<string, string>> = {
  code: "function",
  intelligent: "agent",
};

/** Deprecated YAML hook phase → canonical phase. */
const HOOK_PHASE_ALIASES: Readonly<Record<string, string>> = {
  "intelligent:beforeStep": "agent:beforeStep",
  "intelligent:beforeToolCall": "agent:beforeToolCall",
  "intelligent:afterToolCall": "agent:afterToolCall",
};

/**
 * Rewrite deprecated `type: code` / `type: intelligent` (and nested map/subgraph
 * node specs) plus legacy `intelligent:*` hook phases to their canonical names.
 * Exported for tests and for UI-side YAML parsers that want the same mapping.
 */
export function normalizeNodeTypeAliases(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") return parsed;
  const root = parsed as Record<string, unknown>;

  const rewriteNode = (node: unknown): unknown => {
    if (!node || typeof node !== "object") return node;
    const n = { ...(node as Record<string, unknown>) };
    if (typeof n.type === "string" && NODE_TYPE_ALIASES[n.type]) {
      n.type = NODE_TYPE_ALIASES[n.type];
    }
    // map nodes nest an inner node under with.node
    if (n.with && typeof n.with === "object") {
      const w = { ...(n.with as Record<string, unknown>) };
      if (w.node && typeof w.node === "object") {
        w.node = rewriteNode(w.node);
      }
      n.with = w;
    }
    return n;
  };

  if (Array.isArray(root.nodes)) {
    root.nodes = root.nodes.map(rewriteNode);
  }

  const runtime = root.runtime;
  if (runtime && typeof runtime === "object") {
    const rt = { ...(runtime as Record<string, unknown>) };
    if (Array.isArray(rt.hooks)) {
      rt.hooks = rt.hooks.map((hook) => {
        if (!hook || typeof hook !== "object") return hook;
        const h = { ...(hook as Record<string, unknown>) };
        if (typeof h.on === "string" && HOOK_PHASE_ALIASES[h.on]) {
          h.on = HOOK_PHASE_ALIASES[h.on];
        }
        return h;
      });
    }
    root.runtime = rt;
  }

  return root;
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
  // A router's or routing hitl's own `with.routes` also lead somewhere.
  for (const node of spec.nodes) {
    for (const t of declaredRouteTargets(spec, node.id)) allTargets.add(t);
  }
  for (const node of spec.nodes) {
    if (!allTargets.has(node.id)) {
      diagnostics.push({ severity: "warning", code: "NO_INBOUND_EDGE", message: `Node "${node.id}" has no inbound edges` });
    }
  }

  // Per-node type registration + `with` shape (same schemas compileGraph uses)
  for (const node of spec.nodes) {
    const factory = registry.get(node.type);
    if (!factory) {
      diagnostics.push({
        severity: "error",
        code: "UNKNOWN_NODE_TYPE",
        message: `Node "${node.id}" has unregistered type "${node.type}"`,
        path: `nodes.${node.id}.type`,
      });
      continue;
    }
    const configResult = factory.configSchema.safeParse(node.with ?? {});
    if (!configResult.success) {
      for (const issue of configResult.error.issues) {
        const fieldPath = issue.path.join(".");
        diagnostics.push({
          severity: "error",
          code: "NODE_CONFIG_ERROR",
          message: fieldPath ? `${fieldPath}: ${issue.message}` : issue.message,
          path: fieldPath ? `nodes.${node.id}.with.${fieldPath}` : `nodes.${node.id}.with`,
        });
      }
    }
  }

  diagnostics.push(...graphLintDiagnostics(spec));

  return diagnostics;
}
