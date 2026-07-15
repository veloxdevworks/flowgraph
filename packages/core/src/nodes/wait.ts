/**
 * Built-in node type: `wait`
 *
 *  - duration: fixed delay (in-process sleep)
 *  - signal:   durable wait — interrupts until resumed with the named signal
 *  - until:    re-evaluate a condition; interrupts if not yet satisfied
 *  - webhook:  durable wait — interrupts until an inbound HTTP POST resumes
 */

import { z } from "zod";
import { WaitWithSchema } from "@veloxdevworks/flowgraph-spec";
import { evalGuard, renderDeep } from "@veloxdevworks/flowgraph-expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import { parseDuration, sleep } from "../runtime/duration.js";

const configSchema = WaitWithSchema;
type Config = z.infer<typeof configSchema>;

function webhookSchema(config: Config): Record<string, unknown> | undefined {
  if (config.webhook === true) return undefined;
  if (config.webhook && typeof config.webhook === "object") {
    return config.webhook.schema;
  }
  return undefined;
}

export const waitNode = defineNode<Config>({
  type: "wait",
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

        // Inbound webhook — durable interrupt until HTTP POST resumes
        if (config.webhook) {
          const nodeId = String(nodeSpec["id"] ?? ctx.nodeId);
          const schema = webhookSchema(config);
          const payload = ctx.interrupt<unknown>({
            reason: `Waiting for webhook callback on node "${nodeId}"`,
            kind: "custom",
            data: {
              mode: "webhook",
              ...(schema ? { schema } : {}),
              ...(config.timeout ? { timeout: config.timeout } : {}),
            },
          });

          const result = normalizePayload(payload);
          validateSchema(result, schema, nodeId);
          ctx.emit("node.output", { wait: { mode: "webhook", result } });
          return applyOutput(result, config, scope);
        }

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
            kind: "custom",
            data: {
              mode: "until",
              until: config.until,
              ...(config.timeout ? { timeout: config.timeout } : {}),
            },
          });
          return { update: {} };
        }

        // Named signal gate — durable interrupt
        if (config.signal) {
          const payload = ctx.interrupt<unknown>({
            reason: `Waiting for signal: ${config.signal}`,
            kind: "custom",
            data: {
              mode: "signal",
              signal: config.signal,
              ...(config.timeout ? { timeout: config.timeout } : {}),
            },
          });
          // Resume value (if any) is available; surface it as the node output
          if (config.output) {
            return applyOutput(
              payload && typeof payload === "object" ? payload : { value: payload },
              config,
              scope,
            );
          }
          return { update: payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {} };
        }

        return { update: {} };
      },
    };
  },
});

function normalizePayload(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return { value: payload };
}

/**
 * Lightweight schema check: validates `schema.required` keys only.
 * Full JSON-Schema validation may be added in a future pass.
 */
function validateSchema(
  payload: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
  nodeId: string,
): void {
  if (!schema) return;

  const required = schema["required"];
  if (!Array.isArray(required)) return;

  const missing = (required as string[]).filter(
    (key) => payload[key] === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `wait node "${nodeId}": resume payload missing required field(s): ${missing.join(", ")}`,
    );
  }
}

function applyOutput(
  result: unknown,
  config: Config,
  scope: Record<string, unknown>,
): NodeResult {
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
}
