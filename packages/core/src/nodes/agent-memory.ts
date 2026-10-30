/**
 * Agent-node memory wiring: recall into the prompt (`with.memory.recall`) and
 * the opt-in builtin `remember` tool (`with.memory.agentWrites`).
 */
import { renderDeep } from "@flowgraph/expr";
import type { NodeRunContext } from "../context.js";
import type { NormalizedTools, ToolExecutor } from "../providers/tools.js";
import { ISSUE_CODE } from "../runtime/run-issues.js";
import {
  recallMemory,
  referencedRecallIds,
  type AgentMemoryConfig,
  type RecallResult,
} from "../memory/recall.js";
import { MemoryError, MEMORY_AGENT_WRITES_DEFAULT, type MemoryScopeName } from "../memory/types.js";

export const REMEMBER_TOOL = "remember";

function notConfigured(nodeId: string, what: string): MemoryError {
  return new MemoryError(
    "MEMORY_NOT_CONFIGURED",
    `agent node "${nodeId}" uses ${what} but the graph has no runtime.memory block (or no memory backend)`,
  );
}

/**
 * Run recall for an agent node. Returns undefined when the node declares no
 * recall blocks (the prompt is then byte-identical to a node without memory).
 */
export async function recallForAgent(
  ctx: NodeRunContext,
  config: AgentMemoryConfig | undefined,
  scope: Record<string, unknown>,
  templates: Array<string | undefined>,
): Promise<RecallResult | undefined> {
  if (!config?.recall || config.recall.length === 0) return undefined;
  if (!ctx.memory) throw notConfigured(ctx.nodeId, "with.memory.recall");
  const result = await recallMemory(ctx.memory, config, scope, referencedRecallIds(templates));
  for (const b of result.stats.blocks) {
    if (!b.error) continue;
    ctx.issue({
      code: ISSUE_CODE.MEMORY_RECALL_FAILED,
      severity: "warning",
      message: `memory recall block "${b.id}" skipped: ${b.error}`,
      impact: "The agent ran without this recalled memory.",
      remediation: "Check the memory backend, or set onError: fail to stop instead.",
      detail: { block: b.id },
    });
  }
  ctx.emit("memory.recall", { nodeId: ctx.nodeId, ...result.stats });
  return result;
}

/** Append recalled blocks no template referenced, after the known-issues section. */
export function appendRecallSection(system: string | undefined, recall: RecallResult | undefined): string | undefined {
  if (!recall?.appendix) return system;
  return system ? `${system}\n\n${recall.appendix}` : recall.appendix;
}

// maxPerRun counters, per run invocation (keyed by the run's meta object) and node.
const writeCounts = new WeakMap<object, Map<string, number>>();

function counter(meta: object, nodeId: string) {
  let m = writeCounts.get(meta);
  if (!m) writeCounts.set(meta, (m = new Map()));
  const counts = m;
  return {
    take(max: number): boolean {
      const used = counts.get(nodeId) ?? 0;
      if (used >= max) return false;
      counts.set(nodeId, used + 1);
      return true;
    },
    giveBack(): void {
      counts.set(nodeId, Math.max(0, (counts.get(nodeId) ?? 1) - 1));
    },
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** The builtin `remember` tool, or undefined when agentWrites is not declared. */
export function rememberTool(
  ctx: NodeRunContext,
  config: AgentMemoryConfig | undefined,
  scope: Record<string, unknown>,
): NormalizedTools | undefined {
  const w = config?.agentWrites;
  if (!w) return undefined;
  if (!ctx.memory) throw notConfigured(ctx.nodeId, "with.memory.agentWrites");
  const allowed = [...new Set(w.scopes)];
  const max = w.maxPerRun ?? MEMORY_AGENT_WRITES_DEFAULT;
  const keyPrefix = w.keyPrefix ?? "agent/";
  const fixedAttrs = w.attrs ? (renderDeep(w.attrs, scope) as Record<string, unknown>) : {};
  const count = counter(ctx.meta, ctx.nodeId);

  const exec: ToolExecutor = async (args, runCtx) => {
    const memory = runCtx.memory ?? ctx.memory;
    if (!memory) return { ok: false, error: "MEMORY_NOT_CONFIGURED", message: "memory is not configured" };
    const rec = isPlainObject(args) ? args : {};
    const s = rec["scope"];
    if (typeof s !== "string" || !allowed.includes(s as MemoryScopeName)) {
      return {
        ok: false,
        error: "MEMORY_SCOPE_FORBIDDEN",
        message: `scope must be one of: ${allowed.join(", ")} (got ${JSON.stringify(s ?? null)})`,
      };
    }
    const rawKey = typeof rec["key"] === "string" ? rec["key"].trim() : "";
    if (!rawKey) return { ok: false, error: "MEMORY_KEY_INVALID", message: "key is required" };
    if (!("value" in rec)) return { ok: false, error: "MEMORY_VALUE_REQUIRED", message: "value is required" };
    if (!count.take(max)) {
      return {
        ok: false,
        error: "MEMORY_WRITE_LIMIT",
        message: `remember may be called at most ${max} times per run of this node`,
      };
    }
    const attrs = { ...(isPlainObject(rec["attrs"]) ? rec["attrs"] : {}), ...fixedAttrs };
    const key = rawKey.startsWith(keyPrefix) ? rawKey : `${keyPrefix}${rawKey}`;
    try {
      const r = await memory.put(s as MemoryScopeName, key, rec["value"], {
        ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
        ...(w.ttl ? { ttl: w.ttl } : {}),
      });
      return { ok: true, scope: s, key, version: r.version };
    } catch (err) {
      // Give the write back (nothing was stored) and let the model correct itself.
      count.giveBack();
      if (err instanceof MemoryError) return { ok: false, error: err.code, message: err.message };
      throw err;
    }
  };

  const executors = new Map<string, ToolExecutor>([[REMEMBER_TOOL, exec]]);
  return {
    specs: [
      {
        name: REMEMBER_TOOL,
        kind: "function",
        ref: REMEMBER_TOOL,
        description:
          `Save a durable note to long-term memory for future runs (at most ${max} per run). ` +
          `Use it for facts worth reusing later, such as what fixed a problem or a project convention. ` +
          `Never store secrets, credentials or personal data. Keys are stored under "${keyPrefix}".`,
        schema: {
          type: "object",
          properties: {
            scope: { type: "string", enum: allowed, description: "Where to store it" },
            key: { type: "string", description: "Short stable key, e.g. fix/db-pool-exhausted" },
            value: { description: "The note (string or JSON)" },
            attrs: {
              type: "object",
              description: "Optional scalar tags used for search (e.g. outcome: resolved)",
              additionalProperties: { type: ["string", "number", "boolean", "null"] },
            },
          },
          required: ["scope", "key", "value"],
        },
      },
    ],
    executors,
  };
}
