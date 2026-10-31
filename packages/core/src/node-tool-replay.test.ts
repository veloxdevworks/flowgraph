import { randomUUID } from "node:crypto";
import { MemorySaver } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph, type CompiledGraph } from "./compiler.js";
import { createLangChainProvider, registerTool } from "./index.js";
import "./nodes/index.js";

// Agents called as tools by another agent (`tools: [{ node }]`) that stop for
// approval (`permission: ask`) and resume: each must replay its own model
// turns and tool results, so the call a human approves is the call that runs.

const ran: string[] = [];
beforeAll(() => {
  registerTool({
    name: "fg_node_tool_record",
    description: "records a tag",
    handler: (args) => {
      const tag = String((args as { tag?: unknown }).tag);
      ran.push(tag);
      return { ran: tag };
    },
  });
});
beforeEach(() => {
  ran.length = 0;
});

type Turn = { call?: string; args?: Record<string, unknown> } | { calls: Array<{ name: string; args: Record<string, unknown> }> };

/** A scripted model; `script(n, prompt)` gives turn `n` (0-based, live calls only). */
function scripted(name: string, script: (n: number, prompt: string) => Turn | string) {
  let n = 0;
  const provider = createLangChainProvider(
    {
      invoke: async (messages: unknown) => {
        const prompt = JSON.stringify(messages);
        const turn = script(n++, prompt);
        if (typeof turn === "string") return new AIMessage({ content: turn });
        const calls = "calls" in turn ? turn.calls : [{ name: turn.call!, args: turn.args ?? {} }];
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

const record = (tag: string): Turn => ({ call: "fg_node_tool_record", args: { tag } });

/** Agent nodes; ids other than the first are tool targets only (never routed to). */
function graph(name: string, nodes: Array<Record<string, unknown>>): GraphSpec {
  const [first, ...rest] = nodes;
  const gate = { id: "gate", type: "function", when: "false", with: { fn: "fg_node_tool_noop" } };
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name },
    state: { channels: { out: { type: "object" } } },
    nodes: [{ ...first, with: { ...(first!["with"] as object), output: { to: "out" } } }, ...rest.map((n) => ({ ...n, when: "false" })), gate],
    edges: [
      { from: "START", to: "gate" },
      ...rest.map((n) => ({ from: "gate", to: String(n["id"]) })),
      { from: "gate", to: String(first!["id"]) },
      { from: String(first!["id"]), to: "END" },
      ...rest.map((n) => ({ from: String(n["id"]), to: "END" })),
    ],
  } as unknown as GraphSpec;
}

const askAgent = (id: string, provider: string, prompt = "work") => ({
  id,
  type: "agent",
  provider,
  with: { prompt, permission: "ask", tools: [{ function: "fg_node_tool_record" }] },
});

/** Approve every pending approval until the run ends; returns the tags shown to the approver, in order. */
async function approveAll(
  compile: () => Promise<CompiledGraph>,
  threadId: string,
): Promise<{ status: string; shown: string[] }> {
  const shown: string[] = [];
  let g = await compile();
  let res = await g.run({ input: {}, threadId, onInterrupt: "fail" });
  for (let i = 0; i < 10 && res.status === "interrupted"; i++) {
    const m = /"tag":"([^"]+)"/.exec(JSON.stringify(res.interrupts ?? []));
    if (m) shown.push(m[1]!);
    g = await compile();
    res = await g.resume({ threadId, resume: true, onInterrupt: "fail" });
  }
  return { status: res.status, shown };
}

describe("agents called as node tools resume with their own replay entries", () => {
  beforeAll(async () => {
    const { registerFunction } = await import("./nodes/function.js");
    registerFunction("fg_node_tool_noop", () => ({}));
  });

  for (const fresh of [true, false]) {
    it(`an approval goes to the call the human saw (${fresh ? "new compile per resume" : "same compiled graph"})`, async () => {
      const outer = scripted("outer", (n) => (n === 0 ? { call: "h", args: {} } : "outer done"));
      const inner = scripted("inner", (n) => (n === 0 ? record("A") : n === 1 ? record("B") : "inner done"));
      const spec = graph("node-tool-ask", [{ id: "o", type: "agent", provider: "outer", with: { prompt: "go", tools: [{ node: "h" }] } }, askAgent("h", "inner")]);
      const saver = new MemorySaver();
      const once = await compileGraph(spec, { checkpointer: saver, providers: [outer.provider, inner.provider] });
      const { status, shown } = await approveAll(async () => (fresh ? compileGraph(spec, { checkpointer: saver, providers: [outer.provider, inner.provider] }) : once), `nt-${randomUUID()}`);
      expect(status).toBe("completed");
      expect(shown).toEqual(["A", "B"]);
      expect(ran).toEqual(["A", "B"]);
      // Each model turn was made once; resumes replayed the rest.
      expect(inner.calls()).toBe(3);
      expect(outer.calls()).toBe(2);
    });
  }

  it("a node tool called by a node tool (nested) resumes with its own entries", async () => {
    const outer = scripted("outer", (n) => (n === 0 ? { call: "mid", args: {} } : "outer done"));
    const mid = scripted("mid", (n) => (n === 0 ? { call: "leaf", args: {} } : "mid done"));
    const leaf = scripted("leaf", (n) => (n === 0 ? record("A") : n === 1 ? record("B") : "leaf done"));
    const spec = graph("node-tool-nested", [
      { id: "o", type: "agent", provider: "outer", with: { prompt: "go", tools: [{ node: "mid" }] } },
      { id: "mid", type: "agent", provider: "mid", with: { prompt: "delegate", tools: [{ node: "leaf" }] } },
      askAgent("leaf", "leaf"),
    ]);
    const saver = new MemorySaver();
    const providers = [outer.provider, mid.provider, leaf.provider];
    const { status, shown } = await approveAll(() => compileGraph(spec, { checkpointer: saver, providers }), `nt-nested-${randomUUID()}`);
    expect(status).toBe("completed");
    expect(shown).toEqual(["A", "B"]);
    expect(ran).toEqual(["A", "B"]);
    expect([outer.calls(), mid.calls(), leaf.calls()]).toEqual([2, 2, 3]);
  });

  it("two different node tools of one agent each keep their entries", async () => {
    const outer = scripted("outer", (n) => (n === 0 ? { call: "h1", args: {} } : n === 1 ? { call: "h2", args: {} } : "outer done"));
    const one = scripted("one", (n) => (n === 0 ? record("A1") : n === 1 ? record("B1") : "one done"));
    const two = scripted("two", (n) => (n === 0 ? record("A2") : "two done"));
    const spec = graph("node-tool-two", [
      { id: "o", type: "agent", provider: "outer", with: { prompt: "go", tools: [{ node: "h1" }, { node: "h2" }] } },
      askAgent("h1", "one"),
      askAgent("h2", "two"),
    ]);
    const saver = new MemorySaver();
    const providers = [outer.provider, one.provider, two.provider];
    const { status, shown } = await approveAll(() => compileGraph(spec, { checkpointer: saver, providers }), `nt-two-${randomUUID()}`);
    expect(status).toBe("completed");
    expect(shown).toEqual(["A1", "B1", "A2"]);
    expect(ran).toEqual(["A1", "B1", "A2"]);
    expect([outer.calls(), one.calls(), two.calls()]).toEqual([3, 3, 2]);
  });

  it("two calls to the same node tool in one turn do not share entries", async () => {
    const outer = scripted("outer", (n) =>
      n === 0
        ? { calls: [{ name: "h", args: { which: "x" } }, { name: "h", args: { which: "y" } }] }
        : "outer done",
    );
    // The inner agent records whatever its prompt names; a call that reused
    // the other call's entries would record the wrong tag.
    const inner = scripted("inner", (_n, prompt) => {
      const which = /\bwhich=(\w)/.exec(prompt)?.[1] ?? "?";
      return prompt.includes("ToolMessage") ? `done ${which}` : record(which);
    });
    const spec = graph("node-tool-twice", [
      { id: "o", type: "agent", provider: "outer", with: { prompt: "go", tools: [{ node: "h" }] } },
      askAgent("h", "inner", "which={{ input.which }}"),
    ]);
    const saver = new MemorySaver();
    const providers = [outer.provider, inner.provider];
    const { status, shown } = await approveAll(() => compileGraph(spec, { checkpointer: saver, providers }), `nt-twice-${randomUUID()}`);
    expect(status).toBe("completed");
    expect(shown).toEqual(["x", "y"]);
    expect(ran).toEqual(["x", "y"]);
    expect([outer.calls(), inner.calls()]).toEqual([2, 4]);
  });
});
