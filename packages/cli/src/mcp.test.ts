import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import { renderMcpServerDefs } from "./mcp.js";

describe("renderMcpServerDefs", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("renders secret templates in stdio env and http headers", () => {
    vi.stubEnv("FGQA_MCP_DECOY", "decoy-mcp-value");
    const defs = renderMcpServerDefs({
      secrets: ["FGQA_MCP_DECOY"],
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
      secrets: ["FGQA_MCP_UNSET"],
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

  it("refuses a secret the graph does not declare", () => {
    vi.stubEnv("FGQA_MCP_DECOY", "decoy-mcp-value");
    expect(() =>
      renderMcpServerDefs({
        secrets: ["FGQA_MCP_OTHER"],
        mcpServers: {
          local: { transport: "stdio", command: "srv", env: { TOKEN: "{{ secret.FGQA_MCP_DECOY }}" } },
        },
      } as unknown as GraphSpec),
    ).toThrow('mcpServers reads secret "FGQA_MCP_DECOY", which the graph does not declare');
  });
});
