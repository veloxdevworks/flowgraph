/**
 * McpHub — abstraction for MCP server connections.
 *
 * Implemented by @veloxdevworks/flowgraph-mcp; core depends only on this interface so the
 * SDK stays out of the minimal core dependency graph.
 */

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

export interface McpToolInfo {
  name: string;
  description?: string | undefined;
  schema?: Record<string, unknown> | undefined;
  annotations?: McpToolAnnotations | undefined;
}

export interface McpHub {
  /** List tools exposed by a named server from mcpServers. */
  listTools(server: string): Promise<McpToolInfo[]>;
  /** Invoke a tool on a server. */
  callTool(server: string, name: string, args: unknown): Promise<unknown>;
  /** Read a resource URI from a server. */
  readResource(server: string, uri: string): Promise<unknown>;
  /** Tear down all server connections. */
  close(): Promise<void>;
}
