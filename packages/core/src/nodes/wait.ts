/**
 * Built-in node type: `wait`
 *
 *  - deadline: fixed delay (in-process sleep; not durable across a restart)
 *  - signal:   durable wait — resumes only when the payload names the signal
 *  - until:    re-evaluate a condition; interrupts if not yet satisfied
 *  - webhook:  durable wait — interrupts until an inbound HTTP POST resumes
 */

import { z } from "zod";
import { WaitWithSchema } from "@flowgraph/spec";
import { evalGuard, guardExpression } from "@flowgraph/expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import { parseDuration, sleep } from "../runtime/duration.js";
import { applyOutput } from "./output.js";
import { assertInboundWebhookAllowed, nodePolicyOf } from "../node-policy.js";
import { parseWebhookPayload } from "../runtime/webhook-payload.js";

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
          assertInboundWebhookAllowed(nodePolicyOf(ctx), `wait node "${nodeId}" with.webhook`);
          const schema = webhookSchema(config);
          const payload = ctx.interrupt<unknown>({
            reason: `Waiting for webhook callback on node "${nodeId}"`,
            kind: "custom",
            data: {
              mode: "webhook",
              ...(schema ? { schema } : {}),
              ...(config.timeout
                ? { timeout: config.timeout, deadlineAt: deadlineIso(config.timeout) }
                : {}),
            },
          });

          if (isTimedOut(payload)) {
            const result = { timedOut: true };
            ctx.emit("node.output", { wait: { mode: "webhook", result } });
            return { update: applyOutput(config.output, result, { nodeId, scope }) };
          }

          const result = parseWebhookPayload(payload, schema, nodeId);
          ctx.emit("node.output", { wait: { mode: "webhook", result } });
          return {
            update: applyOutput(config.output, result, { nodeId, scope }),
          };
        }

        // Fixed delay. This sleep does not survive a process restart.
        if (config.deadline) {
          const ms = parseDuration(config.deadline);
          const wakeAt = new Date(Date.now() + ms).toISOString();
          ctx.logger.debug(`wait: sleeping ${config.deadline} (${ms}ms) until ${wakeAt}`);
          ctx.emit("node.output", { wait: { mode: "deadline", durationMs: ms, wakeAt } });
          await sleep(ms, ctx.signal);
          return { update: {} };
        }

        // Conditional wait — re-evaluate after each resume so a later state
        // write (or a retry) can satisfy the guard without a new graph.
        if (config.until) {
          const expr = guardExpression(config.until);
          for (;;) {
            const satisfied = evalGuard(expr, {
              state,
              input: (ctx as NodeRunContext & { _input?: Record<string, unknown> })._input ?? {},
              config: ctx.config,
              run: ctx.meta,
            });
            if (satisfied) return { update: {} };
            const payload = ctx.interrupt({
              reason: `Waiting for condition: ${config.until}`,
              kind: "custom",
              data: {
                mode: "until",
                until: config.until,
                ...(config.timeout
                  ? { timeout: config.timeout, deadlineAt: deadlineIso(config.timeout) }
                  : {}),
              },
            });
            if (isTimedOut(payload)) {
              const result = { timedOut: true };
              ctx.emit("node.output", { wait: { mode: "until", result } });
              return { update: applyOutput(config.output, result, { nodeId: ctx.nodeId, scope }) };
            }
          }
        }

        // Named signal gate — durable interrupt
        if (config.signal) {
          const nodeId = String(nodeSpec["id"] ?? ctx.nodeId);
          for (;;) {
            const payload = ctx.interrupt<unknown>({
              reason: `Waiting for signal: ${config.signal}`,
              kind: "custom",
              data: {
                mode: "signal",
                signal: config.signal,
                ...(config.timeout
                  ? { timeout: config.timeout, deadlineAt: deadlineIso(config.timeout) }
                  : {}),
              },
            });
            if (isTimedOut(payload)) {
              const result = { timedOut: true };
              return {
                update: applyOutput(config.output, result, { nodeId, scope }),
              };
            }
            const taken = signalValue(payload, config.signal);
            if (!taken.matched) {
              ctx.logger.warn(`wait "${nodeId}" ignored a resume that did not name signal "${config.signal}"`);
              continue;
            }
            return {
              update: applyOutput(config.output, taken.value, { nodeId, scope }),
            };
          }
        }

        return { update: {} };
      },
    };
  },
});

function deadlineIso(timeout: string): string {
  return new Date(Date.now() + parseDuration(timeout)).toISOString();
}

function signalValue(payload: unknown, name: string): { matched: true; value: { value: unknown } } | { matched: false } {
  if (typeof payload === "string") {
    return payload === name ? { matched: true, value: { value: payload } } : { matched: false };
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (record.signal !== name) return { matched: false };
    return { matched: true, value: { value: payload } };
  }
  return { matched: false };
}

function isTimedOut(payload: unknown): boolean {
  if (payload === "timedOut") return true;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return (payload as { timedOut?: unknown }).timedOut === true;
  }
  return false;
}
