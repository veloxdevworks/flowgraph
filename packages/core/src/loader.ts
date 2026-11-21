import { currentEnvironment } from "./environment.js";
/**
 * Stage 1 of compilation: load a YAML file and return a validated GraphSpec.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { KNOWN_PHASES, knownHookDirective } from "./hooks/builtin.js";
import { parse as parseYaml } from "yaml";
import { GraphSpecSchema, diagnosticsFromZodIssues, type GraphSpec, type Diagnostic } from "@flowgraph/spec";
import {
  envExpansionCollisionDiagnostics,
} from "./runtime/env-expansion-lint.js";
import {
  declaredRouteTargets,
  graphLintDiagnostics,
  graphHasPlacement,
  placementNestedMessage,
  subgraphOutputSites,
  unknownSubgraphOutputDiagnostics,
} from "./runtime/validate-graph.js";
import { walkNodes } from "./discover-skills.js";
import { registry } from "./registry.js";
import { setGraphFile, subgraphAliases } from "./runtime/graph-files.js";
import "./nodes/index.js";
import { getMediaVendor } from "./media/registry.js";
import { offlineProviderValidations, providerConfigDiagnostics } from "./providers/diagnostics.js";

export {
  envExpansionCollisionDiagnostics,
  NODE_BODY_ENV_EXPANSION,
} from "./runtime/env-expansion-lint.js";

type LoadResult = { spec: GraphSpec | null; diagnostics: Diagnostic[] };
const filePlacement = new WeakSet<GraphSpec>();

/** Type names can be checked even when strict graph parsing rejects another field. */
function rawNodeTypeDiagnostics(parsed: unknown): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const graph = (value: unknown, prefix = ""): void => {
    if (!value || typeof value !== "object") return;
    const raw = value as { nodes?: unknown; imports?: Array<{ nodes?: unknown }> };
    // Plugin types are not known until imports are loaded. Do not incorrectly
    // label a plugin type as unknown while reporting an unrelated schema error.
    if (Array.isArray(raw.imports) && raw.imports.some((imp) => imp && typeof imp.nodes === "string")) return;
    if (!Array.isArray(raw.nodes)) return;
    const node = (value: unknown, base: string): void => {
      if (!value || typeof value !== "object") return;
      const rawNode = value as { id?: unknown; type?: unknown; with?: { node?: unknown; graph?: unknown }; spec?: unknown };
      if (typeof rawNode.type === "string" && !registry.has(rawNode.type)) {
        diagnostics.push({ severity: "error", code: "UNKNOWN_NODE_TYPE", path: `${base}.type`, message: `Node "${String(rawNode.id)}" has unregistered type "${rawNode.type}"` });
      }
      if (rawNode.type === "map") node(rawNode.with?.node, `${base}.with.node`);
      if (rawNode.type === "subgraph") graph(rawNode.spec ?? rawNode.with?.graph, `${base}.spec.`);
    };
    raw.nodes.forEach((entry, index) => node(entry, `${prefix}nodes.${typeof entry?.id === "string" ? entry.id : index}`));
  };
  graph(parsed);
  return diagnostics;
}

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
  try { parsed = normalizeNodeTypeAliases(expandGraphEnv(parseYaml(raw))); }
  catch (err) {
    return { spec: null, diagnostics: [{ severity: "error", code: "YAML_PARSE_ERROR", message: `YAML parse error: ${String(err)}` }, ...envCollisionDiags] };
  }
  const result = GraphSpecSchema.safeParse(parsed);
  if (!result.success) return { spec: null, diagnostics: [...diagnosticsFromZodIssues(result.error.issues, parsed), ...rawNodeTypeDiagnostics(parsed), ...envCollisionDiags] };
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

/** Expand trusted config/runtime scalar values after parsing, never source text or keys. */
function expandGraphEnv(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const root = parsed as Record<string, unknown>;
  const expand = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(/(?<!\$)\$\{([A-Z_][A-Z0-9_]*)(?::-(.*?))?\}/g, (_m, name: string, def: string) => currentEnvironment()[name] ?? def ?? "").replace(/\$\$\{/g, "${");
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, expand(val)]));
    return value;
  };
  for (const key of ["config", "runtime"]) if (root[key] != null) root[key] = expand(root[key]);
  const node = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const n = value as Record<string, unknown>, withConfig = n.with as Record<string, unknown> | undefined;
    if (n.type === "map") node(withConfig?.node);
    if (n.type === "subgraph") { if (n.graph) expandGraphEnv(n.graph); if (withConfig?.graph) expandGraphEnv(withConfig.graph); }
  };
  if (Array.isArray(root.nodes)) root.nodes.forEach(node);
  return root;
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
  for (const [index,hook] of (spec.runtime?.hooks ?? []).entries()) if (!KNOWN_PHASES.has(hook.on)) diagnostics.push({severity:"error",code:"HOOK_PHASE_UNKNOWN",path:`runtime.hooks[${index}].on`,message:`Unknown hook phase "${hook.on}". Allowed phases: ${[...KNOWN_PHASES].join(", ")}`});
  for (const [index,hook] of (spec.runtime?.hooks ?? []).entries()) if (!knownHookDirective(hook.do)) diagnostics.push({severity:"error",code:"HOOK_DIRECTIVE_UNKNOWN",path:`runtime.hooks[${index}].do`,message:`Unknown hook directive "${hook.do}". Use retry, continue, ignore, interrupt, fail, redact or route:<node>.`});
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
    // A `from` list is checked in barrierEdgeDiagnostics, including unknown ids.
    if (!Array.isArray(edge.from)) check(edge.from);
    if ("to" in edge) { const tos = Array.isArray(edge.to) ? edge.to : [edge.to]; for (const t of tos) check(t); }
    if ("branch" in edge) { for (const b of edge.branch) check(b.to); }
  }

  // Must have START edge
  if (!spec.edges.some((e) => (Array.isArray(e.from) ? e.from : [e.from]).includes("START"))) {
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

  if (spec.runtime?.budget?.maxUSD !== undefined) walkNodes(spec, node => {
    const provider = typeof node.provider === "string" ? node.provider : spec.config?.defaults?.provider;
    const modelNode = ["agent", "intelligent"].includes(String(node.type)) || node.type === "router" && (node.with as { mode?: string } | undefined)?.mode === "model";
    if (modelNode && (!provider || provider === "langchain" || spec.providers?.[provider]?.kind === "langchain")) {
      diagnostics.push({ severity: "warning", code: "BUDGET_USD_UNPRICED", path: `nodes.${node.id}`,
        message: "LangChain reports tokens without model pricing; maxUSD cannot cap those calls. Use maxTokens or a provider that reports costUSD." });
    }
  });
  diagnostics.push(...graphLintDiagnostics(spec));
  walkNodes(spec, node => {
    if (!["image", "video", "audio", "model3d"].includes(String(node.type))) return;
    const name = node.provider ?? spec.config?.defaults?.provider;
    const cfg = typeof name === "string" ? spec.providers?.[name] : undefined;
    const vendor = getMediaVendor(cfg && "vendor" in cfg ? cfg.vendor : String(name ?? ""));
    if (!vendor) return;
    const w = node.with as Record<string, unknown> ?? {};
    // Dynamic requests are checked after rendering, before submission.
    if (JSON.stringify([w.model, w.size, w.params]).includes("{{")) return;
    try {
      vendor.create({ name: String(name), ...(cfg?.kind === "media" ? { model: cfg.model, options: cfg.options } : {}) }).validateRequest?.({
        modality: node.type as import("./media/types.js").MediaModality, model: typeof node.model === "string" ? node.model : typeof w.model === "string" ? w.model : undefined,
        inputs: [], count: 1, params: w.params as Record<string, unknown> ?? {}, ...(typeof w.size === "string" ? { size: w.size } : {}),
      });
    } catch (err) { diagnostics.push({ severity: "error", code: "MEDIA_REQUEST_INVALID", path: `nodes.${node.id}.with`, message: `Media node "${node.id}": ${String(err)}` }); }
  });

  diagnostics.push(...providerConfigDiagnostics(spec, offlineProviderValidations(spec)));
  return diagnostics;
}
