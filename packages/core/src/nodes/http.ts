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

const configSchema = HttpWithSchema;
type Config = z.infer<typeof configSchema>;

/** Header names whose values must never appear in event telemetry. */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "proxy-authorization",
  "x-auth-token",
]);

/** Mask sensitive header values before emitting them in events. */
export function redactHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? "***" : value;
  }
  return out;
}

export const httpNode = defineNode<Config>({
  type: "http",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configSchema: configSchema as any,
  capabilities: { sideEffecting: true },

  build(_ctx: BuildContext, _nodeSpec: Record<string, unknown>, config: Config): CompiledNode {
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
          : {};
        const renderedBody =
          config.body != null ? renderDeep(config.body, scope) : undefined;
        const body =
          renderedBody != null ? JSON.stringify(renderedBody) : undefined;

        // Build query string
        let fullUrl = url;
        if (config.query && Object.keys(config.query).length > 0) {
          const rendered = renderDeep(config.query, scope) as Record<string, unknown>;
          const params = new URLSearchParams(
            Object.entries(rendered).map(([k, v]) => [k, String(v)]),
          ).toString();
          fullUrl = `${url}?${params}`;
        }

        const requestHeaders: Record<string, string> = {
          "Content-Type": "application/json",
          ...headers,
        };

        const requestInit: RequestInit = {
          method,
          headers: requestHeaders,
          ...(body !== undefined ? { body } : {}),
          signal: ctx.signal ?? null,
        };

        ctx.logger.debug("http request", { method, url: fullUrl });

        const response = await fetch(fullUrl, requestInit);

        const allowedStatuses = config.expect?.status ?? [200, 201, 202, 204];
        if (!allowedStatuses.includes(response.status)) {
          throw new Error(
            `HTTP ${method} ${fullUrl} returned ${response.status} ${response.statusText}`,
          );
        }

        let responseBody: unknown;
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          responseBody = await response.json();
        } else {
          responseBody = await response.text();
        }

        const responseHeaders = Object.fromEntries(response.headers);

        ctx.emit("node.output", {
          request: {
            method,
            url: fullUrl,
            headers: redactHeaders(requestHeaders),
            ...(renderedBody !== undefined ? { body: renderedBody } : {}),
          },
          response: {
            status: response.status,
            headers: responseHeaders,
            body: responseBody,
          },
        });

        // Apply output mapping
        const result = { status: response.status, body: responseBody, headers: responseHeaders };
        return applyOutput(result, config, scope, state);
      },
    };
  },
});

function applyOutput(
  result: unknown,
  config: Config,
  _scope: Record<string, unknown>,
  _state: Record<string, unknown>,
): NodeResult {
  if (!config.output) return { update: {} };

  if ("to" in config.output) {
    return { update: { [config.output.to]: result } };
  }

  if ("map" in config.output) {
    const resultObj = result as Record<string, unknown>;
    const update: Record<string, unknown> = {};
    for (const [channel, expr] of Object.entries(config.output.map)) {
      // Simple path traversal for result.* expressions
      const path = expr.replace(/^\{\{\s*|\s*\}\}$/g, "").trim();
      const parts = path.split(".");
      let val: unknown = { result: resultObj };
      for (const part of parts) {
        val = (val as Record<string, unknown>)?.[part] ?? null;
      }
      update[channel] = val;
    }
    return { update };
  }

  return { update: {} };
}
