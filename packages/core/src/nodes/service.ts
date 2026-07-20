/**
 * Built-in node type: `service`
 *
 * Start / stop / restart / status long-running background processes that
 * persist across multiple graph nodes within a run (e.g. vite, API, DB).
 * Tracked by the process-scoped service manager; auto-stopped at run end
 * unless `keepAlive` or `runtime.services.terminateOnEnd: false`.
 */

import { z } from "zod";
import { ServiceWithSchema } from "@veloxdevworks/flowgraph-spec";
import { renderDeep } from "@veloxdevworks/flowgraph-expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import { applyOutput } from "./output.js";
import {
  startService,
  stopService,
  restartService,
  statusService,
  threadIdOf,
  type ServiceReady,
  type ServiceStartSpec,
} from "../runtime/service-manager.js";

const configSchema = ServiceWithSchema;
type Config = z.infer<typeof configSchema>;

function renderReady(ready: Config["ready"], scope: Record<string, unknown>): ServiceReady | undefined {
  if (!ready) return undefined;
  const rendered = renderDeep(ready, scope) as ServiceReady;
  if ("port" in rendered) {
    const port = Number(rendered.port);
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error(`service: ready.port must be a positive number (got ${String(rendered.port)})`);
    }
    return { port };
  }
  if ("url" in rendered) {
    return {
      url: String(rendered.url),
      ...(rendered.status ? { status: rendered.status } : {}),
    };
  }
  if ("log" in rendered) {
    return { log: String(rendered.log) };
  }
  return undefined;
}

function buildStartSpec(config: Config, scope: Record<string, unknown>, ctx: NodeRunContext): ServiceStartSpec {
  if (!config.command) {
    throw new Error(`service node: command is required for action "${config.action ?? "start"}"`);
  }
  const command = String(renderDeep(config.command, scope));
  const args = config.args
    ? config.args.map((a) => String(renderDeep(a, scope)))
    : undefined;
  const cwd = config.cwd ? String(renderDeep(config.cwd, scope)) : ctx.workspace;
  const renderedEnvRaw = config.env
    ? (renderDeep(config.env, scope) as Record<string, string>)
    : undefined;
  const env = renderedEnvRaw
    ? Object.fromEntries(Object.entries(renderedEnvRaw).map(([k, v]) => [k, String(v)]))
    : undefined;
  const ready = renderReady(config.ready, scope);

  const spec: ServiceStartSpec = {
    name: String(renderDeep(config.name, scope)),
    command,
    cwd,
    keepAlive: Boolean(config.keepAlive),
  };
  if (args !== undefined) spec.args = args;
  if (env !== undefined) spec.env = env;
  if (ready !== undefined) spec.ready = ready;
  if (config.readyTimeout) spec.readyTimeout = config.readyTimeout;
  if (config.readyInterval) spec.readyInterval = config.readyInterval;
  if (config.stopSignal) spec.stopSignal = String(renderDeep(config.stopSignal, scope));
  if (config.stopTimeout) spec.stopTimeout = config.stopTimeout;
  if (ctx.signal) spec.signal = ctx.signal;
  return spec;
}

export const serviceNode = defineNode<Config>({
  type: "service",
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
        };

        const name = String(renderDeep(config.name, scope));
        const action = config.action ?? "start";
        const threadId = threadIdOf(ctx);

        ctx.logger.debug("service action", { name, action, threadId });

        let info;
        switch (action) {
          case "start": {
            const spec = buildStartSpec(config, scope, ctx);
            info = await startService(threadId, spec);
            break;
          }
          case "restart": {
            const spec = buildStartSpec(config, scope, ctx);
            info = await restartService(threadId, spec);
            break;
          }
          case "stop": {
            info = await stopService(
              threadId,
              name,
              ctx.signal ? { signal: ctx.signal } : {},
            );
            break;
          }
          case "status": {
            info = statusService(threadId, name);
            break;
          }
          default: {
            const exhaustive: never = action;
            throw new Error(`service node: unknown action ${String(exhaustive)}`);
          }
        }

        const result: Record<string, unknown> = {
          name: info.name,
          action,
          status: info.status,
          keepAlive: info.keepAlive,
          ...(info.pid != null ? { pid: info.pid } : {}),
          ...(info.port != null ? { port: info.port } : {}),
          ...(info.url != null ? { url: info.url } : {}),
          ...(info.startedAt != null ? { startedAt: info.startedAt } : {}),
          ...(info.stoppedAt != null ? { stoppedAt: info.stoppedAt } : {}),
          ...(info.exitCode != null ? { exitCode: info.exitCode } : {}),
        };

        ctx.emit("node.output", result);

        return {
          update: applyOutput(config.output, result, {
            nodeId: String(nodeSpec["id"] ?? ctx.nodeId),
            scope,
          }),
        };
      },
    };
  },
});
