import { describe, expect, it } from "vitest";
import { GraphSpecSchema, type GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import { runWithPolicy } from "./runtime/retry.js";

function graph(nodes: unknown[], edges: unknown[], runtime = {}): GraphSpec {
  return GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "routing-qa" },
    state: {
      channels: { seen: { type: "array", reducer: "append" }, n: { type: "number", default: 0 } },
    },
    nodes,
    edges,
    runtime,
  });
}
const fail = (policy?: string) => ({
  id: "fail",
  type: "function",
  with: { fn: "qaPolicyFail" },
  ...(policy ? { on: { error: policy } } : {}),
});
const mark = (id: string) => ({
  id,
  type: "function",
  with: { fn: "qaPolicyMark", input: { id }, output: { to: "seen" } },
});
function register() {
  registerFunction("qaPolicyFail", () => {
    throw new Error("expected failure");
  });
  registerFunction("qaPolicyMark", (input) => [(input as { id: string }).id]);
}

describe("PLAT-300/301: recovery policies", () => {
  it.each(["continue", "ignore"])(
    "honors on.error %s without abandoning siblings",
    async (policy) => {
      register();
      const spec = graph(
        [fail(policy), mark("next"), mark("sibling")],
        [
          { from: "START", to: ["fail", "sibling"] },
          { from: "fail", to: "next" },
          { from: "next", to: "END" },
          { from: "sibling", to: "END" },
        ],
      );
      const r = await (await compileGraph(spec)).run();
      expect(r.status).toBe("completed");
      expect([...(r.state.seen as string[])].sort()).toEqual(["next", "sibling"]);
    },
  );
  it.each(["policy", "hook"])("routes exclusively through a recovery %s", async (kind) => {
    register();
    const spec = graph(
      [fail(kind === "policy" ? "route:recover" : undefined), mark("normal"), mark("recover")],
      [
        { from: "START", to: "fail" },
        { from: "fail", to: "normal" },
        { from: "normal", to: "END" },
        { from: "recover", to: "END" },
      ],
      kind === "hook"
        ? { hooks: [{ on: "node:error", where: { nodeId: "fail" }, do: "route:recover" }] }
        : {},
    );
    const r = await (await compileGraph(spec)).run();
    expect(r.status).toBe("completed");
    expect(r.state.seen).toEqual(["recover"]);
  });
  it("keeps explicit failure fatal", async () => {
    register();
    const r = await (
      await compileGraph(
        graph(
          [fail("fail")],
          [
            { from: "START", to: "fail" },
            { from: "fail", to: "END" },
          ],
        ),
      )
    ).run();
    expect(r.status).toBe("error");
  });
  it.each(["continue", "route:recover"])(
    "honors map error policy %s after admitted siblings finish",
    async (policy) => {
      register();
      registerFunction("qaMapPolicy", (input) => {
        if ((input as { n: number }).n === 1) throw new Error("bad item");
        return "good item";
      });
      const spec = graph(
        [
          {
            id: "fan",
            type: "map",
            on: { error: policy },
            with: {
              over: "{{ [1, 2] }}",
              as: "n",
              node: { type: "function", with: { fn: "qaMapPolicy", input: { n: "{{ item.n }}" } } },
              collect: { to: "seen" },
            },
          },
          mark("normal"),
          ...(policy.startsWith("route:") ? [mark("recover")] : []),
        ],
        [
          { from: "START", to: "fan" },
          { from: "fan", to: "normal" },
          { from: "normal", to: "END" },
          ...(policy.startsWith("route:") ? [{ from: "recover", to: "END" }] : []),
        ],
      );
      const r = await (await compileGraph(spec)).run();
      expect(r.status).toBe("completed");
      expect(r.state.seen).toEqual(["good item", policy === "continue" ? "normal" : "recover"]);
    },
  );
  it("evaluates normal branch edges after committed reducers", async () => {
    register();
    const spec = graph(
      [mark("first"), mark("yes"), mark("no")],
      [
        { from: "START", to: "first" },
        {
          from: "first",
          branch: [
            { when: "{{ len(state.seen) == 1 }}", to: "yes" },
            { default: true, to: "no" },
          ],
        },
        { from: "yes", to: "END" },
        { from: "no", to: "END" },
      ],
      { hooks: [{ on: "node:error", do: "route:no" }] },
    );
    const r = await (await compileGraph(spec)).run();
    expect(r.status).toBe("completed");
    expect(r.state.seen).toEqual(["first", "yes"]);
  });
});

describe("PLAT-303: all matching routes", () => {
  it("fans out to every distinct target and skips the default", async () => {
    register();
    const spec = graph(
      [
        {
          id: "choose",
          type: "router",
          with: {
            match: "allMatches",
            routes: {
              a: { when: "{{ true }}", to: "a" },
              duplicate: { when: "{{ true }}", to: "a" },
              b: { when: "{{ true }}", to: "b" },
              fallback: { default: true, to: "fallback" },
            },
          },
        },
        ...["a", "b", "fallback"].map(mark),
      ],
      [
        { from: "START", to: "choose" },
        ...["a", "b", "fallback"].map((id) => ({ from: id, to: "END" })),
      ],
    );
    const r = await (await compileGraph(spec)).run();
    expect(r.status).toBe("completed");
    expect([...(r.state.seen as string[])].sort()).toEqual(["a", "b"]);
  });
});

describe("PLAT-320: recursion policy", () => {
  function loop(limit?: number, stop = 20) {
    registerFunction("qaPolicyInc", (input) => (input as { n: number }).n + 1);
    return graph(
      [
        {
          id: "tick",
          type: "function",
          with: { fn: "qaPolicyInc", input: { n: "{{ state.n }}" }, output: { to: "n" } },
        },
        {
          id: "route",
          type: "router",
          with: {
            routes: {
              again: { when: `{{ state.n < ${stop} }}`, to: "tick" },
              done: { default: true, to: "END" },
            },
          },
        },
      ],
      [
        { from: "START", to: "tick" },
        { from: "tick", to: "route" },
      ],
      limit ? { recursionLimit: limit } : {},
    );
  }
  it("supports modest capped loops without overriding the default", async () => {
    const r = await (await compileGraph(loop())).run();
    expect(r.status).toBe("completed");
    expect(r.state.n).toBe(20);
  });
  it("attributes an explicit limit to the graph and runtime setting", async () => {
    const r = await (await compileGraph(loop(3))).run();
    expect(r.status).toBe("error");
    expect(r.error).toMatchObject({ code: "RECURSION_LIMIT" });
    expect(r.error?.message).toMatch(/routing-qa.*runtime.recursionLimit.*(?:tick|route)/s);
  });
});

describe("PLAT-348: retry matching", () => {
  it.each([
    ["code 7", "code 75"],
    [429, "status 1429"],
  ])("does not match a longer error token", async (matcher, message) => {
    let calls = 0;
    await expect(
      runWithPolicy(
        async () => {
          calls++;
          throw new Error(String(message));
        },
        { retry: { maxAttempts: 2, baseMs: 1, jitter: false, retryOn: [matcher!] } },
      ),
    ).rejects.toThrow(String(message));
    expect(calls).toBe(1);
  });
  it("matches a structured status before message text", async () => {
    let calls = 0;
    await expect(
      runWithPolicy(
        async () => {
          if (++calls === 1) throw Object.assign(new Error("too many requests"), { status: 429 });
          return "ok";
        },
        { retry: { maxAttempts: 2, baseMs: 1, jitter: false, retryOn: [429] } },
      ),
    ).resolves.toBe("ok");
    expect(calls).toBe(2);
  });
});
