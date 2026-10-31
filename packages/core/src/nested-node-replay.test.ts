import { randomUUID } from "node:crypto";
import { MemorySaver } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph, pendingInterrupts } from "./compiler.js";
import { createLangChainProvider, registerTool } from "./index.js";
import { registerFunction } from "./nodes/function.js";
import { defineProvider } from "./providers/types.js";
import { ReplayMismatchError } from "./providers/replay-cache.js";
import "./nodes/index.js";

// Interrupt and resume for every way a node runs inside another node's
// execution (subgraph child, map item, node called as an agent tool), nested
// through tool calls. Each case checks that every side effect happens once,
// that an approval goes to the call the approver was shown, and that model
// turns already made are not made again.

const ran: string[] = [];
beforeAll(() => {
  registerTool({
    name: "fg_nested_record",
    description: "records a tag",
    handler: (args) => {
      const tag = String((args as { tag?: unknown }).tag);
      ran.push(tag);
      return { ran: tag };
    },
  });
  registerFunction("fg_nested_noop", () => ({}));
  registerFunction("fg_nested_mark", () => {
    ran.push("W");
    return { marked: true };
  });
});
beforeEach(() => {
  ran.length = 0;
});

type Call = { name: string; args: Record<string, unknown> };
type Turn = string | Call | Call[];

/** A scripted model; `script(n, prompt)` gives live turn `n`. */
function scripted(name: string, script: (n: number, prompt: string) => Turn) {
  let n = 0;
  const provider = createLangChainProvider(
    {
      invoke: async (messages: unknown) => {
        const turn = script(n++, JSON.stringify(messages));
        if (typeof turn === "string") return new AIMessage({ content: turn });
        const calls = Array.isArray(turn) ? turn : [turn];
        return new AIMessage({ content: "", tool_calls: calls.map((c, i) => ({ name: c.name, id: `${name}-${n}-${i}`, args: c.args })) });
      },
      bindTools() {
        return this;
      },
    } as never,
    { name },
  );
  return { provider, calls: () => n };
}

const rec = (tag: string): Call => ({ name: "fg_nested_record", args: { tag } });
const call = (name: string, args: Record<string, unknown> = {}): Call => ({ name, args });
/** Turns in order, then `done`. */
const turns = (...list: Turn[]) => (n: number) => list[n] ?? "done";
/** Records the `which=` value of its prompt, then finishes. */
const echo = (_n: number, prompt: string): Turn =>
  prompt.includes("ToolMessage") ? "done" : rec(/which=(\w+)/.exec(prompt)?.[1] ?? "?");

type Node = Record<string, unknown>;

/** `routed` run START → … → END; `tools` are tool targets only (never routed to). */
function graphOf(name: string, routed: Node[], tools: Node[] = [], channels: Record<string, unknown> = {}) {
  const gate = { id: "gate", type: "function", when: "false", with: { fn: "fg_nested_noop" } };
  const ids = routed.map((n) => String(n["id"]));
  const edges: Array<{ from: string; to: string }> = [{ from: "START", to: ids[0]! }];
  for (let i = 1; i < ids.length; i++) edges.push({ from: ids[i - 1]!, to: ids[i]! });
  edges.push({ from: ids[ids.length - 1]!, to: "END" });
  if (tools.length > 0) {
    edges.push({ from: "START", to: "gate" });
    for (const t of tools) edges.push({ from: "gate", to: String(t["id"]) }, { from: String(t["id"]), to: "END" });
  }
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name },
    state: { channels: { out: { type: "object" }, items: { type: "array" }, ...channels } },
    nodes: [...routed, ...tools.map((t) => ({ ...t, when: "false" })), ...(tools.length > 0 ? [gate] : [])],
    edges,
  } as unknown as GraphSpec;
}

const agent = (id: string, provider: string, tools: unknown[] = [{ function: "fg_nested_record" }], extra: Node = {}): Node => ({
  id,
  type: "agent",
  provider,
  with: { prompt: `${id} go`, tools, ...extra },
});
const ask = (id: string, provider: string, prompt = `${id} work`): Node => agent(id, provider, [{ function: "fg_nested_record" }], { permission: "ask", prompt });
const sub = (id: string, child: GraphSpec, extra: Node = {}): Node => ({ id, type: "subgraph", spec: child, with: { output: "none", ...extra } });
const hitl = (id: string): Node => ({ id, type: "hitl", with: { mode: "approve", message: "ok?" } });
const mark = (id: string): Node => ({ id, type: "function", with: { fn: "fg_nested_mark" } });
const map = (id: string, inner: Node, over = "{{ state.items }}"): Node => ({ id, type: "map", with: { over, node: inner } });

/** Approve every interrupt until the run ends, compiling afresh for each resume. */
async function approveAll(spec: GraphSpec, providers: unknown[], input: Record<string, unknown> = {}) {
  const saver = new MemorySaver();
  const compile = () => compileGraph(spec, { checkpointer: saver, providers: providers as never });
  const threadId = `nested-${randomUUID()}`;
  const shown: string[] = [];
  const note = (res: { interrupts?: unknown }) => {
    for (const m of JSON.stringify(res.interrupts ?? []).matchAll(/"tool":"fg_nested_record","args":\{"tag":"([^"]+)"/g)) shown.push(m[1]!);
  };
  let res = await (await compile()).run({ input, threadId, onInterrupt: "fail" });
  let resumes = 0;
  for (; resumes < 12 && res.status === "interrupted"; resumes++) {
    note(res);
    res = await (await compile()).resume({ threadId, resume: true, onInterrupt: "fail" });
  }
  return { status: res.status, shown, resumes, res };
}

describe("interrupts below a node called as an agent tool", () => {
  it("a subgraph tool whose child agent asks twice, after a side effect of the calling agent", async () => {
    const outer = scripted("outer", turns([rec("PRE"), call("t")]));
    const inner = scripted("inner", turns(rec("A"), rec("B")));
    const child = graphOf("child", [ask("a", "inner")]);
    const spec = graphOf("sg-tool", [agent("o", "outer", [{ function: "fg_nested_record" }, { node: "t" }])], [sub("t", child)]);
    const r = await approveAll(spec, [outer.provider, inner.provider]);
    expect(r.status).toBe("completed");
    expect(r.shown).toEqual(["A", "B"]);
    expect(ran).toEqual(["PRE", "A", "B"]);
    expect([outer.calls(), inner.calls()]).toEqual([2, 3]);
  });

  it("a map inside a subgraph tool", async () => {
    const outer = scripted("outer", turns([rec("PRE"), call("t", { items: ["x"] })]));
    const inner = scripted("inner", echo);
    const child = graphOf("child", [map("m", ask("w", "inner", "which={{ item.item }}"))]);
    const spec = graphOf("map-in-tool", [agent("o", "outer", [{ function: "fg_nested_record" }, { node: "t" }])], [sub("t", child)]);
    const r = await approveAll(spec, [outer.provider, inner.provider]);
    expect(r.status).toBe("completed");
    expect(r.shown).toEqual(["x"]);
    expect(ran).toEqual(["PRE", "x"]);
    expect([outer.calls(), inner.calls()]).toEqual([2, 2]);
  });

  it("two map items inside a subgraph tool each ask", async () => {
    const outer = scripted("outer", turns([rec("PRE"), call("t", { items: ["x", "y"] })]));
    const inner = scripted("inner", echo);
    const child = graphOf("child", [map("m", ask("w", "inner", "which={{ item.item }}"))]);
    const spec = graphOf("map2-in-tool", [agent("o", "outer", [{ function: "fg_nested_record" }, { node: "t" }])], [sub("t", child)]);
    const r = await approveAll(spec, [outer.provider, inner.provider]);
    expect(r.status).toBe("completed");
    // Both items wait at once; one resume answers both.
    for (const tag of r.shown) expect(["x", "y"]).toContain(tag);
    expect(ran[0]).toBe("PRE");
    expect([...ran].sort()).toEqual(["PRE", "x", "y"]);
    expect([outer.calls(), inner.calls()]).toEqual([2, 4]);
  });

  it("an agent tool inside a subgraph tool", async () => {
    const outer = scripted("outer", turns([rec("PRE"), call("t")]));
    const mid = scripted("mid", turns([rec("MID"), call("h")]));
    const leaf = scripted("leaf", turns(rec("A"), rec("B")));
    const child = graphOf("child", [agent("c", "mid", [{ function: "fg_nested_record" }, { node: "h" }])], [ask("h", "leaf")]);
    const spec = graphOf("agent-in-sg-tool", [agent("o", "outer", [{ function: "fg_nested_record" }, { node: "t" }])], [sub("t", child)]);
    const r = await approveAll(spec, [outer.provider, mid.provider, leaf.provider]);
    expect(r.status).toBe("completed");
    expect(r.shown).toEqual(["A", "B"]);
    expect(ran).toEqual(["PRE", "MID", "A", "B"]);
    expect([outer.calls(), mid.calls(), leaf.calls()]).toEqual([2, 2, 3]);
  });

  it("a hitl node inside a subgraph tool", async () => {
    const outer = scripted("outer", turns([rec("PRE"), call("t")], rec("POST")));
    const child = graphOf("child", [hitl("ok"), mark("w")]);
    const spec = graphOf("hitl-in-sg-tool", [agent("o", "outer", [{ function: "fg_nested_record" }, { node: "t" }])], [sub("t", child)]);
    const r = await approveAll(spec, [outer.provider]);
    expect(r.status).toBe("completed");
    expect(r.resumes).toBe(1);
    expect(ran).toEqual(["PRE", "W", "POST"]);
    expect(outer.calls()).toBe(3);
  });

  it("a hitl node called as a tool", async () => {
    const outer = scripted("outer", turns([rec("PRE"), call("ok")], rec("POST")));
    const spec = graphOf("hitl-tool", [agent("o", "outer", [{ function: "fg_nested_record" }, { node: "ok" }])], [hitl("ok")]);
    const r = await approveAll(spec, [outer.provider]);
    expect(r.status).toBe("completed");
    expect(r.resumes).toBe(1);
    expect(ran).toEqual(["PRE", "POST"]);
    expect(outer.calls()).toBe(3);
  });

  it("a node:before hook interrupt inside a subgraph tool", async () => {
    const outer = scripted("outer", turns([rec("PRE"), call("t")]));
    const child = { ...graphOf("child", [mark("w")]), runtime: { hooks: [{ on: "node:before", do: "interrupt", reason: "check" }] } } as unknown as GraphSpec;
    const spec = graphOf("hook-in-sg-tool", [agent("o", "outer", [{ function: "fg_nested_record" }, { node: "t" }])], [sub("t", child)]);
    const r = await approveAll(spec, [outer.provider]);
    expect(r.status).toBe("completed");
    expect(r.resumes).toBe(1);
    expect(ran).toEqual(["PRE", "W"]);
    expect(outer.calls()).toBe(2);
  });

  it("a subgraph tool called by an agent inside a subgraph", async () => {
    const outer = scripted("outer", turns([rec("PRE"), call("t")]));
    const inner = scripted("inner", turns(rec("A"), rec("B")));
    const toolChild = graphOf("tool-child", [ask("a", "inner")]);
    const child = graphOf("child", [agent("o", "outer", [{ function: "fg_nested_record" }, { node: "t" }])], [sub("t", toolChild)]);
    const spec = graphOf("sg-tool-in-sg", [sub("s", child)]);
    const r = await approveAll(spec, [outer.provider, inner.provider]);
    expect(r.status).toBe("completed");
    expect(r.shown).toEqual(["A", "B"]);
    expect(ran).toEqual(["PRE", "A", "B"]);
    expect([outer.calls(), inner.calls()]).toEqual([2, 3]);
  });

  it("a node tool called by a map item agent", async () => {
    const outer = scripted("outer", turns([rec("PRE"), call("h")]));
    const inner = scripted("inner", turns(rec("A"), rec("B")));
    const spec = graphOf("tool-in-map", [map("m", agent("o", "outer", [{ function: "fg_nested_record" }, { node: "h" }]))], [ask("h", "inner")]);
    const r = await approveAll(spec, [outer.provider, inner.provider], { items: ["x"] });
    expect(r.status).toBe("completed");
    expect(r.shown).toEqual(["A", "B"]);
    expect(ran).toEqual(["PRE", "A", "B"]);
    expect([outer.calls(), inner.calls()]).toEqual([2, 3]);
  });

  it("a subgraph tool inside a map item inside a subgraph", async () => {
    const outer = scripted("outer", turns([rec("PRE"), call("t")]));
    const inner = scripted("inner", turns(rec("A")));
    const toolChild = graphOf("tool-child", [ask("a", "inner")]);
    const item = graphOf("item", [agent("o", "outer", [{ function: "fg_nested_record" }, { node: "t" }])], [sub("t", toolChild)]);
    const child = graphOf("child", [map("m", sub("each", item))]);
    const spec = graphOf("deep", [sub("s", child, { stateMap: { in: { items: "items" } } })]);
    const r = await approveAll(spec, [outer.provider, inner.provider], { items: ["x"] });
    expect(r.status).toBe("completed");
    expect(r.shown).toEqual(["A"]);
    expect(ran).toEqual(["PRE", "A"]);
    expect([outer.calls(), inner.calls()]).toEqual([2, 2]);
  });

  it("a subgraph tool called by an agent tool", async () => {
    const outer = scripted("outer", turns([rec("PRE"), call("h")]));
    const mid = scripted("mid", turns([rec("MID"), call("t")]));
    const inner = scripted("inner", turns(rec("A"), rec("B")));
    const child = graphOf("child", [ask("a", "inner")]);
    const spec = graphOf(
      "sg-tool-in-agent-tool",
      [agent("o", "outer", [{ function: "fg_nested_record" }, { node: "h" }])],
      [agent("h", "mid", [{ function: "fg_nested_record" }, { node: "t" }]), sub("t", child)],
    );
    const r = await approveAll(spec, [outer.provider, mid.provider, inner.provider]);
    expect(r.status).toBe("completed");
    expect(r.shown).toEqual(["A", "B"]);
    expect(ran).toEqual(["PRE", "MID", "A", "B"]);
    expect([outer.calls(), mid.calls(), inner.calls()]).toEqual([2, 2, 3]);
  });

  it("a subgraph inside a subgraph tool", async () => {
    const outer = scripted("outer", turns([rec("PRE"), call("t")]));
    const inner = scripted("inner", turns(rec("A"), rec("B")));
    const child = graphOf("child", [sub("inner", graphOf("grandchild", [ask("a", "inner")]))]);
    const spec = graphOf("sg-in-sg-tool", [agent("o", "outer", [{ function: "fg_nested_record" }, { node: "t" }])], [sub("t", child)]);
    const r = await approveAll(spec, [outer.provider, inner.provider]);
    expect(r.status).toBe("completed");
    expect(r.shown).toEqual(["A", "B"]);
    expect(ran).toEqual(["PRE", "A", "B"]);
    expect([outer.calls(), inner.calls()]).toEqual([2, 3]);
  });

  it("the same subgraph tool called twice in one turn", async () => {
    const outer = scripted("outer", turns([rec("PRE"), call("t", { which: "x" }), call("t", { which: "y" })]));
    const inner = scripted("inner", echo);
    const child = graphOf("child", [ask("a", "inner", "which={{ state.which }}")], [], { which: { type: "string" } });
    const spec = graphOf("sg-tool-twice", [agent("o", "outer", [{ function: "fg_nested_record" }, { node: "t" }])], [sub("t", child)]);
    const r = await approveAll(spec, [outer.provider, inner.provider]);
    expect(r.status).toBe("completed");
    expect(r.shown).toEqual(["x", "y"]);
    expect(r.resumes).toBe(2);
    expect(ran).toEqual(["PRE", "x", "y"]);
    expect([outer.calls(), inner.calls()]).toEqual([2, 4]);
  });

  it("an asking agent whose approved call is a subgraph tool that asks", async () => {
    const outer = scripted("outer", turns([call("t")]));
    const inner = scripted("inner", turns(rec("A")));
    const child = graphOf("child", [ask("a", "inner")]);
    const spec = graphOf("asking-agent-sg-tool", [agent("o", "outer", [{ function: "fg_nested_record" }, { node: "t" }], { permission: "ask" })], [sub("t", child)]);
    const r = await approveAll(spec, [outer.provider, inner.provider]);
    expect(r.status).toBe("completed");
    expect(r.resumes).toBe(2);
    expect(r.shown).toEqual(["A"]);
    expect(ran).toEqual(["A"]);
    expect([outer.calls(), inner.calls()]).toEqual([2, 2]);
  });

  it("refuses a map node as a tool with a clear error", async () => {
    const outer = scripted("outer", turns(call("m")));
    const spec = graphOf("map-tool", [agent("o", "outer", [{ node: "m" }])], [map("m", mark("w"))]);
    const g = await compileGraph(spec, { checkpointer: new MemorySaver(), providers: [outer.provider] });
    const res = await g.run({ input: {}, threadId: `nested-${randomUUID()}`, onInterrupt: "fail" });
    expect(res.status).toBe("error");
    expect(String((res.error as Error | undefined)?.message)).toMatch(/map node "m" cannot be called as a tool/);
  });
});

describe("a replayed tool result is only reused for the same call", () => {
  // A provider that does not replay its own turns (like an SDK agent) and
  // asks for different arguments after the resume.
  function drifting(name: string) {
    let execution = 0;
    return defineProvider({
      name,
      capabilities: { toolCalling: true, structuredOutput: false, streaming: false },
      async run(_req, ctx) {
        const tag = execution++ < 2 ? "A" : "Z";
        await ctx.invokeTool("fg_nested_record", { tag });
        try {
          await ctx.invokeTool("fg_nested_record", { tag: "SECOND" });
        } catch (err) {
          // Hand errors back to the "model", as SDK tool callbacks do.
          if (err instanceof ReplayMismatchError) return { output: "swallowed", stopReason: "done" };
          throw err;
        }
        return { output: "ok", stopReason: "done" };
      },
    });
  }

  it("fails the resume instead of giving the result to a different call", async () => {
    const spec = graphOf("drift", [ask("a", "drift")]);
    const saver = new MemorySaver();
    const provider = drifting("drift");
    const threadId = `drift-${randomUUID()}`;
    const compile = () => compileGraph(spec, { checkpointer: saver, providers: [provider] as never });
    let res = await (await compile()).run({ input: {}, threadId, onInterrupt: "fail" });
    expect(res.status).toBe("interrupted");
    res = await (await compile()).resume({ threadId, resume: true, onInterrupt: "fail" });
    expect(res.status).toBe("interrupted");
    expect(ran).toEqual(["A"]);
    // The model now asks for Z first; A's saved result must not answer it.
    const err = await (await compile()).resume({ threadId, resume: true, onInterrupt: "fail" }).then(
      (r) => r,
      (e: unknown) => e,
    );
    const failure = err instanceof Error ? err : (err as { status: string; error?: unknown }).error;
    if (!(err instanceof Error)) expect((err as { status: string }).status).toBe("error");
    const text = failure instanceof Error ? `${(failure as { code?: string }).code ?? ""} ${failure.message}` : String(failure);
    expect(text).toMatch(/REPLAY_MISMATCH|Refusing to reuse/);
    expect(ran).toEqual(["A"]);
  });
});

describe("map items at the top level", () => {
  it("each item resumes with its own model turns, also when two maps run in the same step", async () => {
    const inner = scripted("inner", echo);
    const spec = graphOf("maps-in-parallel", [map("m1", ask("w", "inner", "which=a{{ item.item }}"))]) as unknown as {
      nodes: Node[];
      edges: Array<{ from: string; to: string }>;
    };
    spec.nodes.push(map("m2", ask("w", "inner", "which=b{{ item.item }}")));
    spec.edges.push({ from: "START", to: "m2" }, { from: "m2", to: "END" });
    const r = await approveAll(spec as unknown as GraphSpec, [inner.provider], { items: ["x", "y", "z"] });
    expect(r.status).toBe("completed");
    expect([...ran].sort()).toEqual(["ax", "ay", "az", "bx", "by", "bz"]);
    // One model turn to ask and one after the approved call, per item: no turn is re-asked.
    expect(inner.calls()).toBe(12);
  });

  it("accepts saved entries only for the map item a task runs", () => {
    const task = (name: string, index: number) => ({ name, path: ["__pregel_push", index], interrupts: [{ value: {} }] });
    const { taskRoots } = pendingInterrupts({
      tasks: [task("mapw_m1", 0), task("mapw_m1", 1), task("mapw_m2", 2), task("mapw_m2", 3), { name: "a", interrupts: [{ value: {} }] }],
    });
    const [m1i0, m1i1, m2i0, m2i1, a] = taskRoots;
    expect([m1i0!("m1[0]"), m1i0!("m1[1]"), m1i1!("m1[1]"), m1i1!("m1[0]")]).toEqual([true, false, true, false]);
    expect([m2i0!("m2[0]"), m2i0!("m2[2]"), m2i1!("m2[1]"), m2i1!("m1[1]"), m2i1!("m2[01]")]).toEqual([true, false, true, false, false]);
    expect([a!("a"), a!("a[0]"), m1i0!("mapw_m1")]).toEqual([true, false, true]);
    // A worker task without a Send index (not something the engine produces) accepts no items.
    const { taskRoots: bare } = pendingInterrupts({ tasks: [{ name: "mapw_m1", interrupts: [{ value: {} }] }] });
    expect(bare[0]!("m1[0]")).toBe(false);
  });
});
