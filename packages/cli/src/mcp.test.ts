import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import { renderMcpServerDefs } from "./mcp.js";

describe("renderMcpServerDefs", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("renders secret templates in stdio env and http headers", () => {
    vi.stubEnv("FGQA_MCP_DECOY", "decoy-mcp-value");
    const defs = renderMcpServerDefs({
      mcpServers: {
        local: {
          transport: "stdio",
          command: "srv",
          env: { TOKEN: "{{ secret.FGQA_MCP_DECOY }}" },
        },
        remote: {
          transport: "http",
          url: "http://127.0.0.1:1/mcp",
          headers: { Authorization: "Bearer {{ secret.FGQA_MCP_DECOY }}" },
        },
      },
    } as unknown as GraphSpec);
    expect(defs.local).toMatchObject({ env: { TOKEN: "decoy-mcp-value" } });
    expect(defs.remote).toMatchObject({ headers: { Authorization: "Bearer decoy-mcp-value" } });
  });

  it("renders an unset secret as an empty string", () => {
    const defs = renderMcpServerDefs({
      mcpServers: {
        local: {
          transport: "stdio",
          command: "srv",
          env: { TOKEN: "{{ secret.FGQA_MCP_UNSET }}" },
        },
      },
    } as unknown as GraphSpec);
    expect(defs.local).toMatchObject({ env: { TOKEN: "" } });
  });
});
