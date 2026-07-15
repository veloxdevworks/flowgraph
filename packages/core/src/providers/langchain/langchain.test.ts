import { describe, it, expect } from "vitest";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { compileGraph, registerTool, type GraphSpec } from "../../index.js";
import { createLangChainProvider, type ChatModelLike } from "./index.js";

/** A minimal fake chat model: returns scripted AIMessages in sequence. */
function fakeModel(responses: AIMessage[]): ChatModelLike {
  let i = 0;
  const model: ChatModelLike = {
    async invoke(_input: BaseMessage[]) {
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r!;
    },
    bindTools() {
      return model;
    },
  };
  return model;
}

const spec: GraphSpec = {
  metadata: { name: "lc-graph" },
  state: { channels: { answer: { type: "object" } } },
  nodes: [{ id: "agent", type: "agent", provider: "langchain", with: { prompt: "Hi", output: { to: "answer" } } }],
  edges: [
    { from: "START", to: "agent" },
    { from: "agent", to: "END" },
  ],
  runtime: { checkpoint: { enabled: false } },
} as unknown as GraphSpec;

describe("LangChain provider (built into @veloxdevworks/flowgraph-core)", () => {
  it("returns model text when there are no tool calls", async () => {
    const model = fakeModel([new AIMessage({ content: "All done." })]);
    const provider = createLangChainProvider(model);
    const compiled = await compileGraph(spec, { providers: [provider] });

    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect((r.state["answer"] as { text: string }).text).toBe("All done.");
  });

  it("executes a tool call then finishes (hub & spoke loop)", async () => {
    registerTool({ name: "weather", handler: () => ({ tempF: 72 }) });

    const model = fakeModel([
      new AIMessage({ content: "", tool_calls: [{ name: "weather", args: { city: "SF" }, id: "t1" }] }),
      new AIMessage({ content: "It is 72F in SF." }),
    ]);
    const provider = createLangChainProvider(model);
    const toolSpec = {
      ...spec,
      nodes: [{ id: "agent", type: "agent", provider: "langchain", with: { prompt: "weather?", tools: [{ function: "weather" }], output: { to: "answer" } } }],
    } as unknown as GraphSpec;

    const events: string[] = [];
    const compiled = await compileGraph(toolSpec, { providers: [provider], sinks: [(e) => { events.push(e.type); }] });
    const r = await compiled.run({ input: {} });

    expect(r.status).toBe("completed");
    expect((r.state["answer"] as { text: string }).text).toBe("It is 72F in SF.");
    expect(events).toContain("agent.tool.call");
  });
});
