/**
 * Resolve and load graph `imports` (nodes, providers, reducers, skill/subgraph aliases).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import { registry, type NodeFactory, type ReducerFn } from "../registry.js";
import { registerProvider, type ProviderAdapter } from "../providers/index.js";

export interface LoadGraphImportsOptions {
  cwd?: string;
}

export interface LoadGraphImportsResult {
  skillAliases: Record<string, string>;
  agentAliases: Record<string, string>;
  subgraphAliases: Record<string, string>;
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

/**
 * Compile a TypeScript import module to ESM and load it.
 * Bare imports become absolute paths so the compiled file can live in
 * os.tmpdir() (graph examples may ship inside a read-only app bundle).
 */
async function importTypeScriptModule(resolved: string): Promise<Record<string, unknown>> {
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
  setTimeout(() => {
    void fs.unlink(outPath).catch(() => undefined);
  }, 5_000);
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

async function importModuleSpecifier(specifier: string, cwd: string): Promise<Record<string, unknown>> {
  if (specifier.startsWith(".") || specifier.startsWith("/") || /^[a-zA-Z]:\\/.test(specifier)) {
    const resolved = path.resolve(cwd, specifier);
    return importResolvedPath(resolved);
  }
  const require = createRequire(path.join(cwd, "package.json"));
  const resolved = require.resolve(specifier);
  return importResolvedPath(resolved);
}

function registerReducerExports(mod: Record<string, unknown>): void {
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
        if (!registry.getReducer(name)) registry.registerReducer(name, reducer);
      }
    }
    return;
  }

  if (typeof def === "object") {
    for (const [name, fn] of Object.entries(def as Record<string, unknown>)) {
      if (typeof fn === "function" && !registry.getReducer(name)) {
        registry.registerReducer(name, fn as ReducerFn);
      }
    }
  }
}

async function loadReducerImport(specifier: string, cwd: string): Promise<void> {
  const mod = await importModuleSpecifier(specifier, cwd);
  // Side-effect: module may call registry.registerReducer during evaluation.
  registerReducerExports(mod);
}

/**
 * Load all imports from a graph spec. Must run before validateSpec (for custom
 * reducers) and before buildStateAnnotation / node compilation.
 */
export async function loadGraphImports(
  spec: GraphSpec,
  opts: LoadGraphImportsOptions = {},
): Promise<LoadGraphImportsResult> {
  const cwd = opts.cwd ?? process.cwd();
  const skillAliases: Record<string, string> = {};
  const agentAliases: Record<string, string> = {};
  const subgraphAliases: Record<string, string> = {};

  for (const imp of spec.imports ?? []) {
    if ("nodes" in imp) {
      const mod = await importModuleSpecifier(imp.nodes, cwd);
      const factories = normalizeDefaultExport<NodeFactory>(mod["default"]);
      for (const f of factories) {
        if (!registry.has(f.type)) registry.register(f);
      }
    } else if ("providers" in imp) {
      const mod = await importModuleSpecifier(imp.providers, cwd);
      const provs = normalizeDefaultExport<ProviderAdapter>(mod["default"]);
      for (const p of provs) registerProvider(p);
    } else if ("reducers" in imp) {
      await loadReducerImport(imp.reducers, cwd);
    } else if ("skill" in imp) {
      skillAliases[imp.as ?? imp.skill] = imp.skill;
    } else if ("agent" in imp) {
      agentAliases[imp.as ?? imp.agent] = imp.agent;
    } else if ("subgraph" in imp) {
      subgraphAliases[imp.as ?? imp.subgraph] = imp.subgraph;
    }
  }

  return { skillAliases, agentAliases, subgraphAliases };
}

function normalizeDefaultExport<T>(value: unknown): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? (value as T[]) : [value as T];
}
