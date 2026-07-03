/**
 * Built-in node type: `wait`
 *
 *  - duration: fixed delay (in-process sleep)
 *  - signal:   durable wait — interrupts until resumed with the named signal
 *  - until:    re-evaluate a condition; interrupts if not yet satisfied
 */

import { z } from "zod";
import { WaitWithSchema } from "@veloxdevworks/flowgraph-spec";
import { evalGuard } from "@veloxdevworks/flowgraph-expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import { parseDuration, sleep } from "../runtime/duration.js";

const configSchema = WaitWithSchema;
type Config = z.infer<typeof configSchema>;

export const waitNode = defineNode<Config>({
  type: "wait",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configSchema: configSchema as any,
  capabilities: { interruptible: true },

  build(_ctx: BuildContext, _nodeSpec: Record<string, unknown>, config: Config): CompiledNode {
    return {
      contract: {},
      capabilities: { interruptible: true },

      async run(state: Record<string, unknown>, ctx: NodeRunContext): Promise<NodeResult> {
        // Fixed delay
        if (config.duration) {
          const ms = parseDuration(config.duration);
          const wakeAt = new Date(Date.now() + ms).toISOString();
          ctx.logger.debug(`wait: sleeping ${config.duration} (${ms}ms) until ${wakeAt}`);
          ctx.emit("node.output", { wait: { mode: "duration", durationMs: ms, wakeAt } });
          await sleep(ms, ctx.signal);
          return { update: {} };
        }

        // Conditional wait
        if (config.until) {
          const expr = config.until.replace(/^\s*\{\{|\}\}\s*$/g, "").trim();
          const satisfied = evalGuard(expr, { state, config: ctx.config, run: ctx.meta });
          if (satisfied) return { update: {} };
          // Not satisfied — durably pause until external resume re-evaluates
          ctx.interrupt({
            reason: `Waiting for condition: ${config.until}`,
            data: { until: config.until, ...(config.timeout ? { timeout: config.timeout } : {}) },
          });
          return { update: {} };
        }

        // Named signal gate — durable interrupt
        if (config.signal) {
          const payload = ctx.interrupt<unknown>({
            reason: `Waiting for signal: ${config.signal}`,
            data: { signal: config.signal, ...(config.timeout ? { timeout: config.timeout } : {}) },
          });
          // Resume value (if any) is available; surface it as the node output
          return { update: payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {} };
        }

        return { update: {} };
      },
    };
  },
});
