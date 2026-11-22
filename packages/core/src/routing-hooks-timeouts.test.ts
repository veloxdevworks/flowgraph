import { describe, expect, it } from "vitest";
import { GraphSpecSchema, type GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import type { FlowgraphEvent } from "./events.js";
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
    state: { channels: { seen: { type: "any" }, n: { type: "number", default: 1 } } },
    nodes,
    edges,
    ...extra,
  });
}

const mark = (id: string) => ({
  id,
  type: "function",
  with: { fn: "routeMark", output: { to: "seen" } }, input: { id },
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

  it("does not swallow or retry a router miss or a throwing rule", async () => {
    registerFunction("routeMark", (input) => (input as { id: string }).id);
    const events: FlowgraphEvent[] = [];
    const miss = graph(
      [
        {
          id: "route",
          type: "router",
          on: { error: "continue" },
          retry: { maxAttempts: 3, backoff: "fixed", baseMs: 1, jitter: false },
          with: { routes: [{ when: "{{ false }}", to: "a" }] },
        },
        mark("a"),
      ],
      [
        { from: "START", to: "route" },
        { from: "a", to: "END" },
      ],
      { runtime: { hooks: [{ on: "node:error", do: "continue" }] } },
    );
    const missed = await (await compileGraph(miss, { sinks: [(event) => { events.push(event); }] })).run();
    expect(missed.status).toBe("error");
    expect(missed.error).toMatchObject({ code: "NO_MATCH", retryable: false });
    expect(missed.issues?.some((issue) => issue.code === "NO_MATCH" && issue.nodeId === "route")).toBe(true);
    expect(events.some((event) => event.type === "node.retry")).toBe(false);
    expect(events.some((event) => event.type === "node.start" && (event.data as { nodeId?: string }).nodeId === "a")).toBe(false);

    const thrown = graph(
      [
        {
          id: "route",
          type: "router",
          on: { error: "continue" },
          retry: { maxAttempts: 3, backoff: "fixed", baseMs: 1, jitter: false },
          with: { routes: [{ when: "{{ nosuchfn() }}", to: "a" }, { default: true, to: "a" }] },
        },
        mark("a"),
      ],
      [
        { from: "START", to: "route" },
        { from: "a", to: "END" },
      ],
      { runtime: { hooks: [{ on: "node:error", do: "continue" }] } },
    );
    const failed = await (await compileGraph(thrown)).run();
    expect(failed.status).toBe("error");
    expect(failed.error).toMatchObject({ code: "ROUTER_GUARD_ERROR", retryable: false });
    expect(failed.issues?.some((issue) => issue.code === "ROUTER_GUARD_ERROR" && issue.nodeId === "route")).toBe(true);
    expect(failed.state.seen ?? null).toBeNull();
  });

  it("cancels an MCP call on timeout so the retry does not overlap it", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const signals: AbortSignal[] = [];
    const spec = graph(
      [
        {
          id: "call",
          type: "mcp",
          timeout: "20ms",
          retry: { maxAttempts: 2, backoff: "fixed", baseMs: 1, jitter: false },
          with: { server: "tools", tool: "lookup" },
        },
      ],
      [
        { from: "START", to: "call" },
        { from: "call", to: "END" },
      ],
    );
    const result = await (await compileGraph(spec, {
      mcp: {
        listTools: async () => [],
        callTool: async (_server, _name, _args, options) => {
          const signal = options?.signal;
          if (!signal) throw new Error("missing signal");
          signals.push(signal);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          try {
            await new Promise((_resolve, reject) => {
              if (signal.aborted) {
                reject(signal.reason);
                return;
              }
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          } finally {
            inFlight -= 1;
          }
          return {};
        },
        readResource: async () => ({}),
        close: async () => {},
      },
    })).run();
    expect(result.status).toBe("error");
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(maxInFlight).toBe(1);
  });

  it("reads config from a branch guard and input from a node guard", async () => {
    registerFunction("routeMark", (input) => (input as { id: string }).id);
    const spec = graph(
      [
        {
          id: "a",
          type: "function",
          input: { id: "ran", n: "2" },
          when: "input.n == \"2\"",
          with: { fn: "routeMark", output: { to: "seen" } },
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
  it("rejects an unknown where key when the hook is registered", () => {
    const bus = createHookBus();
    expect(() => bus.register({
      phase: "node:before",
      where: { nodeId: "a", typo: true } as { nodeId: string },
      handler: () => ({ kind: "veto", reason: "no" }),
    })).toThrow(expect.objectContaining({ code: "HOOK_WHERE_UNKNOWN" }));
  });

  it("rejects removed intelligent:* hook events", () => {
    for (const on of ["intelligent:beforeStep", "intelligent:beforeToolCall", "intelligent:afterToolCall"]) {
      const parsed = GraphSpecSchema.safeParse({
        apiVersion: "flowgraph/v1",
        kind: "Graph",
        metadata: { name: "hooks" },
        nodes: [{ id: "a", type: "function", with: { fn: "x" } }],
        edges: [{ from: "START", to: "a" }, { from: "a", to: "END" }],
        runtime: { hooks: [{ on, do: "deny" }] },
      });
      expect(parsed.success, on).toBe(false);
    }
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
      [{ id: "bad", type: "function", with: { fn: "routeMark", output: { to: "seen" } }, input: { id: "ran" } }],
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
