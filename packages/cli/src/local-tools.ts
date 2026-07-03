import * as path from "node:path";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import { lazyOptionalImport } from "./optional-deps.js";

const loadToolsFs = lazyOptionalImport<typeof import("@veloxdevworks/flowgraph-tools-fs")>(
  "@veloxdevworks/flowgraph-tools-fs",
  "Install it: pnpm add @veloxdevworks/flowgraph-tools-fs",
);

function hasMutatingFsHook(spec: GraphSpec, mutatingToolNames: Set<string>): boolean {
  for (const hook of spec.runtime?.hooks ?? []) {
    if (hook.on !== "intelligent:beforeToolCall") continue;
    const tool = hook.where?.["tool"];
    if (typeof tool === "string" && mutatingToolNames.has(tool)) return true;
  }
  return false;
}

function hasPermissionAskOnIntelligent(spec: GraphSpec): boolean {
  return spec.nodes.some(
    (n) => n.type === "intelligent" && (n.with as { permission?: string } | undefined)?.permission === "ask",
  );
}

export interface LocalToolsRegistration {
  warnings: string[];
}

/**
 * Register local tools declared in the graph spec (filesystem, etc.).
 */
export async function registerLocalTools(spec: GraphSpec, cwd = process.cwd()): Promise<LocalToolsRegistration> {
  const warnings: string[] = [];
  const fsCfg = spec.localTools?.fs;
  if (!fsCfg) return { warnings };

  const toolsFs = await loadToolsFs();
  const workspaceRoot = path.resolve(cwd, fsCfg.workspaceRoot ?? ".");
  const operations = fsCfg.operations;

  toolsFs.registerFsTools({ workspaceRoot, ...(operations ? { operations } : {}) });

  const mutatingToolNames = new Set(toolsFs.MUTATING_FS_OPERATIONS.map((op) => `fs_${op}`));
  const enabledMutating = (operations ?? ["read", "list"]).filter((op) =>
    toolsFs.MUTATING_FS_OPERATIONS.includes(op as (typeof toolsFs.MUTATING_FS_OPERATIONS)[number]),
  );
  if (
    enabledMutating.length > 0 &&
    !hasMutatingFsHook(spec, mutatingToolNames) &&
    !hasPermissionAskOnIntelligent(spec)
  ) {
    warnings.push(
      `localTools.fs enables mutating operations (${enabledMutating.join(", ")}) without ` +
        `runtime.hooks gating (intelligent:beforeToolCall + do: interrupt) or permission: ask ` +
        `on an intelligent node. Consider adding approval gates before running in production.`,
    );
  }

  return { warnings };
}
