/**
 * Offline diagnostics for with.context / runtime.context (part of validateSpec).
 */
import type { Diagnostic, GraphSpec } from "@flowgraph/spec";
import { MEMORY_RECALL_DEFAULT_TOKENS } from "../memory/types.js";
import { resolveContextPolicy } from "./policy.js";
import type { ContextConfigInput } from "./types.js";

type Channels = Record<string, { type?: string; reducer?: string }>;

function isMessagesChannel(ch: { type?: string; reducer?: string } | undefined): boolean {
  return !!ch && (ch.type === "messages" || ch.reducer === "messages");
}

function budgetDiagnostics(cfg: ContextConfigInput, reserve: number, path: string, out: Diagnostic[]): void {
  if (
    cfg.maxTokens === undefined &&
    cfg.summarize?.maxTokens === undefined &&
    cfg.toolResultMaxTokens === undefined &&
    cfg.issuesMaxTokens === undefined
  )
    return;
  const p = resolveContextPolicy(undefined, cfg, { outputMaxTokens: reserve })!;
  const usable = p.maxTokens - p.reserveTokens;
  if (usable <= 0) {
    out.push({
      severity: "error",
      code: "CONTEXT_BUDGET_TOO_SMALL",
      message: `context maxTokens ${p.maxTokens} leaves no room after reserving ${p.reserveTokens} tokens for the reply`,
      path: `${path}.maxTokens`,
    });
    return;
  }
  if (p.strategy === "summarize" && p.summarize.maxTokens * 2 >= usable) {
    out.push({
      severity: "error",
      code: "CONTEXT_BUDGET_TOO_SMALL",
      message: `summarize.maxTokens ${p.summarize.maxTokens} must be under half of the usable budget (${usable})`,
      path: `${path}.summarize.maxTokens`,
    });
  }
  if (p.toolResultMaxTokens !== undefined && p.toolResultMaxTokens >= usable) {
    out.push({
      severity: "warning",
      code: "CONTEXT_BUDGET_TOO_SMALL",
      message: `toolResultMaxTokens ${p.toolResultMaxTokens} is not below the usable budget (${usable}); one tool result can overflow the call`,
      path: `${path}.toolResultMaxTokens`,
    });
  }
  if (cfg.issuesMaxTokens !== undefined && cfg.issuesMaxTokens * 2 >= usable) {
    out.push({
      severity: "warning",
      code: "CONTEXT_BUDGET_TOO_SMALL",
      message: `issuesMaxTokens ${cfg.issuesMaxTokens} is half of the usable budget (${usable}) or more; known issues can crowd out history`,
      path: `${path}.issuesMaxTokens`,
    });
  }
}

function unusedDiagnostics(cfg: ContextConfigInput, strategy: string, path: string, out: Diagnostic[]): void {
  if (cfg.lastN !== undefined && strategy !== "last") {
    out.push({ severity: "warning", code: "CONTEXT_OPTION_UNUSED", message: `lastN only applies to strategy: last (strategy is ${strategy})`, path: `${path}.lastN` });
  }
  if (cfg.summarize?.mode === "extract" && (cfg.summarize.provider !== undefined || cfg.summarize.model !== undefined)) {
    out.push({ severity: "warning", code: "CONTEXT_OPTION_UNUSED", message: "summarize.provider / model are ignored with summarize.mode: extract", path: `${path}.summarize` });
  }
  if (cfg.summarize !== undefined && strategy !== "summarize") {
    out.push({ severity: "warning", code: "CONTEXT_OPTION_UNUSED", message: `summarize only applies to strategy: summarize (strategy is ${strategy})`, path: `${path}.summarize` });
  }
}

/** Host-independent context diagnostics. */
export function contextLintDiagnostics(spec: GraphSpec): Diagnostic[] {
  const out: Diagnostic[] = [];
  const defaults = spec.runtime?.context as ContextConfigInput | undefined;
  if (defaults) {
    budgetDiagnostics(defaults, 0, "runtime.context", out);
  }

  const visit = (nodes: Array<Record<string, unknown>>, channels: Channels, path: string, inMap: boolean, graphDefaults: ContextConfigInput | undefined) => {
    for (const node of nodes) {
      const id = String(node["id"] ?? "?");
      const here = `${path}.${id}`;
      const type = String(node["type"] ?? "");
      if (type === "map") {
        const inner = (node["with"] as { node?: Record<string, unknown> } | undefined)?.node;
        if (inner && typeof inner === "object") visit([inner], channels, `${here}.map`, true, graphDefaults);
        continue;
      }
      if (type === "subgraph") {
        const inline = node["spec"] as GraphSpec | undefined;
        if (inline?.nodes) {
          visit(
            inline.nodes as unknown as Array<Record<string, unknown>>,
            (inline.state?.channels ?? {}) as Channels,
            `${here}.subgraph`,
            inMap,
            inline.runtime?.context as ContextConfigInput | undefined,
          );
        }
        continue;
      }
      if (type !== "agent") continue;
      const w = (node["with"] ?? {}) as Record<string, unknown>;
      const ctxCfg = w["context"] as ContextConfigInput | undefined;
      if (!ctxCfg && !graphDefaults) continue;
      const cpath = `${here}.with.context`;
      const merged = { ...(graphDefaults ?? {}), ...(ctxCfg ?? {}) } as ContextConfigInput;
      const outputMax = typeof w["maxTokens"] === "number" ? (w["maxTokens"] as number) : 0;
      const policy = resolveContextPolicy(graphDefaults, ctxCfg, { outputMaxTokens: outputMax })!;

      if (ctxCfg) {
        budgetDiagnostics(merged, outputMax, cpath, out);
        unusedDiagnostics(ctxCfg, policy.strategy, cpath, out);
      }
      if (ctxCfg?.history !== undefined) {
        const ch = channels[ctxCfg.history];
        if (!isMessagesChannel(ch)) {
          out.push({
            severity: "error",
            code: "CONTEXT_HISTORY_CHANNEL",
            message: ch
              ? `with.context.history "${ctxCfg.history}" must be a type: messages channel (it is ${ch.type ?? "untyped"}${ch.reducer ? `, reducer ${ch.reducer}` : ""})`
              : `with.context.history "${ctxCfg.history}" is not a declared state channel; declare it with type: messages`,
            path: `${cpath}.history`,
          });
        }
        if (inMap) {
          out.push({
            severity: "warning",
            code: "CONTEXT_HISTORY_IN_MAP",
            message: "agents inside map read with.context.history but do not write it (items run in parallel)",
            path: `${cpath}.history`,
          });
        }
      } else if (ctxCfg && (ctxCfg.record !== undefined || ctxCfg.compact !== undefined)) {
        out.push({
          severity: "warning",
          code: "CONTEXT_OPTION_UNUSED",
          message: "record and compact only apply with with.context.history",
          path: ctxCfg.record !== undefined ? `${cpath}.record` : `${cpath}.compact`,
        });
      }
      if (w["hub"] === "deepagents") {
        out.push({
          severity: "warning",
          code: "CONTEXT_HUB_UNSUPPORTED",
          message: "hub: deepagents runs its own tool loop; with.context only fits the history and prompt it starts from",
          path: cpath,
        });
      }
      const mem = w["memory"] as { maxTokens?: number; recall?: unknown[] } | undefined;
      if (mem?.recall && mem.recall.length > 0) {
        const want = mem.maxTokens ?? MEMORY_RECALL_DEFAULT_TOKENS;
        const half = Math.floor((policy.maxTokens - policy.reserveTokens) / 2);
        if (want > half) {
          out.push({
            severity: "warning",
            code: "CONTEXT_MEMORY_OVER_BUDGET",
            message: `memory.maxTokens ${want} is over half of the context budget (${half}); recall will be limited to ${Math.max(1, half)} tokens`,
            path: `${here}.with.memory.maxTokens`,
          });
        }
      }
    }
  };
  visit(spec.nodes as unknown as Array<Record<string, unknown>>, (spec.state?.channels ?? {}) as Channels, "nodes", false, defaults);
  return out;
}
