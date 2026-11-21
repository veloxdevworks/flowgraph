import { describe, expect, it } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "../compiler.js";
import type { RunConfig } from "../context.js";
import { defineProvider } from "../providers/types.js";

function recorder() {
  const seen: (string | undefined)[] = [];
  const provider = defineProvider({
    name: "perm",
    capabilities: { toolCalling: true, structuredOutput: false, streaming: false },
    async run(req) {
      seen.push(req.permission);
      return { output: "ok", stopReason: "done" };
    },
  });
  return { seen, provider };
}

function graph(nodeWith: Record<string, unknown> = {}): GraphSpec {
  return {
    metadata: { name: "agent-permission" },
    nodes: [{ id: "ask", type: "agent", provider: "perm", with: { prompt: "hi", ...nodeWith } }],
    edges: [
      { from: "START", to: "ask" },
      { from: "ask", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

async function permissionFor(spec: GraphSpec, runConfig?: RunConfig): Promise<(string | undefined)[]> {
  const { seen, provider } = recorder();
  const result = await (await compileGraph(spec, { providers: [provider], ...(runConfig ? { runConfig } : {}) })).run();
  expect(result.status).toBe("completed");
  return seen;
}

describe("agent permission default", () => {
  it("is auto when neither the node nor the host sets one", async () => {
    expect(await permissionFor(graph())).toEqual(["auto"]);
  });

  it("comes from the host run config when the node sets none", async () => {
    expect(await permissionFor(graph(), { permission: "ask" })).toEqual(["ask"]);
  });

  it("yields to an explicit node permission", async () => {
    expect(await permissionFor(graph({ permission: "deny" }), { permission: "ask" })).toEqual(["deny"]);
  });

  it("reaches agents inside an embedded subgraph", async () => {
    const parent = {
      metadata: { name: "agent-permission-parent" },
      nodes: [{ id: "sub", type: "subgraph", spec: graph() }],
      edges: [
        { from: "START", to: "sub" },
        { from: "sub", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;
    expect(await permissionFor(parent, { permission: "deny" })).toEqual(["deny"]);
  });
});
