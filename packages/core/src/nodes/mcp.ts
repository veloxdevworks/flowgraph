/**
 * Built-in node type: `mcp`
 *
 * Deterministic MCP tool call or resource read — no model in the loop.
 */

import { z } from "zod";
import { McpWithSchema } from "@veloxdevworks/flowgraph-spec";
import { renderDeep } from "@veloxdevworks/flowgraph-expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import { requireMcpHub } from "../mcp/expand.js";
import { applyOutput } from "./output.js";

const configSchema = McpWithSchema;
type Config = z.infer<typeof configSchema>;

export const mcpNode = defineNode<Config>({
  type: "mcp",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configSchema: configSchema as any,
  capabilities: { sideEffecting: true },

  build(_ctx: BuildContext, nodeSpec: Record<string, unknown>, config: Config): CompiledNode {
    return {
      contract: {},
      capabilities: { sideEffecting: true },

      async run(state: Record<string, unknown>, ctx: NodeRunContext): Promise<NodeResult> {
        const hub = requireMcpHub(ctx);
        const nodeInput =
          (ctx as NodeRunContext & { _input?: Record<string, unknown> })._input ?? {};
        const scope = { state, input: nodeInput, config: ctx.config, run: ctx.meta };

        if (!config.tool && !config.resource) {
          throw new Error(
            `mcp node "${String(nodeSpec["id"])}": specify with.tool or with.resource.`,
          );
        }

        let result: unknown;
        if (config.tool) {
          const args = config.arguments
            ? (renderDeep(config.arguments, scope) as Record<string, unknown>)
            : {};
          ctx.emit("mcp.tool.call", { server: config.server, tool: config.tool, args });
          result = await hub.callTool(config.server, config.tool, args);
          ctx.emit("mcp.tool.result", { server: config.server, tool: config.tool, result });
        } else {
          const uri = String(renderDeep(config.resource!, scope));
          ctx.emit("mcp.resource.read", { server: config.server, uri });
          result = await hub.readResource(config.server, uri);
        }

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
