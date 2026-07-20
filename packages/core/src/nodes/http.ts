/**
 * Built-in node type: `http`
 *
 * Makes outbound HTTP requests. Renders {{ }} in URL/headers/body.
 */

import { z } from "zod";
import { HttpWithSchema } from "@veloxdevworks/flowgraph-spec";
import { renderDeep } from "@veloxdevworks/flowgraph-expr";
import { defineNode, type CompiledNode, type BuildContext } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import type { NodeResult } from "../registry.js";
import { applyOutput } from "./output.js";
import { performHttpRequest, redactHeaders } from "./http-request.js";

export { redactHeaders } from "./http-request.js";

const configSchema = HttpWithSchema;
type Config = z.infer<typeof configSchema>;

export const httpNode = defineNode<Config>({
  type: "http",
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
          config: { vars: {} },
          run: ctx.meta,
          secret: new Proxy({} as Record<string, string>, {
            get: (_t, prop) => {
              const val = process.env[String(prop)];
              return val ?? "";
            },
          }),
        };

        // Render all template strings
        const url = String(renderDeep(config.url, scope));
        const method = config.method ?? "GET";
        const headers = config.headers
          ? (renderDeep(config.headers, scope) as Record<string, string>)
          : undefined;
        const renderedBody =
          config.body != null ? renderDeep(config.body, scope) : undefined;
        const query = config.query
          ? (renderDeep(config.query, scope) as Record<string, unknown>)
          : undefined;

        ctx.logger.debug("http request", { method, url });

        const result = await performHttpRequest({
          method,
          url,
          ...(headers ? { headers } : {}),
          ...(query ? { query } : {}),
          ...(renderedBody !== undefined ? { body: renderedBody } : {}),
          ...(config.expect?.status ? { expectStatus: config.expect.status } : {}),
          signal: ctx.signal ?? null,
        });

        ctx.emit("node.output", {
          request: {
            method: result.method,
            url: result.url,
            headers: redactHeaders(result.requestHeaders),
            ...(result.requestBody !== undefined ? { body: result.requestBody } : {}),
          },
          response: {
            status: result.status,
            headers: result.headers,
            body: result.body,
          },
        });

        const out = { status: result.status, body: result.body, headers: result.headers };
        return {
          update: applyOutput(config.output, out, {
            nodeId: String(nodeSpec["id"] ?? ctx.nodeId),
            scope,
          }),
        };
      },
    };
  },
});
