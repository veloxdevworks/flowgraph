/**
 * Resolve and load graph `imports` (nodes, providers, reducers, skill/subgraph aliases).
 * Loaded plugins, providers, and reducers stay scoped to the compile's forked
 * registry instead of mutating process-wide registries.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";
import { isNamespacedPluginType, type Diagnostic, type GraphSpec } from "@flowgraph/spec";
import { registry, type NodeFactory, type NodeRegistry, type ReducerFn } from "../registry.js";
import { isProviderPlugin, type ProviderAdapter, type ProviderPlugin } from "../providers/index.js";

export interface LoadGraphImportsOptions {
  cwd?: string;
  /** Per-compile registry to register imported nodes and reducers into. Defaults to a fork of the base registry. */
  registry?: NodeRegistry;
}

export interface GraphImportAliases {
  skillAliases: Record<string, string>;
  agentAliases: Record<string, string>;
  subgraphAliases: Record<string, string>;
}

export interface LoadGraphImportsResult extends GraphImportAliases {
  registry: NodeRegistry;
  providers: ProviderAdapter[];
  providerPlugins: Map<string, ProviderPlugin>;
}

function isTypeScriptPath(filePath: string): boolean {
  return filePath.endsWith(".ts") || filePath.endsWith(".tsx") || filePath.endsWith(".mts");
}

/**
 * Resolve a bare package specifier to an absolute filesystem path.
 * Uses import.meta.resolve (honors ESM `exports`) — createRequire fails on
 * packages that only declare `"exports"."import"` without a CJS main.
 *
 * Prefer the import file's tree (dev checkouts with link: deps), then fall
 * back to the running engine's tree (bundled examples have no node_modules).
 */
function resolveBareImport(specifier: string, fromFile: string): string {
  const parents = [pathToFileURL(fromFile).href, import.meta.url];
  for (const parent of parents) {
    try {
      const url = import.meta.resolve(specifier, parent);
      if (url.startsWith("file:")) return fileURLToPath(url);
      return url;
    } catch {
      // try next parent
    }
  }
  return specifier;
}

const tsImportCache = new Map<string, { mtimeMs: number; mod: Record<string, unknown> }>();

/**
 * Compile a TypeScript import module to ESM and load it.
 * Bare imports become absolute paths so the compiled file can live in
 * os.tmpdir() (graph examples may ship inside a read-only app bundle).
 */
async function importTypeScriptModule(resolved: string): Promise<Record<string, unknown>> {
  const stat = await fs.stat(resolved);
  const cached = tsImportCache.get(resolved);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.mod;
  }
  const built = await esbuild.build({
    entryPoints: [resolved],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node20",
    logLevel: "silent",
    plugins: [
      {
        name: "absolute-externals",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            // Keep the entry point as the only non-external module.
            if (args.kind === "entry-point") return undefined;
            if (args.path.startsWith("node:")) {
              return { path: args.path, external: true };
            }
            // Relative imports: let esbuild follow/bundle nested .ts if needed.
            if (args.path.startsWith(".") || path.isAbsolute(args.path)) {
              return undefined;
            }
            const abs = resolveBareImport(args.path, resolved);
            return { path: abs, external: true };
          });
        },
      },
    ],
  });
  const file = built.outputFiles?.[0];
  if (!file) {
    throw new Error(`Failed to compile TypeScript import: ${resolved}`);
  }
  const cacheDir = path.join(os.tmpdir(), "flowgraph-imports");
  await fs.mkdir(cacheDir, { recursive: true });
  const outPath = path.join(
    cacheDir,
    `${path.basename(resolved)}.${process.pid}.${Date.now()}.mjs`,
  );
  await fs.writeFile(outPath, file.text, "utf8");
  // Delay cleanup: Vitest/Vite may still read the file after dynamic import
  // resolves, and some platforms lock the file until the module finishes linking.
  const imported = (await import(pathToFileURL(outPath).href)) as Record<string, unknown>;
  tsImportCache.set(resolved, { mtimeMs: stat.mtimeMs, mod: imported });
  const cleanup = setTimeout(() => {
    void fs.unlink(outPath).catch(() => undefined);
  }, 5_000);
  cleanup.unref?.();
  return imported;
}

async function importResolvedPath(resolved: string): Promise<Record<string, unknown>> {
  if (isTypeScriptPath(resolved)) {
    // Vitest/Vite already transpile .ts; going through a temp .mjs file breaks
    // their module pipeline. Plain Node (CLI/sidecar) needs the esbuild path.
    if (process.env["VITEST"] || process.env["VITEST_WORKER_ID"]) {
      return (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
    }
    return importTypeScriptModule(resolved);
  }
  return (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
}

async function importModuleSpecifier(
  specifier: string,
  cwd: string,
): Promise<Record<string, unknown>> {
  if (specifier.startsWith(".") || specifier.startsWith("/") || /^[a-zA-Z]:\\/.test(specifier)) {
    const resolved = path.resolve(cwd, specifier);
    return importResolvedPath(resolved);
  }
  const require = createRequire(path.join(cwd, "package.json"));
  const resolved = require.resolve(specifier);
  return importResolvedPath(resolved);
}

function registerReducerExports(mod: Record<string, unknown>, target: NodeRegistry): void {
  const def = mod["default"];
  if (def == null) return;

  if (Array.isArray(def)) {
    for (const entry of def) {
      if (
        entry != null &&
        typeof entry === "object" &&
        "name" in entry &&
        "reducer" in entry &&
        typeof (entry as { name: unknown }).name === "string" &&
        typeof (entry as { reducer: unknown }).reducer === "function"
      ) {
        const { name, reducer } = entry as { name: string; reducer: ReducerFn };
        target.registerReducer(name, reducer);
      }
    }
    return;
  }

  if (typeof def === "object") {
    for (const [name, fn] of Object.entries(def as Record<string, unknown>)) {
      if (typeof fn === "function") {
        target.registerReducer(name, fn as ReducerFn);
      }
    }
  }
}

async function loadReducerImport(specifier: string, cwd: string, target: NodeRegistry): Promise<void> {
  const mod = await importModuleSpecifier(specifier, cwd);
  registerReducerExports(mod, target);
}

/**
 * Read skill, agent and subgraph aliases from `imports`.
 * Does not read or execute modules.
 */
export function readGraphImportAliases(spec: GraphSpec): GraphImportAliases {
  const skillAliases: Record<string, string> = {};
  const agentAliases: Record<string, string> = {};
  const subgraphAliases: Record<string, string> = {};

  for (const imp of spec.imports ?? []) {
    if ("skill" in imp) skillAliases[imp.as ?? imp.skill] = imp.skill;
    else if ("agent" in imp) agentAliases[imp.as ?? imp.agent] = imp.agent;
    else if ("subgraph" in imp) subgraphAliases[imp.as ?? imp.subgraph] = imp.subgraph;
  }

  return { skillAliases, agentAliases, subgraphAliases };
}

/**
 * Rewrite static diagnostics for namespaced plugin types and reducers that only
 * an import module would register. Validate does not load those modules, so a
 * declared `nodes` import turns an unregistered namespaced type into a warning
 * while bare typos stay `UNKNOWN_NODE_TYPE` errors.
 */
export function withUnresolvedImports(spec: GraphSpec, diagnostics: Diagnostic[]): Diagnostic[] {
  const imports = spec.imports ?? [];
  const hasNodes = imports.some((imp) => "nodes" in imp);
  const hasReducers = imports.some((imp) => "reducers" in imp);
  if (!hasNodes && !hasReducers) return diagnostics;
  return diagnostics.map((d) => {
    if (hasNodes && d.code === "UNKNOWN_NODE_TYPE") {
      const match = /has unregistered type "([^"]+)"/.exec(d.message);
      if (match && isNamespacedPluginType(match[1]!)) {
        return {
          ...d,
          severity: "warning",
          code: "PLUGIN_TYPE_UNRESOLVED",
          message: `${d.message}. Validate does not load imports, so this type stays unresolved.`,
        };
      }
    }
    if (hasReducers && d.code === "UNREGISTERED_REDUCER") {
      return {
        ...d,
        severity: "warning",
        message: `${d.message.replace("before validating or compiling.", "before the graph runs.")} Validate does not load reducer imports, so this reducer stays unresolved.`,
      };
    }
    return d;
  });
}

/**
 * Load and execute `nodes`, `providers` and `reducers` modules into a per-compile
 * registry and provider collection. Does not mutate the process-wide registries.
 * `flowgraph validate` and other static checks must use `readGraphImportAliases`
 * instead. Run and compile call this because the graph is about to execute.
 */
export async function loadGraphImports(
  spec: GraphSpec,
  opts: LoadGraphImportsOptions = {},
): Promise<LoadGraphImportsResult> {
  const cwd = opts.cwd ?? process.cwd();
  const targetRegistry = opts.registry ?? registry.fork();
  const aliases = readGraphImportAliases(spec);
  const providersByName = new Map<string, ProviderAdapter>();
  const providerPlugins = new Map<string, ProviderPlugin>();

  for (const imp of spec.imports ?? []) {
    if ("nodes" in imp) {
      const mod = await importModuleSpecifier(imp.nodes, cwd);
      const factories = normalizeDefaultExport<NodeFactory>(mod["default"]);
      for (const f of factories) {
        targetRegistry.register(f, { plugin: true });
      }
    } else if ("providers" in imp) {
      const mod = await importModuleSpecifier(imp.providers, cwd);
      const entries = normalizeDefaultExport<ProviderAdapter | ProviderPlugin>(mod["default"]);
      for (const entry of entries) {
        if (isProviderPlugin(entry)) {
          const existing = providerPlugins.get(entry.name);
          if (existing !== undefined) {
            if (existing === entry) continue;
            throw Object.assign(
              new Error(`Provider plugin "${entry.name}" collides with an already-imported provider plugin.`),
              { code: "PLUGIN_PROVIDER_COLLISION", retryable: false },
            );
          }
          providerPlugins.set(entry.name, entry);
        } else {
          const existing = providersByName.get(entry.name);
          if (existing !== undefined) {
            if (existing === entry) continue;
            throw Object.assign(
              new Error(`Provider "${entry.name}" collides with an already-imported provider.`),
              { code: "PLUGIN_PROVIDER_COLLISION", retryable: false },
            );
          }
          providersByName.set(entry.name, entry);
        }
      }
    } else if ("reducers" in imp) {
      await loadReducerImport(imp.reducers, cwd, targetRegistry);
    }
  }

  return {
    ...aliases,
    registry: targetRegistry,
    providers: [...providersByName.values()],
    providerPlugins,
  };
}

function normalizeDefaultExport<T>(value: unknown): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? (value as T[]) : [value as T];
}
