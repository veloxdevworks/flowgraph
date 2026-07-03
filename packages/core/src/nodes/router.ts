/**
 * Built-in node type: `router`
 *
 * Evaluates branches (top-to-bottom) and returns a Command{ goto } for
 * the first matching route, or the default route.
 */

import { z } from "zod";
import { RouterWithSchema } from "@veloxdevworks/flowgraph-spec";
import { evalGuard, renderDeep } from "@veloxdevworks/flowgraph-expr";
import { defineNode, type CompiledNode, type BuildContext } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import { getProvider, listProviders } from "../providers/registry.js";
import type { AgentRequest, ProviderRunContext } from "../providers/types.js";

const configSchema = RouterWithSchema;
type Config = z.infer<typeof configSchema>;

export const routerNode = defineNode<Config>({
  type: "router",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configSchema: configSchema as any,
  capabilities: { routing: true },

  build(_ctx: BuildContext, nodeSpec: Record<string, unknown>, config: Config): CompiledNode {
    return {
      contract: {},
      capabilities: { routing: true },

      async run(state: Record<string, unknown>, ctx: NodeRunContext): Promise<import("../registry.js").NodeResult> {
        const scope = buildScope(state, ctx);

        if (config.mode === "model") {
          return runModelRouter(config, state, ctx, scope, String(nodeSpec["id"]), nodeSpec["provider"] as string | undefined);
        }

        const routes = Object.entries(config.routes);

        // Find the first matching route
        let matchedTo: string | null = null;
        let matchedKey: string | null = null;

        for (const [key, route] of routes) {
          if (route.default) continue;
          if (route.when) {
            try {
              // Strip {{ }} if present, then evaluate
              const expr = route.when.replace(/^\s*\{\{|\}\}\s*$/g, "").trim();
              if (evalGuard(expr, scope)) {
                matchedTo = route.to;
                matchedKey = key;
                break;
              }
            } catch (err) {
              ctx.logger.warn(`router: error evaluating route "${key}" condition`, {
                when: route.when,
                error: String(err),
              });
            }
          }
        }

        // Fall back to default route
        if (matchedTo === null) {
          const defaultRoute = routes.find(([, r]) => r.default);
          if (defaultRoute) {
            matchedTo = defaultRoute[1].to;
            matchedKey = defaultRoute[0];
          }
        }

        ctx.emit("router.decision", {
          routes: Object.keys(config.routes),
          chosen: matchedKey,
          to: matchedTo,
          mode: config.mode,
        });

        if (matchedTo === null) {
          throw new Error(
            `router "${String(nodeSpec["id"])}" has no matching route and no default route`,
          );
        }

        return {
          command: { goto: matchedTo },
        };
      },
    };
  },
});

function buildScope(
  state: Record<string, unknown>,
  ctx: NodeRunContext,
): Record<string, unknown> {
  return {
    state,
    input: (ctx as NodeRunContext & { _input?: Record<string, unknown> })._input ?? {},
    config: ctx.config,
    run: ctx.meta,
  };
}

/**
 * Model-based routing: ask a provider to pick one of the labeled routes.
 * The chosen key is emitted (router.decision) and, if `output` is set, written
 * to state so downstream branch edges can route on it.
 */
async function runModelRouter(
  config: Config,
  state: Record<string, unknown>,
  ctx: NodeRunContext,
  scope: Record<string, unknown>,
  nodeId: string,
  nodeProvider: string | undefined,
): Promise<import("../registry.js").NodeResult> {
  const providerName = nodeProvider ?? config.provider ?? ctx.config.defaults?.provider ?? (listProviders().includes("mock") ? "mock" : listProviders()[0]);
  if (!providerName) {
    throw new Error(`router "${nodeId}" mode=model: no provider available. Register a provider or set provider/config.defaults.provider.`);
  }
  const provider = getProvider(providerName);
  if (!provider) {
    throw new Error(`router "${nodeId}" mode=model: provider "${providerName}" is not registered. Available: ${listProviders().join(", ") || "(none)"}.`);
  }

  const routeKeys = Object.keys(config.routes).filter((k) => !config.routes[k]?.default);
  const inputText = config.input ? String(renderDeep(config.input, scope)) : JSON.stringify(state);
  const instruction = config.instruction ?? "Choose the single most appropriate route for the input.";
  const prompt =
    `${instruction}\n\nInput:\n${inputText}\n\n` +
    `Available routes: ${routeKeys.join(", ")}.\nReturn the chosen route key.`;

  const req: AgentRequest = {
    prompt,
    tools: [],
    schema: { type: "object", properties: { route: { type: "string", enum: routeKeys } }, required: ["route"] },
    permission: "auto",
  };
  const providerCtx: ProviderRunContext = {
    node: ctx,
    signal: ctx.signal,
    emit: () => {},
    invokeTool: () => Promise.reject(new Error("router model mode does not expose tools")),
    checkToolCall: (_name, args) => Promise.resolve(args),
    reportToolResult: (_name, _args, result) => Promise.resolve(result),
  };

  const result = await provider.run(req, providerCtx);
  const out = result.output as { route?: string } | undefined;
  let chosenKey = out?.route;
  if (!chosenKey || !(chosenKey in config.routes)) {
    // Fall back to the default route's key
    chosenKey = Object.keys(config.routes).find((k) => config.routes[k]?.default);
  }
  if (!chosenKey) {
    throw new Error(`router "${nodeId}" mode=model: provider returned no valid route and no default exists.`);
  }
  const chosen = config.routes[chosenKey];
  if (!chosen) {
    throw new Error(`router "${nodeId}" mode=model: chosen route "${chosenKey}" not found.`);
  }

  ctx.emit("router.decision", { routes: Object.keys(config.routes), chosen: chosenKey, to: chosen.to, mode: "model" });

  const update: Record<string, unknown> = {};
  if (config.output && "to" in config.output) {
    update[config.output.to] = chosenKey;
  }
  return { command: { goto: chosen.to, update } };
}
