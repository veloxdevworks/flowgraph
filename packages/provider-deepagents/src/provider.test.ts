import { describe, it, expect } from "vitest";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { compileGraph, type GraphSpec } from "@flowgraph/core";
import { createDeepAgentsProvider } from "./provider.js";
import type { ChatModelLike } from "@flowgraph/core";

describe("deepagents hub", () => {
  it("falls back to the LangChain loop and honors the graph model", async () => {
    const model: ChatModelLike = {
      async invoke(_input: BaseMessage[]) {
        return new AIMessage({ content: "from hub" });
      },
      bindTools() {
        return this;
      },
    };
    const provider = createDeepAgentsProvider({ model });
    const spec = {
      metadata: { name: "da" },
      state: { channels: { answer: { type: "object" } } },
      nodes: [
        {
          id: "implement",
          type: "agent",
          provider: "deepagents",
          with: { prompt: "go", hub: "deepagents", output: { to: "answer" } },
        },
      ],
      edges: [
        { from: "START", to: "implement" },
        { from: "implement", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;

    const compiled = await compileGraph(spec, { providers: [provider] });
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect((r.state["answer"] as { text: string }).text).toBe("from hub");
  });
});
