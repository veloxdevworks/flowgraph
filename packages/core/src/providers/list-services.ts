/**
 * Built-in tools for discovering services started by `service` nodes
 * within the current run/thread.
 *
 * Opt-in via agent tools:
 *   tools:
 *     - function: list_services
 *     - function: service_status
 */

import { z } from "zod";
import { registerTool } from "./registry.js";
import type { NodeRunContext } from "../context.js";
import {
  listThreadServices,
  statusService,
  threadIdOf,
} from "../runtime/service-manager.js";

registerTool({
  name: "list_services",
  description:
    "List background services started by `service` nodes in this run/thread. " +
    "Returns name, status, pid, port, url, and startedAt for each tracked service.",
  schema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  handler: (_args, ctx: NodeRunContext) => {
    const services = listThreadServices(threadIdOf(ctx));
    return { services, count: services.length };
  },
});

const statusSchema = z.object({
  name: z.string().min(1),
});

registerTool({
  name: "service_status",
  description:
    "Look up the status of a single named background service in this run/thread. " +
    "Returns status running|stopped|not_found plus pid/port/url when available.",
  schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Service name (the with.name from the service node)",
      },
    },
    required: ["name"],
  },
  handler: (args, ctx: NodeRunContext) => {
    const raw = (args ?? {}) as Record<string, unknown>;
    const name = typeof raw.name === "string" ? raw.name : "";
    if (!name.trim()) {
      throw new Error('service_status requires a "name" string argument.');
    }
    statusSchema.parse({ name });
    return statusService(threadIdOf(ctx), name);
  },
});
