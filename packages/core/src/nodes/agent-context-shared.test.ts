import { describe, it, expect } from "vitest";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "../compiler.js";
import { createScriptedProvider } from "../providers/index.js";
import type { AgentRequest } from "../providers/types.js";
import { validateSpec } from "../index.js";
import { collectNodeWriteChannels, ensureDeclaredOutputChannels } from "../runtime/validate-graph.js";

function seeded(n = 10): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push(new HumanMessage({ id: `seed-u${i}`, content: `question ${i} ${"q".repeat(200)}` }));
    out.push(new AIMessage({ id: `seed-a${i}`, content: `answer ${i} ${"a".repeat(200)}` }));
  }
  return out;
}

const agent = (id: string, provider: string, context: Record<string, unknown>) => ({
  id,
  type: "agent",
  provider,
  with: { prompt: `${id} turn`, context: { history: "chat", ...context } },
});

function graph(name: string, nodes: Array<ReturnType<typeof agent>>, parallel: boolean): GraphSpec {
  const ids = nodes.map((n) => n.id);
  const edges = parallel
    ? [...ids.map((id) => ({ from: "START", to: id })), ...ids.map((id) => ({ from: id, to: "END" }))]
    : [{ from: "START", to: ids[0]! }, ...ids.slice(1).map((id, i) => ({ from: ids[i]!, to: id })), { from: ids.at(-1)!, to: "END" }];
  return { metadata: { name }, state: { channels: { chat: { type: "messages" } } }, nodes, edges } as unknown as GraphSpec;
}

const sum = (maxTokens: number) => ({ maxTokens, strategy: "summarize", summarize: { mode: "extract", maxTokens: 400 } });

/** Seeds with no copy left: not in the channel and not quoted by any summary message. */
function lostSeeds(chat: BaseMessage[], seeds: BaseMessage[]): string[] {
  const summaries = chat.filter((m) => String(m.id ?? "").startsWith("fg-summary-")).map((m) => String(m.content)).join("\n");
  return seeds
    .filter((s) => !chat.some((c) => c.id === s.id))
    .filter((s) => !summaries.includes(String(s.content).split(" ").slice(0, 2).join(" ")))
    .map((s) => s.id!);
}

type CtxEvent = { nodeId: string; overBudget: boolean; sharedSummariesCut?: number };

async function runOnce(
  spec: GraphSpec,
  provider: string,
  thread: string,
  seeds: BaseMessage[],
  onReq?: (r: AgentRequest) => void,
  ctxEvents?: CtxEvent[],
) {
  const p = createScriptedProvider(
    provider,
    (req) => {
      onReq?.(req);
      return { output: { text: "ok" }, stopReason: "done" };
    },
    { contextMessages: true },
  );
  const g = await compileGraph(spec, { providers: [p] } as never);
  g.events.subscribe((e: { type: string; data: unknown }) => {
    if (e.type === "agent.context") ctxEvents?.push(e.data as CtxEvent);
  });
  const r = await g.run({ threadId: thread, input: { chat: seeds } });
  expect(r.status).toBe("completed");
  return r.state["chat"] as BaseMessage[];
}

describe("agents sharing a history channel", () => {
  it("two summarize agents in parallel lose nothing a single agent keeps", async () => {
    const seeds = seeded();
    const narrowAlone = await runOnce(graph("sh-narrow", [agent("narrow", "sh-n", sum(700))], false), "sh-n", "sh-n", seeds);
    const lostAlone = new Set(lostSeeds(narrowAlone, seeds));

    const chat = await runOnce(
      graph("sh-par", [agent("wide", "sh-p", sum(1200)), agent("narrow", "sh-p", sum(700))], true),
      "sh-p",
      "sh-p",
      seeds,
    );
    // each agent keeps its own summary
    const ids = chat.map((m) => m.id);
    expect(ids).toContain("fg-summary-chat-wide");
    expect(ids).toContain("fg-summary-chat-narrow");
    // the newest turns survive, in the channel or in a summary
    const lost = lostSeeds(chat, seeds);
    for (let i = 7; i < 10; i++) {
      expect(lost).not.toContain(`seed-u${i}`);
      expect(lost).not.toContain(`seed-a${i}`);
    }
    // anything gone is gone only to a summary's own size cap, as with one agent
    for (const id of lost) expect(lostAlone.has(id)).toBe(true);
    // both turns were appended
    expect(chat.filter((m) => m.content === "wide turn" || m.content === "narrow turn")).toHaveLength(2);
  });

  it("an agent sees the summary another agent keeps in the channel", async () => {
    const seeds = seeded();
    const spec = graph("sh-seq", [agent("first", "sh-s", sum(700)), agent("second", "sh-s", { maxTokens: 6000 })], false);
    const seen: AgentRequest[] = [];
    const chat = await runOnce(spec, "sh-s", "sh-s", seeds, (r) => seen.push(r));
    expect(chat.map((m) => m.id)).toContain("fg-summary-chat-first");
    const stored = chat.find((m) => m.id === "fg-summary-chat-first")!;
    const firstSummary = String((stored.additional_kwargs["flowgraph"] as { text: string }).text);
    // what "first" removed reaches "second" through first's summary
    expect(JSON.stringify(seen[1])).toContain(JSON.stringify(firstSummary).slice(1, -1));
    expect(seen[1]!.messages!.some((m) => m.id === "seed-u0")).toBe(false);
  });

  for (const strategy of ["trim", "last"] as const) {
    it(`${strategy} on a shared channel only appends`, async () => {
      const seeds = seeded();
      const cfg = { maxTokens: 700, strategy, lastN: 4 };
      const chat = await runOnce(
        graph(`sh-${strategy}`, [agent("one", `sh-${strategy}`, cfg), agent("two", `sh-${strategy}`, cfg)], true),
        `sh-${strategy}`,
        `sh-${strategy}`,
        seeds,
      );
      expect(chat).toHaveLength(seeds.length + 4);
      expect(lostSeeds(chat, seeds)).toEqual([]);
    });
  }

  it("trim on a channel no other agent uses still compacts", async () => {
    const seeds = seeded();
    const chat = await runOnce(graph("sh-solo", [agent("solo", "sh-solo", { maxTokens: 700, strategy: "trim" })], false), "sh-solo", "sh-solo", seeds);
    expect(chat.length).toBeLessThan(seeds.length);
  });

  it("lint warns for trim / last on a shared channel, not for summarize", () => {
    const spec = graph(
      "sh-lint",
      [agent("a", "x", { strategy: "trim" }), agent("b", "x", { strategy: "summarize" }), agent("c", "x", { strategy: "last", compact: false })],
      true,
    );
    const shared = validateSpec(spec).filter((d) => d.code === "CONTEXT_HISTORY_SHARED");
    expect(shared.map((d) => d.path)).toEqual(["nodes.a.with.context.history"]);
    expect(shared[0]!.message).toContain('"b", "c"');
  });

  it("a large summary another agent keeps never makes a smaller agent overflow", async () => {
    // big summarizes with a 6000-token summary; small (trim, 4000) shares the channel
    const spec = graph(
      "sh-mismatch",
      [
        agent("big", "sm", { maxTokens: 16000, strategy: "summarize", summarize: { mode: "extract", maxTokens: 6000 } }),
        agent("small", "sm", { maxTokens: 4000, strategy: "trim" }),
      ],
      false,
    );
    const mismatch = validateSpec(spec).filter((d) => d.code === "CONTEXT_HISTORY_BUDGET_MISMATCH");
    expect(mismatch.map((d) => d.path)).toEqual(["nodes.small.with.context.maxTokens"]);
    expect(mismatch[0]!.message).toContain('"big" keeps a summary of up to 6000 tokens');

    const bulk: BaseMessage[] = [];
    for (let i = 0; i < 400; i++) {
      bulk.push(new HumanMessage({ id: `bulk-u${i}`, content: `bulkQ${i} ${"q".repeat(200)}` }));
      bulk.push(new AIMessage({ id: `bulk-a${i}`, content: `bulkA${i} ${"a".repeat(200)}` }));
    }
    const reqs: AgentRequest[] = [];
    const ev: CtxEvent[] = [];
    let chat = await runOnce(spec, "sm", "sh-mismatch", bulk, (r) => reqs.push(r), ev);
    const bigSummary = chat.find((m) => m.id === "fg-summary-chat-big")!;
    const bigText = String((bigSummary.additional_kwargs["flowgraph"] as { text: string }).text);
    expect(bigText.length).toBeGreaterThan(15000);
    // small's call: within budget, with big's summary shortened to its newest lines
    const smallReq = reqs.find((r) => r.prompt.endsWith("small turn"))!;
    const smallEv = ev.filter((e) => e.nodeId === "small");
    expect(smallEv.length).toBeGreaterThan(0);
    expect(smallEv.every((e) => !e.overBudget && e.sharedSummariesCut === 1)).toBe(true);
    const firstText = String(smallReq.messages![0]!.content);
    expect(firstText).toContain('kept-by="big"');
    expect(firstText).toContain(bigText.split("\n").at(-1)!);
    // the channel still holds big's full summary, and later runs keep working
    for (let run = 0; run < 3; run++) {
      chat = await runOnce(spec, "sm", "sh-mismatch", [...chat, new HumanMessage({ id: `more-${run}`, content: `more ${run}` })]);
      const s = chat.find((m) => m.id === "fg-summary-chat-big")!;
      expect(String((s.additional_kwargs["flowgraph"] as { text: string }).text).length).toBeGreaterThan(15000);
    }
  });

  it("budget mismatch lint: not for summarizers of the same size", () => {
    const codes = (nodes: Array<ReturnType<typeof agent>>) =>
      validateSpec(graph("sh-peers", nodes, true))
        .filter((d) => d.code === "CONTEXT_HISTORY_BUDGET_MISMATCH")
        .map((d) => d.path);
    const peer = (id: string, max: number, smax: number) =>
      agent(id, "x", { maxTokens: max, strategy: "summarize", summarize: { mode: "extract", maxTokens: smax } });
    expect(codes([peer("a", 2000, 800), peer("b", 2000, 800)])).toEqual([]);
    expect(codes([peer("a", 2000, 800), peer("b", 4000, 800)])).toEqual(["nodes.a.with.context.maxTokens"]);
    expect(codes([peer("a", 2000, 800), agent("t", "x", { maxTokens: 2000, strategy: "trim" })])).toEqual(["nodes.t.with.context.maxTokens"]);
  });

  it("other agents' summaries are left out rather than overflow", async () => {
    const reqs: AgentRequest[] = [];
    const other = new HumanMessage({
      id: "fg-summary-chat-gone",
      content: "x",
      additional_kwargs: { flowgraph: { summary: true, node: "gone", text: "- user: old line\n".repeat(400) } },
    });
    const spec = graph("sh-drop", [agent("a", "sd", { maxTokens: 200, strategy: "trim" })], false);
    const ev: CtxEvent[] = [];
    await runOnce(spec, "sd", "sh-drop", [other, ...seeded(2)], (r) => reqs.push(r), ev);
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((e) => !e.overBudget && e.sharedSummariesCut === 1)).toBe(true);
    expect(JSON.stringify(reqs)).not.toContain('kept-by=\\"gone\\"');
  });

  it("with.context.history counts as a channel the agent writes", () => {
    const spec = graph("sh-writes", [agent("a", "x", {})], false);
    expect(collectNodeWriteChannels(spec.nodes[0]!)).toContain("chat");
    const bare = { ...spec, state: { channels: {} } } as unknown as GraphSpec;
    expect(ensureDeclaredOutputChannels(bare).state!.channels["chat"]).toEqual({ type: "messages" });
  });
});

describe("reserved history channels", () => {
  for (const ch of ["__issues", "__once", "__mapCollect", "__worktrees", "__services", "__anything"]) {
    it(`compileGraph refuses with.context.history "${ch}"`, async () => {
      const spec = {
        metadata: { name: "rsv" },
        state: { channels: {} },
        nodes: [{ id: "a", type: "agent", provider: "rsv", with: { prompt: "hi", context: { history: ch } } }],
        edges: [
          { from: "START", to: "a" },
          { from: "a", to: "END" },
        ],
      } as unknown as GraphSpec;
      const p = createScriptedProvider("rsv", () => ({ output: { text: "ok" }, stopReason: "done" }), { contextMessages: true });
      await expect(compileGraph(spec, { providers: [p] } as never)).rejects.toThrow(/reserved channel/);
    });
  }

  it("also inside map", async () => {
    const spec = {
      metadata: { name: "rsv-map" },
      state: { channels: { items: { type: "array" } } },
      nodes: [
        {
          id: "m",
          type: "map",
          with: { over: "{{ state.items }}", node: { id: "inner", type: "agent", provider: "rsv", with: { prompt: "hi", context: { history: "__issues" } } } },
        },
      ],
      edges: [
        { from: "START", to: "m" },
        { from: "m", to: "END" },
      ],
    } as unknown as GraphSpec;
    const p = createScriptedProvider("rsv", () => ({ output: { text: "ok" }, stopReason: "done" }), { contextMessages: true });
    const attempt = async () => {
      const g = await compileGraph(spec, { providers: [p] } as never);
      const r = await g.run({ threadId: "rsv-map", input: { items: [1] } });
      if (r.status !== "completed") throw new Error(r.error?.message ?? r.status);
    };
    await expect(attempt()).rejects.toThrow(/reserved channel/);
  });
});
