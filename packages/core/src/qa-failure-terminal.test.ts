import { expect, it } from "vitest";
import { GraphSpecSchema } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { validateSpec } from "./loader.js";
import { createScriptedProvider } from "./providers/index.js";

function graph(nodes: unknown[], edges: unknown[] = [{ from: "START", to: "stop" }]) {
  return GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "failure-terminal" },
    state: { channels: { reason: { type: "string" }, items: { type: "array", default: [1] } } },
    nodes,
    edges,
  });
}
const terminal = { id: "stop", type: "fail", with: { reason: "Rejected: {{ state.reason }}" } };

it("validates a first-class failure terminal without an outgoing END edge", () => {
  expect(validateSpec(graph([terminal]))).not.toContainEqual(
    expect.objectContaining({ code: "UNKNOWN_NODE_TYPE" }),
  );
  expect(validateSpec(graph([terminal]))).not.toContainEqual(
    expect.objectContaining({ code: "NO_PATH_TO_END" }),
  );
});

it("returns an error with the rendered reason and emits a machine-readable failure", async () => {
  const compiled = await compileGraph(graph([terminal]));
  const errors: unknown[] = [];
  compiled.events.subscribe((event) => {
    if (event.type === "run.error") errors.push(event.data);
  });
  const result = await compiled.run({ input: { reason: "policy check" } });
  expect(result.status).toBe("error");
  expect(result.error).toMatchObject({
    code: "FLOW_FAILED",
    message: "Rejected: policy check",
    retryable: false,
  });
  expect(errors).toContainEqual(
    expect.objectContaining({ code: "FLOW_FAILED", reason: "Rejected: policy check" }),
  );
});

it.each(["continue", "route:END"])(
  "cannot turn an intentional failure into success through %s or hooks",
  async (policy) => {
    const spec = GraphSpecSchema.parse({
      ...graph([{ ...terminal, on: { error: policy } }]),
      runtime: {
        retry: { maxAttempts: 3, baseMs: 1 },
        hooks: [{ on: "node:error", do: "continue" }],
      },
    });
    const compiled = await compileGraph(spec);
    const retries: unknown[] = [];
    compiled.events.subscribe((event) => {
      if (event.type === "node.retry") retries.push(event.data);
    });
    const result = await compiled.run({ input: { reason: "deliberate rejection" } });
    expect(result.status).toBe("error");
    expect(result.error).toMatchObject({ code: "FLOW_FAILED" });
    expect(retries).toEqual([]);
  },
);

it("propagates intentional failures out of subgraphs despite parent error recovery", async () => {
  const spec = graph(
    [
      {
        id: "child",
        type: "subgraph",
        on: { error: "continue" },
        spec: graph([{ ...terminal, with: { reason: "child rejected" } }]),
      },
    ],
    [
      { from: "START", to: "child" },
      { from: "child", to: "END" },
    ],
  );
  const result = await (await compileGraph(spec)).run();
  expect(result.status).toBe("error");
  expect(result.error).toMatchObject({ code: "FLOW_FAILED", message: "child rejected" });
});

it("propagates intentional failures out of mapped nodes despite map error recovery", async () => {
  const spec = graph(
    [
      {
        id: "m",
        type: "map",
        on: { error: "continue" },
        with: {
          over: "{{ state.items }}",
          node: { id: "stop", type: "fail", with: { reason: "mapped rejection" } },
        },
      },
    ],
    [
      { from: "START", to: "m" },
      { from: "m", to: "END" },
    ],
  );
  const result = await (await compileGraph(spec)).run();
  expect(result.status).toBe("error");
  expect(result.error).toMatchObject({ code: "FLOW_FAILED", message: "mapped rejection" });
});

it("keeps failure reasons when a terminal is invoked as an agent tool and resumed", async () => {
  const provider = createScriptedProvider("fail-tool", async (_req, ctx) => {
    await ctx.invokeTool("stop", {});
    return { output: "unreachable", stopReason: "done" };
  });
  const spec = graph(
    [
      {
        id: "agent",
        type: "agent",
        provider: "fail-tool",
        with: { prompt: "test", tools: [{ node: "stop" }] },
      },
      { ...terminal, with: { reason: "tool rejected" } },
    ],
    [
      { from: "START", to: "agent" },
      { from: "agent", to: "END" },
    ],
  );
  const compiled = await compileGraph(spec, { providers: [provider] });
  const first = await compiled.run({ threadId: "fail-tool" });
  expect(first.error).toMatchObject({ code: "FLOW_FAILED" });
  const resumed = await compiled.resume({ threadId: "fail-tool", resume: true });
  expect(resumed.error).toMatchObject({ code: "FLOW_FAILED", message: "tool rejected" });
});
