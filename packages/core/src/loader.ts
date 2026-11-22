/**
 * Stage 1 of compilation: load a YAML file and return a validated GraphSpec.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { GraphSpecSchema, HOOK_EVENT_ALIASES, diagnosticsFromZodIssues, type GraphSpec, type Diagnostic } from "@flowgraph/spec";
import {
  envExpansionCollisionDiagnostics,
} from "./runtime/env-expansion-lint.js";
import {
  graphLintDiagnostics,
  GRAPH_SHAPE_CODES,
  graphStructureDiagnostics,
  graphHasPlacement,
  placementNestedMessage,
  subgraphOutputSites,
  subgraphInputDiagnostics,
  unknownSubgraphOutputDiagnostics,
} from "./runtime/validate-graph.js";
import { walkNodes } from "./discover-skills.js";
import { withUnresolvedImports } from "./runtime/load-imports.js";
import { registry } from "./registry.js";
import { setGraphFile, subgraphAliases } from "./runtime/graph-files.js";
import "./nodes/index.js";
import { getMediaVendor } from "./media/registry.js";
import { offlineProviderValidations, providerConfigDiagnostics } from "./providers/diagnostics.js";
import { secretReferenceDiagnostics } from "./runtime/secret-declarations.js";
import { expandGraphEnv, recordGraphEnvExpansion, unexpandedEnvDiagnostics, type GraphEnvExpansion } from "./runtime/config-env.js";

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
      const rawNode = value as { id?: unknown; type?: unknown; with?: { node?: unknown }; spec?: unknown };
      if (typeof rawNode.type === "string" && !registry.has(rawNode.type)) {
        diagnostics.push({ severity: "error", code: "UNKNOWN_NODE_TYPE", path: `${base}.type`, message: `Node "${String(rawNode.id)}" has unregistered type "${rawNode.type}"` });
      }
      if (rawNode.type === "map") node(rawNode.with?.node, `${base}.with.node`);
      if (rawNode.type === "subgraph") graph(rawNode.spec, `${base}.spec.`);
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

/** A `uses` file read for a parent graph, with the plugin and reducer imports of the graphs above it. */
interface ParentContext {
  moduleImports: NonNullable<GraphSpec["imports"]>;
}

async function loadGraphFile(
  filePath: string,
  opts: { cwd?: string; seen?: Set<string> },
  cache: Map<string, Promise<LoadResult>>,
  parent?: ParentContext,
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
  const pending = readGraph(resolved, ancestors, cache, parent);
  cache.set(resolved, pending);
  return pending;
}

async function readGraph(resolved: string, seen: Set<string>, cache: Map<string, Promise<LoadResult>>, parent?: ParentContext): Promise<LoadResult> {
  let raw: string;
  try { raw = await fs.readFile(resolved, "utf-8"); }
  catch { return { spec: null, diagnostics: [{ severity: "error", code: "FILE_NOT_FOUND", message: `Cannot read: ${resolved}` }] }; }
  const envCollisionDiags = envExpansionCollisionDiagnostics(raw);
  let parsed: unknown;
  let expansion: GraphEnvExpansion;
  try {
    parsed = parseYaml(raw);
    expansion = expandGraphEnv(parsed);
    parsed = normalizeNodeTypeAliases(parsed);
  }
  catch (err) {
    return { spec: null, diagnostics: [{ severity: "error", code: "YAML_PARSE_ERROR", message: `YAML parse error: ${String(err)}` }, ...envCollisionDiags] };
  }
  const result = GraphSpecSchema.safeParse(parsed);
  if (!result.success) return { spec: null, diagnostics: [...diagnosticsFromZodIssues(result.error.issues, parsed), ...rawNodeTypeDiagnostics(parsed), ...expansion.diagnostics, ...envCollisionDiags] };
  const spec = result.data;
  setGraphFile(spec, resolved);
  recordGraphEnvExpansion(spec, expansion);
  const dir = path.dirname(resolved);
  const diagnostics = [...envCollisionDiags, ...expansion.diagnostics];
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

  // A `uses` file is validated like the top-level graph, which its caller validates.
  // Plugin types and reducers may come from any graph above it, and are not loaded here.
  const moduleImports = [...(parent?.moduleImports ?? []), ...(spec.imports ?? []).filter((imp) => "nodes" in imp || "reducers" in imp)];
  if (parent) diagnostics.push(...withUnresolvedImports({ ...spec, imports: moduleImports }, validateSpec(spec)));
  const childContext: ParentContext = { moduleImports };

  const sites = subgraphOutputSites(spec);
  const usedFiles = new Set<string>();
  for (const site of sites) {
    if (!site.uses || site.inline) continue;
    const aliases = subgraphAliases(site.graph);
    const ref = aliases[site.uses] ?? site.uses;
    if (!isGraphFileRef(ref)) continue;
    const childPath = path.resolve(dir, ref);
    usedFiles.add(childPath);
    const child = await loadGraphFile(childPath, { seen }, cache, childContext);
    diagnostics.push(...inFile(child.diagnostics, childPath));
    if (!child.spec) { fatal = true; continue; }
    if (site.out) diagnostics.push(...unknownSubgraphOutputDiagnostics(site, child.spec));
    diagnostics.push(...subgraphInputDiagnostics(site, child.spec));
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
    const child = await loadGraphFile(childPath, { seen }, cache, childContext);
    diagnostics.push(...inFile(child.diagnostics, childPath));
    if (!child.spec) fatal = true;
  }
  const unique = [...new Map(diagnostics.map((d) => [`${d.file}:${d.code}:${d.path}:${d.message}`, d])).values()];
  return { spec: fatal ? null : spec, diagnostics: unique };
}

/** A file subgraph's diagnostics name its file; ones from deeper files keep theirs. */
function inFile(diagnostics: Diagnostic[], file: string): Diagnostic[] {
  return diagnostics.map((d) => (d.file ? d : { ...d, file }));
}

function isGraphFileRef(ref: string): boolean {
  return ref.endsWith(".yaml") || ref.endsWith(".yml") || ref.startsWith(".") || ref.includes("/") || ref.includes("\\");
}

/** Deprecated YAML node type → canonical type. */
const NODE_TYPE_ALIASES: Readonly<Record<string, string>> = {
  code: "function",
  intelligent: "agent",
};

/**
 * Rewrite deprecated `type: code` / `type: intelligent` and hook events listed
 * in `HOOK_EVENT_ALIASES`, in the graph, in map bodies and in inline subgraph
 * `spec` blocks at any depth.
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
    // Inline subgraphs are whole graphs, with their own nodes and hooks.
    if (n.spec && typeof n.spec === "object") n.spec = normalizeNodeTypeAliases({ ...(n.spec as Record<string, unknown>) });
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
        if (typeof h.on === "string" && HOOK_EVENT_ALIASES[h.on]) {
          h.on = HOOK_EVENT_ALIASES[h.on];
        }
        return h;
      });
    }
    root.runtime = rt;
  }

  return root;
}

/**
 * Offline lint — no side effects, no network. Covers the graph, its map
 * bodies and its inline subgraph `spec` blocks at any depth (see
 * `graphStructureDiagnostics`); `loadGraph` applies it to `uses` files.
 */
export function validateSpec(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = graphStructureDiagnostics(spec, { lints: true });
  // The remaining passes walk every place a nested graph is used, without a depth limit.
  if (diagnostics.some((d) => GRAPH_SHAPE_CODES.has(d.code))) return diagnostics;

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
  diagnostics.push(...secretReferenceDiagnostics(spec), ...unexpandedEnvDiagnostics(spec));
  return diagnostics;
}
