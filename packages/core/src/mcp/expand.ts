/**
 * Expand MCP server references into ToolSpecs + executors at run time.
 */

import type { McpHub } from "./types.js";
import type { NodeRunContext } from "../context.js";
import type { ToolSpec } from "../providers/types.js";
import type { NormalizedTools, ToolExecutor } from "../providers/tools.js";

export type McpToolRef = { mcp: string; tools?: string[] | undefined };

/** Agent-visible tool name: server + tool to avoid collisions across servers. */
export function mcpToolName(server: string, tool: string): string {
  return `${server}:${tool}`;
}

export function parseMcpToolName(qualified: string): { server: string; tool: string } | null {
  const idx = qualified.indexOf(":");
  if (idx < 0) return null;
  return { server: qualified.slice(0, idx), tool: qualified.slice(idx + 1) };
}

export function isMcpToolRef(ref: unknown): ref is McpToolRef {
  return (
    typeof ref === "object" &&
    ref !== null &&
    "mcp" in ref &&
    typeof (ref as McpToolRef).mcp === "string"
  );
}

/**
 * Discover tools from MCP servers and build specs/executors for the agent loop.
 */
export async function expandMcpTools(
  refs: McpToolRef[],
  hub: McpHub,
): Promise<NormalizedTools> {
  const specs: ToolSpec[] = [];
  const executors = new Map<string, ToolExecutor>();

  for (const ref of refs) {
    const server = ref.mcp;
    const discovered = await hub.listTools(server);
    const allow = ref.tools;
    const tools = allow?.length
      ? discovered.filter((t) => allow.includes(t.name))
      : discovered;

    for (const t of tools) {
      const name = mcpToolName(server, t.name);
      const spec: ToolSpec = { name, kind: "mcp", ref: `${server}/${t.name}` };
      if (t.description) spec.description = t.description;
      if (t.schema) spec.schema = t.schema;
      specs.push(spec);
      executors.set(name, async (args: unknown, _ctx: NodeRunContext) =>
        hub.callTool(server, t.name, args),
      );
    }
  }

  return { specs, executors };
}

export function requireMcpHub(ctx: NodeRunContext): McpHub {
  if (!ctx.mcp) {
    throw new Error(
      "MCP is not configured for this run. Add mcpServers to the graph spec and run via the CLI, " +
        "or pass compileGraph({ mcp: createMcpHub(...) }).",
    );
  }
  return ctx.mcp;
}
