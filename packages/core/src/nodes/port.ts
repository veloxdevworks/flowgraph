/**
 * Built-in node type: `port`
 *
 * Allocate one or more free TCP ports at run time so downstream `service`
 * nodes (and others) can avoid hardcoding ports that may already be in use.
 *
 * Probe-and-release semantics — see runtime/port.ts for the TOCTOU caveat.
 */

import { z } from "zod";
import { PortWithSchema } from "@veloxdevworks/flowgraph-spec";
import { renderDeep } from "@veloxdevworks/flowgraph-expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import { applyOutput } from "./output.js";
import { findFreePorts } from "../runtime/port.js";

const configSchema = PortWithSchema;
type Config = z.infer<typeof configSchema>;

export const portNode = defineNode<Config>({
  type: "port",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configSchema: configSchema as any,
  capabilities: {},

  build(_ctx: BuildContext, nodeSpec: Record<string, unknown>, config: Config): CompiledNode {
    return {
      contract: {},
      capabilities: {},

      async run(state: Record<string, unknown>, ctx: NodeRunContext): Promise<NodeResult> {
        const scope = {
          state,
          input: (ctx as NodeRunContext & { _input?: Record<string, unknown> })._input ?? {},
          config: ctx.config,
          run: ctx.meta,
        };

        const count = config.count ?? 1;
        const host = config.host
          ? String(renderDeep(config.host, scope))
          : "127.0.0.1";

        let preferred: number | number[] | undefined;
        if (config.preferred !== undefined) {
          const rendered = renderDeep(config.preferred, scope);
          if (Array.isArray(rendered)) {
            preferred = rendered.map((p) => Number(p)).filter((n) => Number.isFinite(n) && n > 0);
          } else {
            const n = Number(rendered);
            if (Number.isFinite(n) && n > 0) preferred = n;
          }
        }

        const ports = await findFreePorts({
          count,
          host,
          ...(preferred !== undefined ? { preferred } : {}),
        });

        const result = {
          port: ports[0]!,
          ports,
          host,
        };

        ctx.emit("node.output", result);
        ctx.logger.debug("allocated ports", result);

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
