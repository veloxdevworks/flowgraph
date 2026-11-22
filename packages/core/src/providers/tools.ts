/**
 * Normalize tool refs, splitting skill and MCP refs for async expansion at run time.
 */

import type { ToolSpec } from "./types.js";
import type { NodeRunContext } from "../context.js";
import { assertNodeTypeAllowed, assertToolAllowed, BUILTIN_TOOL_TARGETS, nodePolicyOf } from "../node-policy.js";
import { getTool } from "./registry.js";
import { loadResolvedSkill, runSkill } from "../nodes/skill-runner.js";
import {
  isRequiredSkillInput,
  skillInputValueSchema,
  type SkillDef,
  type SkillInputDecl,
} from "@flowgraph/skills";
import type { McpHub } from "../mcp/types.js";
import { isMcpToolRef, type McpToolRef } from "../mcp/expand.js";

export type SkillToolRef = { skill: string };

export type ToolRef =
  | SkillToolRef
  | { node: string }
  | { function: string }
  | { builtin: string[] }
  | McpToolRef;

export type ToolExecutor = (
  args: unknown,
  ctx: NodeRunContext,
  state?: Record<string, unknown>,
) => Promise<unknown>;

export interface NormalizedTools {
  specs: ToolSpec[];
  executors: Map<string, ToolExecutor>;
}

export interface ToolWiring {
  /** Run a sibling graph node as a tool (provided by the compiler). */
  invokeNode?: (
    id: string,
    args: Record<string, unknown>,
    ctx: NodeRunContext,
    state?: Record<string, unknown>,
  ) => Promise<unknown>;
  /** Look up description/schema for a sibling node exposed as a tool. */
  resolveToolMeta?: (nodeId: string) => {
    description?: string;
    schema?: Record<string, unknown>;
  } | undefined;
  /** MCP hub injected by the compiler / CLI. */
  mcp?: McpHub | undefined;
}

/** Build a JSON Schema object describing a skill's declared inputs. */
export function skillInputsSchema(
  inputs: Record<string, SkillInputDecl> | undefined,
): Record<string, unknown> | undefined {
  if (!inputs || Object.keys(inputs).length === 0) return undefined;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, decl] of Object.entries(inputs)) {
    properties[key] = skillInputValueSchema(decl);
    if (isRequiredSkillInput(decl)) required.push(key);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/** Build the ToolSpec exposed to an agent from a loaded SKILL.md definition. */
export function skillToolSpec(skill: SkillDef, ref: string): ToolSpec {
  const name = toolName(skill.frontMatter.name || ref);
  const description = skill.frontMatter.description?.trim();
  const schema = skillInputsSchema(skill.frontMatter.inputs);
  return {
    name,
    kind: "skill",
    ref,
    ...(description ? { description } : {}),
    ...(schema ? { schema } : {}),
  };
}

/**
 * Resolve each skill ref, build its ToolSpec from the skill's description and
 * inputs, and wire its executor.
 */
export async function expandSkillTools(
  refs: SkillToolRef[],
  ctx: NodeRunContext,
): Promise<NormalizedTools> {
  const specs: ToolSpec[] = [];
  const executors = new Map<string, ToolExecutor>();
  for (const ref of refs) {
    assertNodeTypeAllowed(nodePolicyOf(ctx), "skill", `agent tool "${toolName(ref.skill)}"`);
    const skill = await loadResolvedSkill(ref.skill, ctx);
    const spec = skillToolSpec(skill, ref.skill);
    specs.push(spec);
    executors.set(spec.name, async (args, callCtx) => {
      assertNodeTypeAllowed(nodePolicyOf(callCtx), "skill", `agent tool "${spec.name}"`);
      return runSkill(skill, (args ?? {}) as Record<string, unknown>, callCtx);
    });
  }
  return { specs, executors };
}

/**
 * Build ToolSpecs + executors for synchronous refs. Skill and MCP refs are
 * returned separately for async expansion via expandSkillTools() and expandMcpTools().
 */
export function normalizeTools(
  refs: ToolRef[] | undefined,
  wiring: ToolWiring = {},
): { normalized: NormalizedTools; mcpRefs: McpToolRef[]; skillRefs: SkillToolRef[] } {
  const specs: ToolSpec[] = [];
  const executors = new Map<string, ToolExecutor>();
  const mcpRefs: McpToolRef[] = [];
  const skillRefs: SkillToolRef[] = [];
  if (!refs) return { normalized: { specs, executors }, mcpRefs, skillRefs };

  for (const ref of refs) {
    if (isMcpToolRef(ref)) {
      mcpRefs.push(ref);
      continue;
    }
    if ("skill" in ref) {
      skillRefs.push(ref);
      continue;
    }
    if ("function" in ref) {
      const def = getTool(ref.function);
      const spec: ToolSpec = { name: ref.function, kind: "function", ref: ref.function };
      if (def?.description) spec.description = def.description;
      if (def?.schema) spec.schema = def.schema;
      specs.push(spec);
      executors.set(ref.function, async (args, ctx) => {
        assertToolAllowed(nodePolicyOf(ctx), ref.function, `agent tool "${ref.function}"`);
        const d = getTool(ref.function);
        if (!d) throw new Error(`tool function "${ref.function}" is not registered (registerTool).`);
        return d.handler(args, ctx);
      });
    } else if ("node" in ref) {
      const meta = wiring.resolveToolMeta?.(ref.node);
      const spec: ToolSpec = { name: ref.node, kind: "node", ref: ref.node };
      if (meta?.description) spec.description = meta.description;
      if (meta?.schema) spec.schema = meta.schema;
      specs.push(spec);
      executors.set(ref.node, async (args, ctx, state) => {
        if (!wiring.invokeNode) {
          throw new Error(`node-as-tool "${ref.node}" requires compiler wiring (not available in this context).`);
        }
        return wiring.invokeNode(ref.node, (args ?? {}) as Record<string, unknown>, ctx, state ?? {});
      });
    } else if ("builtin" in ref) {
      for (const b of ref.builtin) {
        const mapped = mapBuiltinToRegisteredTool(b);
        if (mapped) {
          const def = getTool(mapped);
          const spec: ToolSpec = {
            name: b,
            kind: "function",
            ref: mapped,
            ...(def?.description ? { description: def.description } : {}),
            ...(def?.schema ? { schema: def.schema } : {}),
          };
          specs.push(spec);
          executors.set(b, async (args, ctx) => {
            assertToolAllowed(nodePolicyOf(ctx), mapped, `agent builtin tool "${b}"`);
            const d = getTool(mapped);
            if (!d) throw new Error(`mapped builtin "${b}" → "${mapped}" is not registered.`);
            return d.handler(args, ctx);
          });
        } else {
          specs.push({ name: b, kind: "builtin", ref: b });
          executors.set(b, () => {
            throw new Error(`builtin tool "${b}" is provider-native; the selected provider must implement it.`);
          });
        }
      }
    }
  }

  return { normalized: { specs, executors }, mcpRefs, skillRefs };
}

/** Merge two NormalizedTools maps (appended specs; executors must not collide). */
export function mergeTools(a: NormalizedTools, b: NormalizedTools): NormalizedTools {
  const executors = new Map(a.executors);
  for (const [k, v] of b.executors) executors.set(k, v);
  return { specs: [...a.specs, ...b.specs], executors };
}

function toolName(ref: string): string {
  const seg = ref.split("/").filter(Boolean).pop() ?? ref;
  return seg.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Map Claude/Cursor-style builtins onto registered localTools.fs handlers when present. */
const BUILTIN_TO_FS = BUILTIN_TOOL_TARGETS;

function mapBuiltinToRegisteredTool(name: string): string | undefined {
  const mapped = BUILTIN_TO_FS[name];
  if (mapped && getTool(mapped)) return mapped;
  return undefined;
}
