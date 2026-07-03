/**
 * Built-in node type: `webhook`
 *
 *  - wait: durable interrupt until an external system resumes with a payload
 *  - emit: outbound HTTP notification (idempotent via ctx.once)
 */

import { z } from "zod";
import { WebhookWithSchema } from "@veloxdevworks/flowgraph-spec";
import { renderDeep } from "@veloxdevworks/flowgraph-expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";

const configSchema = WebhookWithSchema;
type Config = z.infer<typeof configSchema>;

export const webhookNode = defineNode<Config>({
  type: "webhook",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configSchema: configSchema as any,
  capabilities: { interruptible: true, sideEffecting: true },

  build(_ctx: BuildContext, nodeSpec: Record<string, unknown>, config: Config): CompiledNode {
    const mode = config.mode ?? "wait";
    const capabilities =
      mode === "wait" ? { interruptible: true } : { sideEffecting: true };

    return {
      contract: {},
      capabilities,

      async run(state: Record<string, unknown>, ctx: NodeRunContext): Promise<NodeResult> {
        const scope = {
          state,
          input: (ctx as NodeRunContext & { _input?: Record<string, unknown> })._input ?? {},
          config: ctx.config,
          run: ctx.meta,
          secret: new Proxy({} as Record<string, string>, {
            get: (_t, prop) => {
              const val = process.env[String(prop)];
              return val ?? "";
            },
          }),
        };

        if (mode === "emit") {
          return runEmit(nodeSpec, config, scope, ctx);
        }

        return runWait(nodeSpec, config, scope, ctx);
      },
    };
  },
});

async function runWait(
  nodeSpec: Record<string, unknown>,
  config: Config,
  scope: Record<string, unknown>,
  ctx: NodeRunContext,
): Promise<NodeResult> {
  const nodeId = String(nodeSpec["id"] ?? ctx.nodeId);
  const reason = `Waiting for webhook callback on node "${nodeId}"`;

  const payload = ctx.interrupt<unknown>({
    reason,
    kind: "custom",
    data: { mode: "wait", schema: config.schema },
  });

  const result = normalizePayload(payload);
  validateSchema(result, config.schema, nodeId);

  ctx.emit("node.output", { webhook: { mode: "wait", result } });

  return applyOutput(result, config, scope);
}

async function runEmit(
  nodeSpec: Record<string, unknown>,
  config: Config,
  scope: Record<string, unknown>,
  ctx: NodeRunContext,
): Promise<NodeResult> {
  if (!config.url) {
    throw new Error(`webhook node "${String(nodeSpec["id"])}": mode "emit" requires url.`);
  }

  const nodeId = String(nodeSpec["id"] ?? ctx.nodeId);
  const result = await ctx.once(`webhook-emit:${nodeId}`, async () => {
    const url = String(renderDeep(config.url, scope));
    const method = config.method ?? "POST";
    const headers = config.headers
      ? (renderDeep(config.headers, scope) as Record<string, string>)
      : {};
    const body =
      config.body != null ? JSON.stringify(renderDeep(config.body, scope)) : undefined;

    const requestInit: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body !== undefined ? { body } : {}),
      signal: ctx.signal ?? null,
    };

    ctx.logger.debug("webhook emit", { method, url });

    const response = await fetch(url, requestInit);

    if (!response.ok) {
      throw new Error(
        `webhook emit ${method} ${url} returned ${response.status} ${response.statusText}`,
      );
    }

    let responseBody: unknown;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      responseBody = await response.json();
    } else {
      responseBody = await response.text();
    }

    return {
      status: response.status,
      body: responseBody,
      headers: Object.fromEntries(response.headers),
    };
  });

  ctx.emit("node.output", { webhook: { mode: "emit", result } });

  return applyOutput(result, config, scope);
}

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
      `webhook node "${nodeId}": resume payload missing required field(s): ${missing.join(", ")}`,
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
