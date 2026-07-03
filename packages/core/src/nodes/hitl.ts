/**
 * Built-in node type: `hitl`
 *
 * Deterministic human-in-the-loop gate: approval, free-text question, or choice.
 */

import { z } from "zod";
import { HitlWithSchema } from "@veloxdevworks/flowgraph-spec";
import { renderDeep } from "@veloxdevworks/flowgraph-expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { InterruptKind, NodeRunContext } from "../context.js";

const configSchema = HitlWithSchema;
type Config = z.infer<typeof configSchema>;

const MODE_TO_KIND: Record<Config["mode"], InterruptKind> = {
  approve: "approval",
  question: "question",
  choice: "choice",
};

export const hitlNode = defineNode<Config>({
  type: "hitl",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configSchema: configSchema as any,
  capabilities: { interruptible: true },

  build(_ctx: BuildContext, nodeSpec: Record<string, unknown>, config: Config): CompiledNode {
    return {
      contract: {},
      capabilities: { interruptible: true },

      async run(state: Record<string, unknown>, ctx: NodeRunContext): Promise<NodeResult> {
        const scope = {
          state,
          input: (ctx as NodeRunContext & { _input?: Record<string, unknown> })._input ?? {},
          config: ctx.config,
          run: ctx.meta,
        };

        const message = String(renderDeep(config.message, scope));
        const choices = config.choices
          ? (renderDeep(config.choices, scope) as string[])
          : undefined;

        if (config.mode === "choice" && (!choices || choices.length === 0)) {
          throw new Error(`hitl node "${String(nodeSpec["id"])}": mode "choice" requires non-empty choices.`);
        }

        const resume = ctx.interrupt<unknown>({
          reason: message,
          kind: MODE_TO_KIND[config.mode],
          data: { mode: config.mode, choices },
        });

        const result = mapHitlResume(config.mode, resume, choices);

        ctx.emit("node.output", { hitl: { mode: config.mode, result } });

        if (!config.output) return { update: { result } };
        if ("to" in config.output) {
          return { update: { [config.output.to]: result } };
        }
        if ("map" in config.output) {
          const update: Record<string, unknown> = {};
          for (const [channel, expr] of Object.entries(config.output.map)) {
            update[channel] = renderDeep(expr, { result, ...scope });
          }
          return { update };
        }
        return { update: { result } };
      },
    };
  },
});

function mapHitlResume(
  mode: Config["mode"],
  resume: unknown,
  choices?: string[],
): Record<string, unknown> {
  if (mode === "approve") {
    const approved =
      typeof resume === "boolean"
        ? resume
        : (resume as { approved?: boolean })?.approved ?? false;
    return { approved };
  }

  if (mode === "question") {
    const answer =
      typeof resume === "string"
        ? resume
        : (resume as { answer?: string })?.answer ?? String(resume ?? "");
    return { answer };
  }

  // choice
  let choice =
    typeof resume === "string"
      ? resume
      : (resume as { choice?: string })?.choice ?? "";
  if (choices?.length && !choices.includes(choice)) {
    const idx = Number(choice) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < choices.length) {
      choice = choices[idx]!;
    }
  }
  if (choices?.length && !choices.includes(choice)) {
    throw new Error(`Invalid choice "${choice}". Expected one of: ${choices.join(", ")}`);
  }
  return { choice };
}
