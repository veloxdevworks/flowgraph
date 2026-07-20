/**
 * Built-in tools for starting / stopping / restarting background services
 * from an agent tool loop. Services are tracked by the same process-scoped
 * registry as the `service` node, so they inherit auto-cleanup at run end.
 *
 * Opt-in via agent tools:
 *   tools:
 *     - function: start_service
 *     - function: stop_service
 *     - function: restart_service
 */

import { z } from "zod";
import { ServiceReadySchema } from "@veloxdevworks/flowgraph-spec";
import { registerTool } from "./registry.js";
import type { NodeRunContext } from "../context.js";
import {
  startService,
  stopService,
  restartService,
  threadIdOf,
  type ServiceReady,
  type ServiceStartSpec,
  type ServiceInfo,
} from "../runtime/service-manager.js";

const nameSchema = z.object({ name: z.string().min(1) });

const startSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  ready: ServiceReadySchema.optional(),
  readyTimeout: z.string().optional(),
  readyInterval: z.string().optional(),
  stopSignal: z.string().optional(),
  stopTimeout: z.string().optional(),
  keepAlive: z.boolean().optional(),
});

function coerceReady(ready: unknown): ServiceReady | undefined {
  if (!ready || typeof ready !== "object" || Array.isArray(ready)) return undefined;
  const r = ready as Record<string, unknown>;
  if (r.port != null) {
    const port = Number(r.port);
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error(`start_service: ready.port must be a positive number (got ${String(r.port)})`);
    }
    return { port };
  }
  if (typeof r.url === "string") {
    const status = Array.isArray(r.status)
      ? r.status.map((s) => Number(s)).filter((n) => Number.isFinite(n))
      : undefined;
    return status && status.length > 0 ? { url: r.url, status } : { url: r.url };
  }
  if (typeof r.log === "string") {
    return { log: r.log };
  }
  return undefined;
}

function buildSpec(args: unknown, ctx: NodeRunContext): ServiceStartSpec {
  const raw = (args ?? {}) as Record<string, unknown>;
  const parsed = startSchema.parse({
    name: raw.name,
    command: raw.command,
    ...(raw.args !== undefined ? { args: raw.args } : {}),
    ...(raw.cwd !== undefined ? { cwd: raw.cwd } : {}),
    ...(raw.env !== undefined ? { env: raw.env } : {}),
    ...(raw.ready !== undefined ? { ready: raw.ready } : {}),
    ...(raw.readyTimeout !== undefined ? { readyTimeout: raw.readyTimeout } : {}),
    ...(raw.readyInterval !== undefined ? { readyInterval: raw.readyInterval } : {}),
    ...(raw.stopSignal !== undefined ? { stopSignal: raw.stopSignal } : {}),
    ...(raw.stopTimeout !== undefined ? { stopTimeout: raw.stopTimeout } : {}),
    ...(raw.keepAlive !== undefined ? { keepAlive: raw.keepAlive } : {}),
  });

  const ready = coerceReady(parsed.ready);
  const spec: ServiceStartSpec = {
    name: parsed.name,
    command: parsed.command,
    cwd: parsed.cwd ?? ctx.workspace,
    keepAlive: Boolean(parsed.keepAlive),
  };
  if (parsed.args !== undefined) spec.args = parsed.args;
  if (parsed.env !== undefined) spec.env = parsed.env;
  if (ready !== undefined) spec.ready = ready;
  if (parsed.readyTimeout) spec.readyTimeout = parsed.readyTimeout;
  if (parsed.readyInterval) spec.readyInterval = parsed.readyInterval;
  if (parsed.stopSignal) spec.stopSignal = parsed.stopSignal;
  if (parsed.stopTimeout) spec.stopTimeout = parsed.stopTimeout;
  if (ctx.signal) spec.signal = ctx.signal;
  return spec;
}

const startProperties = {
  name: {
    type: "string",
    description: "Stable service id within this run/thread",
  },
  command: {
    type: "string",
    description: "Binary/script, or full shell command when args is omitted",
  },
  args: {
    type: "array",
    items: { type: "string" },
    description: "Argv; when set, runs without a shell",
  },
  cwd: {
    type: "string",
    description: "Working directory (defaults to the graph workspace)",
  },
  env: {
    type: "object",
    additionalProperties: { type: "string" },
    description: "Environment variables for the child process",
  },
  ready: {
    type: "object",
    description:
      "Readiness probe: { port }, { url, status? }, or { log: regex }. " +
      "Node waits until ready (or readyTimeout) before returning.",
  },
  readyTimeout: { type: "string", description: "Default 30s (e.g. '30s', '2m')" },
  readyInterval: { type: "string", description: "Default 300ms" },
  stopSignal: { type: "string", description: "Default SIGTERM" },
  stopTimeout: { type: "string", description: "Default 5s before SIGKILL" },
  keepAlive: {
    type: "boolean",
    description: "When true, skip auto-stop at run end",
  },
} as const;

registerTool({
  name: "start_service",
  description:
    "Start a long-running background service (e.g. vite, API, DB) tracked for this run/thread. " +
    "Idempotent: starting an already-running name is a no-op. " +
    "Auto-stopped when the run completes/errors unless keepAlive is true. " +
    "Governable via permission: ask or agent:beforeToolCall hooks.",
  schema: {
    type: "object",
    properties: startProperties,
    required: ["name", "command"],
  },
  handler: async (args, ctx: NodeRunContext): Promise<ServiceInfo> => {
    const raw = (args ?? {}) as Record<string, unknown>;
    if (typeof raw.name !== "string" || !raw.name.trim()) {
      throw new Error('start_service requires a "name" string argument.');
    }
    if (typeof raw.command !== "string" || !raw.command.trim()) {
      throw new Error('start_service requires a "command" string argument.');
    }
    const spec = buildSpec(args, ctx);
    return startService(threadIdOf(ctx), spec);
  },
});

registerTool({
  name: "stop_service",
  description:
    "Stop a named background service in this run/thread. " +
    "Returns status stopped or not_found.",
  schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Service name previously passed to start_service",
      },
    },
    required: ["name"],
  },
  handler: async (args, ctx: NodeRunContext): Promise<ServiceInfo> => {
    const raw = (args ?? {}) as Record<string, unknown>;
    const name = typeof raw.name === "string" ? raw.name : "";
    if (!name.trim()) {
      throw new Error('stop_service requires a "name" string argument.');
    }
    nameSchema.parse({ name });
    return stopService(
      threadIdOf(ctx),
      name,
      ctx.signal ? { signal: ctx.signal } : {},
    );
  },
});

registerTool({
  name: "restart_service",
  description:
    "Stop (if running) then start a named background service in this run/thread. " +
    "Same arguments as start_service. Auto-stopped at run end unless keepAlive is true.",
  schema: {
    type: "object",
    properties: startProperties,
    required: ["name", "command"],
  },
  handler: async (args, ctx: NodeRunContext): Promise<ServiceInfo> => {
    const raw = (args ?? {}) as Record<string, unknown>;
    if (typeof raw.name !== "string" || !raw.name.trim()) {
      throw new Error('restart_service requires a "name" string argument.');
    }
    if (typeof raw.command !== "string" || !raw.command.trim()) {
      throw new Error('restart_service requires a "command" string argument.');
    }
    const spec = buildSpec(args, ctx);
    return restartService(threadIdOf(ctx), spec);
  },
});
