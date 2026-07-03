/**
 * Normalize tool refs, splitting MCP refs for async expansion at run time.
 */

import type { ToolSpec } from "./types.js";
import type { NodeRunContext } from "../context.js";
import { getTool } from "./registry.js";
import { loadResolvedSkill, runSkill } from "../nodes/skill-runner.js";
import type { SkillDef } from "@veloxdevworks/flowgraph-skills";
import type { McpHub } from "../mcp/types.js";
import { isMcpToolRef, type McpToolRef } from "../mcp/expand.js";

export type ToolRef =
  | { skill: string }
  | { node: string }
  | { function: string }
  | { builtin: string[] }
  | McpToolRef;

export type ToolExecutor = (args: unknown, ctx: NodeRunContext) => Promise<unknown>;

export interface NormalizedTools {
  specs: ToolSpec[];
  executors: Map<string, ToolExecutor>;
}

export interface ToolWiring {
  /** Run a sibling graph node as a tool (provided by the compiler). */
  invokeNode?: (id: string, args: Record<string, unknown>, ctx: NodeRunContext) => Promise<unknown>;
  /** MCP hub injected by the compiler / CLI. */
  mcp?: McpHub | undefined;
}

/**
 * Build ToolSpecs + executors for non-MCP refs. MCP refs are returned separately
 * for async expansion via expandMcpTools().
 */
export function normalizeTools(
  refs: ToolRef[] | undefined,
  wiring: ToolWiring = {},
): { normalized: NormalizedTools; mcpRefs: McpToolRef[] } {
  const specs: ToolSpec[] = [];
  const executors = new Map<string, ToolExecutor>();
  const mcpRefs: McpToolRef[] = [];
  if (!refs) return { normalized: { specs, executors }, mcpRefs };

  for (const ref of refs) {
    if (isMcpToolRef(ref)) {
      mcpRefs.push(ref);
      continue;
    }
    if ("function" in ref) {
      const def = getTool(ref.function);
      const spec: ToolSpec = { name: ref.function, kind: "function", ref: ref.function };
      if (def?.description) spec.description = def.description;
      if (def?.schema) spec.schema = def.schema;
      specs.push(spec);
      executors.set(ref.function, async (args, ctx) => {
        const d = getTool(ref.function);
        if (!d) throw new Error(`tool function "${ref.function}" is not registered (registerTool).`);
        return d.handler(args, ctx);
      });
    } else if ("skill" in ref) {
      const name = toolName(ref.skill);
      specs.push({ name, kind: "skill", ref: ref.skill });
      let cached: SkillDef | undefined;
      executors.set(name, async (args, ctx) => {
        cached ??= await loadResolvedSkill(ref.skill, ctx);
        return runSkill(cached, (args ?? {}) as Record<string, unknown>, ctx);
      });
    } else if ("node" in ref) {
      specs.push({ name: ref.node, kind: "node", ref: ref.node });
      executors.set(ref.node, async (args, ctx) => {
        if (!wiring.invokeNode) {
          throw new Error(`node-as-tool "${ref.node}" requires compiler wiring (not available in this context).`);
        }
        return wiring.invokeNode(ref.node, (args ?? {}) as Record<string, unknown>, ctx);
      });
    } else if ("builtin" in ref) {
      for (const b of ref.builtin) {
        specs.push({ name: b, kind: "builtin", ref: b });
        executors.set(b, () => {
          throw new Error(`builtin tool "${b}" is provider-native; the selected provider must implement it.`);
        });
      }
    }
  }

  return { normalized: { specs, executors }, mcpRefs };
}

/** Merge two NormalizedTools maps (MCP tools appended; executors must not collide). */
export function mergeTools(a: NormalizedTools, b: NormalizedTools): NormalizedTools {
  const executors = new Map(a.executors);
  for (const [k, v] of b.executors) executors.set(k, v);
  return { specs: [...a.specs, ...b.specs], executors };
}

function toolName(ref: string): string {
  const seg = ref.split("/").filter(Boolean).pop() ?? ref;
  return seg.replace(/[^a-zA-Z0-9_-]/g, "_");
}
