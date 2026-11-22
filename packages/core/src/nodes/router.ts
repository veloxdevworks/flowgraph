/**
 * Built-in node type: `router`
 *
 * Evaluates branches (top-to-bottom) and returns a Command{ goto } for
 * the first matching route, or the default route.
 */

import { z } from "zod";
import { RouterWithSchema } from "@flowgraph/spec";
import { evalGuard, guardExpression, renderDeep, stringifyRendered } from "@flowgraph/expr";
import { defineNode, type CompiledNode, type BuildContext } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import { providerFor, providerNamesFor } from "../providers/registry.js";
import type { AgentRequest, ProviderRunContext } from "../providers/types.js";
import { modelRequest } from "../providers/model-choice.js";
import { applyOutput } from "./output.js";
import { enforceBudget } from "./agent.js";
import type { TokenUsage } from "../providers/types.js";
import { noMatchError, routerGuardError } from "../runtime/routing-policy.js";

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
          return runModelRouter(
            config,
            ctx,
            scope,
            String(nodeSpec["id"]),
            nodeSpec["provider"] as string | undefined,
            typeof nodeSpec["model"] === "string" ? nodeSpec["model"] : undefined,
          );
        }

        const routes = config.routes;
        const routerId = String(nodeSpec["id"]);
        const labels = routes.map((route) => route.name ?? route.to);
        let matchedTo: string | null = null;
        let matchedKey: string | null = null;
        const matched: Array<{ key: string; to: string }> = [];
        let fallback: { key: string; to: string } | undefined;

        for (const route of routes) {
          const key = route.name ?? route.to;
          if (route.default === true) {
            fallback ??= { key, to: route.to };
            continue;
          }
          if (!route.when) continue;
          let hit = false;
          try {
            hit = evalGuard(guardExpression(route.when), scope);
          } catch (err) {
            throw routerGuardError(routerId, route.when, err);
          }
          if (hit) {
            matchedTo = route.to;
            matchedKey = key;
            matched.push({ key, to: route.to });
            if (config.match !== "allMatches") break;
          }
        }

        if (matchedTo === null && fallback) {
          matchedTo = fallback.to;
          matchedKey = fallback.key;
        }

        if (config.match === "allMatches" && matched.length > 0) {
          const to = [...new Set(matched.map((r) => r.to))];
          const chosen = matched.map((r) => r.key);
          ctx.emit("router.decision", { routes: labels, chosen, to, mode: config.mode });
          return { command: { goto: to, update: applyOutput(config.output, chosen, { nodeId: String(nodeSpec["id"]), scope }) } };
        }

        ctx.emit("router.decision", {
          routes: labels,
          chosen: matchedKey,
          to: matchedTo,
          mode: config.mode,
        });

        if (matchedTo === null || matchedKey === null) {
          throw noMatchError(`router "${routerId}"`, routerId);
        }

        const nodeId = String(nodeSpec["id"]);
        const update = applyOutput(config.output, matchedKey, { nodeId, scope });
        return {
          command: { goto: matchedTo, update },
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
  ctx: NodeRunContext,
  scope: Record<string, unknown>,
  nodeId: string,
  nodeProvider: string | undefined,
  nodeModel: string | undefined,
): Promise<import("../registry.js").NodeResult> {
  const providerName = nodeProvider ?? ctx.config.defaults?.provider ?? (providerNamesFor(ctx).includes("mock") ? "mock" : providerNamesFor(ctx)[0]);
  if (!providerName) {
    throw new Error(`router "${nodeId}" mode=model: no provider available. Register a provider or set provider/config.defaults.provider.`);
  }
  const provider = providerFor(ctx, providerName);
  if (!provider) {
    throw new Error(`router "${nodeId}" mode=model: provider "${providerName}" is not registered. Available: ${providerNamesFor(ctx).join(", ") || "(none)"}.`);
  }

  const named = config.routes.filter((route): route is typeof route & { name: string } => !!route.name);
  const routeKeys = named.map((route) => route.name);
  if (!config.input?.trim()) {
    throw new Error(`router "${nodeId}" mode=model requires with.input: the text the model routes on. The router does not send the whole state.`);
  }
  const inputText = stringifyRendered(renderDeep(config.input, scope));
  const instruction = config.instruction ?? "Choose the single most appropriate route for the input.";
  const prompt =
    `${instruction}\n\nInput:\n${inputText}\n\n` +
    `Available routes:\n${named.map((route) => {
      return `- ${route.name}${route.description ? `: ${route.description}` : ""}${route.default ? " (default: choose when no other route fits)" : ""}`;
    }).join("\n")}\nReturn the chosen route key.`;

  const chosenModel = modelRequest(nodeModel, providerName, ctx.config.defaults);
  const req: AgentRequest = {
    prompt,
    tools: [],
    schema: { type: "object", properties: { route: { type: "string", enum: routeKeys } }, required: ["route"], additionalProperties: false },
    permission: "auto",
    ...chosenModel,
  };
  let reportedUsage: TokenUsage = {};
  const providerCtx: ProviderRunContext = {
    ...(ctx.accounting && provider.capabilities.callAccounting ? { meterCall: <T>(invoke: () => Promise<T>, options: import("../usage/ledger.js").MeteredCallOptions<T>) => ctx.accounting!.call(ctx, invoke, options) } : {}),
    node: ctx,
    signal: ctx.signal,
    emit: (type, data) => {
      if (type === "usage") {
        for (const key of ["inputTokens", "outputTokens", "totalTokens", "costUSD"] as const) {
          const value = (data as TokenUsage)[key]; if (value !== undefined) reportedUsage[key] = (reportedUsage[key] ?? 0) + value;
        }
      } else ctx.emit(`agent.${type}` as import("../events.js").EventType, data);
    },
    invokeTool: () => Promise.reject(new Error("router model mode does not expose tools")),
    checkToolCall: (_name, args) => Promise.resolve(args),
    reportToolResult: (_name, _args, result) => Promise.resolve(result),
  };

  const usage = (result: import("../providers/types.js").AgentResult): TokenUsage => Object.fromEntries(
    (["inputTokens", "outputTokens", "totalTokens", "costUSD"] as const).flatMap(key => {
      const value = Math.max(result.usage?.[key] ?? 0, reportedUsage[key] ?? 0);
      return result.usage?.[key] !== undefined || reportedUsage[key] !== undefined ? [[key, value]] : [];
    }),
  );
  const result = ctx.accounting && !provider.capabilities.callAccounting
    ? await ctx.accounting.call(ctx, () => provider.run(req, providerCtx), { kind: "provider", usage, errorUsage: () => reportedUsage, errorOutcomeUnknown: () => true })
    : await provider.run(req, providerCtx);
  if (ctx.accounting) ctx.accounting.enforce(ctx);
  else { const used = usage(result); ctx.emit("agent.usage", used); enforceBudget(ctx, used); }
  const byName = new Map(named.map((route) => [route.name, route]));
  const out = result.output as { route?: string } | undefined;
  let chosen = out?.route ? byName.get(out.route) : undefined;
  if (!chosen) chosen = named.find((route) => route.default === true);
  if (!chosen) {
    throw noMatchError(`router "${nodeId}"`);
  }

  ctx.emit("router.decision", { routes: routeKeys, chosen: chosen.name, to: chosen.to, mode: "model" });

  const update = applyOutput(config.output, chosen.name, { nodeId, scope });
  return { command: { goto: chosen.to, update } };
}
