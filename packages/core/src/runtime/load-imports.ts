/**
 * Resolve and load graph `imports` (nodes, providers, reducers, skill/subgraph aliases).
 */

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import { registry, type NodeFactory, type ReducerFn } from "../registry.js";
import { registerProvider, type ProviderAdapter } from "../providers/index.js";

export interface LoadGraphImportsOptions {
  cwd?: string;
}

export interface LoadGraphImportsResult {
  skillAliases: Record<string, string>;
  subgraphAliases: Record<string, string>;
}

async function importModuleSpecifier(specifier: string, cwd: string): Promise<Record<string, unknown>> {
  if (specifier.startsWith(".") || specifier.startsWith("/") || /^[a-zA-Z]:\\/.test(specifier)) {
    const resolved = path.resolve(cwd, specifier);
    return (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
  }
  const require = createRequire(path.join(cwd, "package.json"));
  const resolved = require.resolve(specifier);
  return (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
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
    } else if ("subgraph" in imp) {
      subgraphAliases[imp.as ?? imp.subgraph] = imp.subgraph;
    }
  }

  return { skillAliases, subgraphAliases };
}

function normalizeDefaultExport<T>(value: unknown): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? (value as T[]) : [value as T];
}
