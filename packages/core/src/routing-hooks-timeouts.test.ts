import { describe, expect, it } from "vitest";
import { GraphSpecSchema, type GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import { createHookBus } from "./hooks/bus.js";
import { runScriptSandboxed } from "./nodes/script.js";
import { effectiveModel } from "./providers/model-choice.js";
import { createScriptedProvider } from "./providers/index.js";

function graph(nodes: unknown[], edges: unknown[], extra: Record<string, unknown> = {}): GraphSpec {
  return GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "routing-contract" },
    state: { channels: { seen: { type: "string" }, n: { type: "number", default: 1 } } },
    nodes,
    edges,
    ...extra,
  });
}

const mark = (id: string) => ({
  id,
  type: "function",
  with: { fn: "routeMark", input: { id }, output: { to: "seen" } },
});

describe("routing", () => {
  it("uses list order, fails a throwing rule, and shares NO_MATCH", async () => {
    registerFunction("routeMark", (input) => (input as { id: string }).id);
    const ordered = graph(
      [
        {
          id: "route",
          type: "router",
          with: {
            routes: [
              { name: "first", when: "{{ true }}", to: "a" },
              { name: "2", when: "{{ true }}", to: "b" },
            ],
          },
        },
        mark("a"),
        mark("b"),
      ],
      [
        { from: "START", to: "route" },
        { from: "a", to: "END" },
        { from: "b", to: "END" },
      ],
    );
    expect((await (await compileGraph(ordered)).run()).state.seen).toBe("a");

    const thrown = graph(
      [
        {
          id: "route",
          type: "router",
          with: {
            routes: [
              { when: "{{ nosuchfn() }}", to: "a" },
              { default: true, to: "b" },
            ],
          },
        },
        mark("a"),
        mark("b"),
      ],
      [
        { from: "START", to: "route" },
        { from: "a", to: "END" },
        { from: "b", to: "END" },
      ],
    );
    const failed = await (await compileGraph(thrown)).run();
    expect(failed.status).toBe("error");
    expect(String(failed.error?.message)).toMatch(/nosuchfn/);

    const none = graph(
      [
        { id: "route", type: "router", with: { routes: [{ when: "{{ false }}", to: "a" }] } },
        mark("a"),
      ],
      [
        { from: "START", to: "route" },
        { from: "a", to: "END" },
      ],
    );
    const missed = await (await compileGraph(none)).run();
    expect(missed.status).toBe("error");
    expect((missed.error as { code?: string }).code).toBe("NO_MATCH");

    const edge = graph(
      [mark("a"), mark("b")],
      [
        { from: "START", to: "a" },
        { from: "a", branch: [{ when: "{{ false }}", to: "b" }] },
        { from: "b", to: "END" },
      ],
    );
    const edgeMiss = await (await compileGraph(edge)).run();
    expect(edgeMiss.status).toBe("error");
    expect((edgeMiss.error as { code?: string }).code).toBe("NO_MATCH");
    expect(edgeMiss.error?.message).toMatch(/Edge "a" has no matching route and no default/);
  });

  it("reads config from a branch guard and input from a node guard", async () => {
    registerFunction("routeMark", (input) => (input as { id: string }).id);
    const spec = graph(
      [
        {
          id: "a",
          type: "function",
          input: { n: "2" },
          when: "input.n == \"2\"",
          with: { fn: "routeMark", input: { id: "ran" }, output: { to: "seen" } },
        },
        mark("b"),
      ],
      [
        { from: "START", to: "a" },
        { from: "a", branch: [{ when: "{{ config.vars.go }}", to: "b" }] },
        { from: "b", to: "END" },
      ],
      { config: { vars: { go: true } } },
    );
    const result = await (await compileGraph(spec)).run();
    expect(result.status).toBe("completed");
    expect(result.state.seen).toBe("b");
  });
});

describe("hooks", () => {
  it("rejects an unknown where key before the handler runs", async () => {
    const bus = createHookBus();
    bus.register({
      phase: "node:before",
      where: { nodeId: "a", typo: true } as { nodeId: string },
      handler: () => ({ kind: "veto", reason: "no" }),
    });
    await expect(bus.run("node:before", { state: {}, run: { runId: "r", graph: "g", startedAt: "" }, payload: { nodeId: "a" } })).rejects.toMatchObject({
      code: "HOOK_WHERE_UNKNOWN",
    });
  });

  it("continues on an error verb and fails even when on.error is continue", async () => {
    registerFunction("routeBoom", () => {
      throw new Error("boom");
    });
    const node = { id: "bad", type: "function", on: { error: "continue" }, with: { fn: "routeBoom" } };
    const edges = [{ from: "START", to: "bad" }, { from: "bad", to: "END" }];
    const continued = await (await compileGraph(graph([node], edges, { runtime: { hooks: [{ on: "node:error", do: "continue" }] } }))).run();
    expect(continued.status).toBe("completed");
    const failed = await (await compileGraph(graph([node], edges, { runtime: { hooks: [{ on: "node:error", do: "fail" }] } }))).run();
    expect(failed.status).toBe("error");
    const denied = await (await compileGraph(graph(
      [{ id: "bad", type: "function", with: { fn: "routeMark", input: { id: "ran" }, output: { to: "seen" } } }],
      edges,
      { runtime: { hooks: [{ on: "node:before", do: "deny" }] } },
    ))).run();
    expect(denied.status).toBe("completed");
    expect(denied.state.seen).toBeNull();
  });
});

describe("timeouts and models", () => {
  it("rejects an already aborted script without waiting", async () => {
    const signal = AbortSignal.abort(new Error("stop"));
    await expect(
      runScriptSandboxed(`export default async function() { await new Promise(() => {}); }`, { signal }),
    ).rejects.toThrow(/stop|Aborted/);
  });

  it("applies the default model only for the default provider", async () => {
    expect(effectiveModel({ model: "node-model", modelSource: "node" }, "provider-model")).toBe("node-model");
    expect(effectiveModel({ model: "default-model", modelSource: "default" }, "provider-model")).toBe("provider-model");
    expect(effectiveModel({ model: "default-model", modelSource: "default" }, undefined)).toBe("default-model");
    const seen: Array<string | undefined> = [];
    const provider = createScriptedProvider("other", (req) => {
      seen.push(req.model);
      return { output: { text: "ok" }, stopReason: "done" };
    });
    const spec = graph(
      [{ id: "ask", type: "agent", provider: "other", with: { prompt: "hi", output: { to: "seen" } } }],
      [{ from: "START", to: "ask" }, { from: "ask", to: "END" }],
      { config: { defaults: { provider: "mock", model: "default-model" } } },
    );
    const result = await (await compileGraph(spec, { providers: [provider] })).run();
    expect(result.status).toBe("completed");
    expect(seen).toEqual([undefined]);
  });
});
