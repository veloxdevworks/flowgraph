/**
 * Built-in node type: `skill`
 *
 * Loads a SKILL.md, validates the contract, and executes the handler.
 */

import { z } from "zod";
import { SkillWithSchema } from "@veloxdevworks/flowgraph-spec";
import { renderDeep } from "@veloxdevworks/flowgraph-expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import { loadResolvedSkill, runSkill } from "./skill-runner.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const configSchema: any = SkillWithSchema;
type Config = z.infer<typeof SkillWithSchema>;

export const skillNode = defineNode<Config>({
  type: "skill",
  configSchema,
  capabilities: { sideEffecting: true },

  build(_buildCtx: BuildContext, nodeSpec: Record<string, unknown>, config: Config): CompiledNode {
    const uses = String(nodeSpec["uses"] ?? "");

    return {
      contract: {},
      capabilities: { sideEffecting: true },

      async run(state: Record<string, unknown>, runCtx: NodeRunContext): Promise<NodeResult> {
        let skill;
        try {
          skill = await loadResolvedSkill(uses, runCtx);
        } catch (err) {
          throw new Error(`skill node "${String(nodeSpec["id"])}": ${String(err)}`);
        }

        const nodeInput = (runCtx as NodeRunContext & { _input?: Record<string, unknown> })._input ?? {};
        const result = await runSkill(skill, nodeInput, runCtx);

        // Apply output mapping
        const scope = { state, input: nodeInput, config: runCtx.config, run: runCtx.meta };
        if (!config.output) return { update: {} };
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
        return { update: {} };
      },
    };
  },
});
