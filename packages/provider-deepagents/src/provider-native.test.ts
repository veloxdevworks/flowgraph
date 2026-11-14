import { beforeEach, expect, it, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { compileGraph, type GraphSpec } from "@flowgraph/core";
import { createDeepAgentsProvider } from "./provider.js";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("deepagents", () => ({ createDeepAgent: () => native }));
beforeEach(() => { native.invoke.mockReset(); });
const spec = { metadata: { name: "native-usage" }, nodes: [{ id: "a", type: "agent", provider: "deepagents", with: { prompt: "answer" } }], edges: [{ from: "START", to: "a" }, { from: "a", to: "END" }] } as unknown as GraphSpec;

it("accounts for native SDK usage instead of silently bypassing the inherited accounting capability", async () => {
  native.invoke.mockResolvedValue({ messages: [new AIMessage({ content: "done", usage_metadata: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } as ConstructorParameters<typeof AIMessage>[0])] });
  const model = { invoke: vi.fn(async () => new AIMessage("fallback")) };
  const g = await compileGraph(spec, { providers: [createDeepAgentsProvider({ model })] });
  expect(await g.run()).toMatchObject({ status: "completed", usage: { calls: 1, totalTokens: 7 } });
  expect(model.invoke).not.toHaveBeenCalled();
});

it("does not hide a non-retryable accounting failure behind another provider call", async () => {
  native.invoke.mockRejectedValue(Object.assign(new Error("accounting unavailable"), { code: "USAGE_WRITE_FAILED", retryable: false }));
  const model = { invoke: vi.fn(async () => new AIMessage("fallback")) };
  const g = await compileGraph(spec, { providers: [createDeepAgentsProvider({ model })] });
  expect(await g.run()).toMatchObject({ status: "error", error: { code: "USAGE_WRITE_FAILED" }, usage: { unknownCalls: 1 } });
  expect(model.invoke).not.toHaveBeenCalled();
});
