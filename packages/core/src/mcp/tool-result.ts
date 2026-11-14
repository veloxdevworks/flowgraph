/** MCP application failures are failures even when the transport call succeeds. */
export function assertMcpToolSuccess(result: unknown, server: string, tool: string): unknown {
  if (result && typeof result === "object" && (result as { isError?: unknown }).isError === true) {
    throw Object.assign(new Error(`MCP tool "${server}:${tool}" returned isError`), { code: "MCP_TOOL_ERROR", result });
  }
  return result;
}
