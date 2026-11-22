/**
 * McpHub — abstraction for MCP server connections.
 *
 * Implemented by @flowgraph/mcp; core depends only on this interface so the
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
  /**
   * Invoke a tool on a server. `options.signal` aborts when the node times out
   * or the run is cancelled. The hub should cancel the client request.
   */
  callTool(server: string, name: string, args: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  /** Read a resource URI from a server. Honor `options.signal` the same way as `callTool`. */
  readResource(server: string, uri: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  /** Tear down all server connections. */
  close(): Promise<void>;
}
