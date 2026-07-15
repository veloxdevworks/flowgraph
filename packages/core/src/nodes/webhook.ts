/**
 * Built-in node type: `webhook`
 *
 * Outbound HTTP notification (idempotent via ctx.once).
 * Inbound waits live on `wait` with `webhook: true`.
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
  capabilities: { sideEffecting: true },

  build(_ctx: BuildContext, nodeSpec: Record<string, unknown>, config: Config): CompiledNode {
    return {
      contract: {},
      capabilities: { sideEffecting: true },

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

        return runEmit(nodeSpec, config, scope, ctx);
      },
    };
  },
});

async function runEmit(
  nodeSpec: Record<string, unknown>,
  config: Config,
  scope: Record<string, unknown>,
  ctx: NodeRunContext,
): Promise<NodeResult> {
  if (!config.url) {
    throw new Error(`webhook node "${String(nodeSpec["id"])}": url is required.`);
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
