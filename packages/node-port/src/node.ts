import { z } from "zod";
import { strictWith } from "@flowgraph/spec";
import { renderDeep } from "@flowgraph/expr";
import {
  applyOutput,
  defineNode,
  type BuildContext,
  type CompiledNode,
  type NodeResult,
  type NodeRunContext,
} from "@flowgraph/core";
import { findFreePorts } from "./port.js";

export const PortWithSchema = strictWith({
  count: z.number().int().positive().optional().default(1),
  preferred: z
    .union([z.number().int().positive(), z.array(z.number().int().positive())])
    .optional()
    .describe("Preferred port(s); falls back to an OS-assigned port when taken"),
  host: z.string().optional().describe("Bind host for the check (default 127.0.0.1)"),
});

export type PortWith = z.infer<typeof PortWithSchema>;

export const portNode = defineNode<PortWith>({
  type: "port",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configSchema: PortWithSchema as any,
  capabilities: {},

  build(_ctx: BuildContext, nodeSpec: Record<string, unknown>, config: PortWith): CompiledNode {
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
        const host = config.host ? String(renderDeep(config.host, scope)) : "127.0.0.1";

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
