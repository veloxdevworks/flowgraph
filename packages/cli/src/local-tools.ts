import * as path from "node:path";
import type { GraphSpec } from "@flowgraph/spec";
import type { LocalTools } from "@flowgraph/tools-fs";
import { lazyOptionalImport } from "./optional-deps.js";

const loadToolsFs = lazyOptionalImport<typeof import("@flowgraph/tools-fs")>(
  "@flowgraph/tools-fs",
  "Install it: pnpm add @flowgraph/tools-fs",
);

function hasMutatingFsHook(spec: GraphSpec, mutatingToolNames: Set<string>): boolean {
  for (const hook of spec.runtime?.hooks ?? []) {
    if (hook.on !== "agent:beforeToolCall") continue;
    if (hook.do !== "interrupt" && hook.do !== "deny") continue;
    const tool = hook.where?.["tool"];
    if (typeof tool === "string" && mutatingToolNames.has(tool)) return true;
  }
  return false;
}

function hasPermissionAskOnAgent(spec: GraphSpec): boolean {
  return spec.nodes.some(
    (n) => n.type === "agent" && (n.with as { permission?: string } | undefined)?.permission === "ask",
  );
}

export interface LocalToolsRegistration {
  warnings: string[];
}

/**
 * Register local tools declared in the graph spec (filesystem, etc.).
 * `workspace` is an already resolved execution root (including a recovered thread
 * binding). Only localTools.fs.workspaceRoot is resolved beneath it.
 */
export async function registerLocalTools(
  spec: GraphSpec,
  cwd = process.cwd(),
  opts: { workspace?: string } = {},
): Promise<LocalToolsRegistration> {
  const warnings: string[] = [];
  const fsCfg = (spec as { localTools?: LocalTools }).localTools?.fs;
  if (!fsCfg) return { warnings };

  const toolsFs = await loadToolsFs();
  const workspaceRoot = path.resolve(
    opts.workspace ?? (spec.runtime?.workspace
      ? path.isAbsolute(spec.runtime.workspace)
        ? spec.runtime.workspace
        : path.resolve(cwd, spec.runtime.workspace)
      : cwd),
    fsCfg.workspaceRoot ?? ".",
  );
  const operations = fsCfg.operations;

  toolsFs.registerFsTools({ workspaceRoot, ...(operations ? { operations } : {}) });

  const mutatingToolNames = new Set(toolsFs.MUTATING_FS_OPERATIONS.map((op) => `fs_${op}`));
  const enabledMutating = (operations ?? ["read", "list"]).filter((op) =>
    toolsFs.MUTATING_FS_OPERATIONS.includes(op as (typeof toolsFs.MUTATING_FS_OPERATIONS)[number]),
  );
  if (
    enabledMutating.length > 0 &&
    !hasMutatingFsHook(spec, mutatingToolNames) &&
    !hasPermissionAskOnAgent(spec)
  ) {
    warnings.push(
      `localTools.fs enables mutating operations (${enabledMutating.join(", ")}) without ` +
        `runtime.hooks gating (agent:beforeToolCall + do: interrupt or do: deny) or permission: ask ` +
        `on an agent node. Consider adding approval gates before running in production.`,
    );
  }

  return { warnings };
}
