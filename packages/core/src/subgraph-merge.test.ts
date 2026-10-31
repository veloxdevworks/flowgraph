import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "yaml";
import { HumanMessage, RemoveMessage } from "@langchain/core/messages";
import { compileGraph } from "./compiler.js";
import { loadGraph, validateSpec } from "./loader.js";
import { registerFunction } from "./nodes/function.js";
import { childChannelRefsInMapping, projectExplicitOutput, reducerInput } from "./nodes/subgraph-merge.js";
import type { GraphSpec } from "@flowgraph/spec";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "subgraph-merge");

beforeAll(() => {
  registerFunction("subgraphMergeStamp", (input) => {
    const raw = (input as { log?: unknown }).log;
    const prev = Array.isArray(raw) ? raw : [];
    const item = (input as { item?: string }).item ?? "child";
    return { log: [...prev, item], note: "from-child", childOnly: "hidden" };
  });
  registerFunction("subgraphMergeEcho", (input) => {
    const tagsRaw = (input as { tags?: unknown }).tags;
    const tags = Array.isArray(tagsRaw) ? tagsRaw : [];
    const tag = String((input as { tag?: string }).tag ?? "");
    const base = Number((input as { base?: string | number }).base ?? 0);
    const extraKey = String((input as { extraKey?: string }).extraKey ?? "k");
    const extraVal = Number((input as { extraVal?: string | number }).extraVal ?? 0);
    return {
      tags: [...tags, tag],
      bag: { base, [extraKey]: extraVal },
    };
  });
  registerFunction("subgraphMergeSquare", (input) => {
    const n = Number((input as { n?: unknown }).n ?? 0);
    return { squared: n * n };
  });
  registerFunction("subgraphMergeKeepDraft", (input) => {
    return { draft: (input as { draft?: unknown }).draft };
  });
  registerFunction("subgraphMergeEditMessages", (input) => {
    const raw = ((input as { messages?: unknown[] }).messages ?? []) as Array<{ id?: string; content?: unknown }>;
    const edited = raw.map((message) =>
      message.id === "m1" ? { id: "m1", type: "human", content: "EDITED" } : message,
    );
    return { messages: [...edited, { id: "m2", type: "human", content: "new" }] };
  });
  registerFunction("subgraphMergeRemoveMessage", () => {
    return {
      messages: [new RemoveMessage({ id: "m1" }), { id: "m2", type: "human", content: "new" }],
    };
  });
  registerFunction("subgraphMergeReply", (input) => {
    const id = String((input as { id?: string }).id ?? "m9");
    return { messages: [{ id, type: "human", content: "reply" }] };
  });
  registerFunction("subgraphMergeDropM1", () => {
    return { messages: [new RemoveMessage({ id: "m1" })] };
  });
  registerFunction("subgraphMergeEditM1", () => {
    return { messages: [{ id: "m1", type: "human", content: "EDITED" }] };
  });
});

function childLogSpec(): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "child-log" },
    state: {
      channels: {
        title: { type: "string" },
        log: { type: "array" },
        note: { type: "string" },
        childOnly: { type: "string" },
      },
    },
    nodes: [
      {
        id: "stamp",
        type: "function",
        with: {
          fn: "subgraphMergeStamp",
          input: { log: "{{ state.log }}", item: "child" },
          output: {
            map: {
              log: "{{ result.log }}",
              note: "{{ result.note }}",
              childOnly: "{{ result.childOnly }}",
            },
          },
        },
      },
    ],
    edges: [
      { from: "START", to: "stamp" },
      { from: "stamp", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

function parentLog(node: GraphSpec["nodes"][number]): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "parent-log" },
    state: {
      channels: {
        title: { type: "string", default: "kept" },
        marker: { type: "string", default: "stay" },
        log: { type: "array", reducer: "append", default: ["seed"] },
        note: { type: "string", default: "" },
      },
    },
    nodes: [node],
    edges: [
      { from: "START", to: "embed" },
      { from: "embed", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

describe("subgraph merge deltas", () => {
  it("turns a seeded append into the suffix and a seeded merge into changed keys", () => {
    expect(
      reducerInput({ type: "array", reducer: "append" }, true, ["seed"], ["seed", "child"]),
    ).toEqual({ omit: false, value: ["child"] });
    expect(
      reducerInput({ type: "object", reducer: "merge" }, true, { base: 1 }, { base: 1, a: 1 }),
    ).toEqual({ omit: false, value: { a: 1 } });
    expect(reducerInput({ type: "string" }, true, "kept", "kept")).toEqual({ omit: true });
    expect(reducerInput({ type: "string" }, false, undefined, "from-child")).toEqual({
      omit: false,
      value: "from-child",
    });
    expect(
      reducerInput(
        { type: "messages", reducer: "messages" },
        true,
        [{ id: "1", content: "a" }],
        [
          { id: "1", content: "a" },
          { id: "2", content: "b" },
        ],
      ),
    ).toEqual({ omit: false, value: [{ id: "2", content: "b" }] });
    expect(childChannelRefsInMapping("{{ state.note.title }}")).toEqual(["note"]);
    expect(childChannelRefsInMapping("gateResult")).toEqual(["gateResult"]);
    expect(reducerInput({ type: "array", reducer: "append" }, true, ["a", "b"], ["b"])).toEqual({ omit: true });
    expect(reducerInput({ type: "array", reducer: "append" }, true, ["a", "b"], ["b", "c"])).toEqual({
      omit: false,
      value: ["c"],
    });
    expect(
      reducerInput({ type: "messages", reducer: "messages" }, true, [{ id: "m1", content: "orig" }], [
        { id: "m1", content: "EDITED" },
        { id: "m2", content: "new" },
      ]),
    ).toEqual({
      omit: false,
      value: [
        { id: "m1", content: "EDITED" },
        { id: "m2", content: "new" },
      ],
    });
    const absent = reducerInput(
      { type: "messages", reducer: "messages" },
      true,
      [{ id: "m1", content: "orig" }],
      [{ id: "m2", content: "new" }],
      true,
    );
    expect(absent.omit).toBe(false);
    if (!absent.omit) {
      const delta = absent.value as unknown[];
      expect(delta[0]).toEqual({ id: "m2", content: "new" });
      expect(RemoveMessage.isInstance(delta[1])).toBe(true);
      expect((delta[1] as { id: string }).id).toBe("m1");
    }
    const removed = reducerInput(
      { type: "messages", reducer: "messages" },
      true,
      [{ id: "m1", content: "orig" }],
      [new RemoveMessage({ id: "m1" }), { id: "m2", content: "new" }],
    );
    expect(
      reducerInput(
        { type: "messages", reducer: "messages" },
        true,
        [
          { id: "m1", content: "orig" },
          { id: "m2", content: "keep" },
        ],
        [{ id: "m9", content: "reply" }],
        false,
      ),
    ).toEqual({ omit: false, value: [{ id: "m9", content: "reply" }] });
    expect(removed.omit).toBe(false);
    if (!removed.omit) {
      const delta = removed.value as unknown[];
      expect(RemoveMessage.isInstance(delta[0])).toBe(true);
      expect((delta[0] as { id: string }).id).toBe("m1");
      expect(delta[1]).toEqual({ id: "m2", content: "new" });
    }
    expect(
      projectExplicitOutput({
        out: { result: "draft" },
        childState: { draft: "hello" },
        seeds: { draft: { value: "hello", fromParent: "input" } },
        parentChannels: { input: { type: "string" }, result: { type: "string" } },
        childChannelDefs: { draft: { type: "string" } },
        resolve: (ref) => (ref === "draft" ? "hello" : undefined),
      }),
    ).toEqual({ result: "hello" });
  });
});

describe("subgraph merge-back", () => {
  it("merges an inline subgraph through the parent's reducers", async () => {
    const compiled = await compileGraph(
      parentLog({ id: "embed", type: "subgraph", spec: childLogSpec() }),
      { checkpointer: "none" },
    );
    const result = await compiled.run({});
    expect(result.status).toBe("completed");
    expect(result.state["title"]).toBe("kept");
    expect(result.state["marker"]).toBe("stay");
    expect(result.state["log"]).toEqual(["seed", "child"]);
    expect(result.state["note"]).toBe("from-child");
    expect(result.state["childOnly"]).toBeUndefined();
    expect(result.state["outputs"]).toBeUndefined();
  });

  it("merges a file subgraph from YAML the same way", async () => {
    const loaded = await loadGraph(path.join(fixtureDir, "parent-log.graph.yaml"), { cwd: fixtureDir });
    expect(loaded.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(loaded.spec).toBeTruthy();
    const compiled = await compileGraph(loaded.spec!, { cwd: fixtureDir, checkpointer: "none" });
    const result = await compiled.run({});
    expect(result.status).toBe("completed");
    expect(result.state["log"]).toEqual(["seed", "child"]);
    expect(result.state["note"]).toBe("from-child");
    expect(result.state["title"]).toBe("kept");
    expect(result.state["marker"]).toBe("stay");
    expect(result.state["childOnly"]).toBeUndefined();
  });

  it("stateMap.out writes only the mapped channels and still applies append", async () => {
    const compiled = await compileGraph(
      parentLog({
        id: "embed",
        type: "subgraph",
        spec: childLogSpec(),
        with: { stateMap: { out: { log: "log", note: "{{ state.note }}" } } },
      }),
      { checkpointer: "none" },
    );
    const result = await compiled.run({});
    expect(result.status).toBe("completed");
    expect(result.state["log"]).toEqual(["seed", "child"]);
    expect(result.state["note"]).toBe("from-child");
    expect(result.state["title"]).toBe("kept");
  });

  it("merges parallel subgraph branches in node-id order", async () => {
    const branch = (id: string, tag: string, extraKey: string, extraVal: string, base: string): GraphSpec["nodes"][number] => ({
      id,
      type: "subgraph",
      spec: {
        apiVersion: "flowgraph/v1",
        kind: "Graph",
        metadata: { name: `child-${id}` },
        state: {
          channels: {
            tags: { type: "array" },
            bag: { type: "object" },
          },
        },
        nodes: [
          {
            id: "go",
            type: "function",
            with: {
              fn: "subgraphMergeEcho",
              input: {
                tags: "{{ state.tags }}",
                tag,
                base,
                extraKey,
                extraVal,
              },
              output: {
                map: {
                  tags: "{{ result.tags }}",
                  bag: "{{ result.bag }}",
                },
              },
            },
          },
        ],
        edges: [
          { from: "START", to: "go" },
          { from: "go", to: "END" },
        ],
        runtime: { checkpoint: { enabled: false } },
      } as unknown as GraphSpec,
    });

    const parent: GraphSpec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "parent-parallel" },
      state: {
        channels: {
          tags: { type: "array", reducer: "append", default: [] },
          bag: { type: "object", reducer: "merge", default: {} },
        },
      },
      nodes: [
        branch("branch-a", "a", "a", "1", "{{ state.bag.base }}"),
        branch("branch-b", "b", "b", "2", "9"),
      ],
      edges: [
        { from: "START", to: ["branch-a", "branch-b"] },
        { from: "branch-a", to: "END" },
        { from: "branch-b", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;

    const compiled = await compileGraph(parent, { checkpointer: "none" });
    const result = await compiled.run({ input: { tags: ["seed"], bag: { base: 1 } } });
    expect(result.status).toBe("completed");
    expect(result.state["tags"]).toEqual(["seed", "a", "b"]);
    expect(result.state["bag"]).toEqual({ base: 9, a: 1, b: 2 });
  });

  it("collects a mapped subgraph's produced value in input order", async () => {
    const parent: GraphSpec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "parent-map" },
      state: {
        channels: {
          numbers: { type: "array" },
          squares: { type: "array", reducer: "append" },
        },
      },
      nodes: [
        {
          id: "each",
          type: "map",
          with: {
            over: "{{ state.numbers }}",
            as: "n",
            concurrency: 2,
            node: {
              type: "subgraph",
              spec: {
                metadata: { name: "sq" },
                state: { channels: { n: { type: "number" }, squared: { type: "number" } } },
                nodes: [
                  {
                    id: "sq",
                    type: "function",
                    with: {
                      fn: "subgraphMergeSquare",
                      input: { n: "{{ state.n }}" },
                      output: { map: { squared: "{{ result.squared }}" } },
                    },
                  },
                ],
                edges: [
                  { from: "START", to: "sq" },
                  { from: "sq", to: "END" },
                ],
                runtime: { checkpoint: { enabled: false } },
              },
              with: { stateMap: { in: { n: "{{ item.n }}" } } },
            },
            collect: { to: "squares" },
          },
        },
      ],
      edges: [
        { from: "START", to: "each" },
        { from: "each", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;

    const compiled = await compileGraph(parent, { checkpointer: "none" });
    const result = await compiled.run({ input: { numbers: [1, 2, 3] } });
    expect(result.status).toBe("completed");
    expect(result.state["squares"]).toEqual([1, 4, 9]);
  });

  it("merges a subgraph that interrupts and resumes exactly once", async () => {
    const child: GraphSpec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "child-hitl" },
      state: {
        channels: {
          log: { type: "array" },
          gateResult: { type: "object" },
        },
      },
      nodes: [
        {
          id: "before",
          type: "function",
          with: {
            fn: "subgraphMergeStamp",
            input: { log: "{{ state.log }}", item: "before" },
            output: { map: { log: "{{ result.log }}" } },
          },
        },
        {
          id: "gate",
          type: "hitl",
          with: { mode: "approve", message: "approve child?", output: { to: "gateResult" } },
        },
        {
          id: "after",
          type: "function",
          with: {
            fn: "subgraphMergeStamp",
            input: { log: "{{ state.log }}", item: "after" },
            output: { map: { log: "{{ result.log }}" } },
          },
        },
      ],
      edges: [
        { from: "START", to: "before" },
        { from: "before", to: "gate" },
        { from: "gate", to: "after" },
        { from: "after", to: "END" },
      ],
      runtime: { checkpoint: { enabled: true, backend: "memory" } },
    } as unknown as GraphSpec;

    const parent: GraphSpec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "parent-hitl" },
      state: {
        channels: {
          log: { type: "array", reducer: "append", default: [] },
          approval: { type: "object" },
        },
      },
      nodes: [
        {
          id: "embed",
          type: "subgraph",
          spec: child,
          with: { stateMap: { out: { approval: "gateResult", log: "log" } } },
        },
      ],
      edges: [
        { from: "START", to: "embed" },
        { from: "embed", to: "END" },
      ],
      runtime: { checkpoint: { enabled: true, backend: "memory" } },
    } as unknown as GraphSpec;

    const compiled = await compileGraph(parent, { checkpointer: "memory" });
    const first = await compiled.run({
      threadId: "merge-hitl",
      input: { log: ["seed"] },
      onInterrupt: "fail",
    });
    expect(first.status).toBe("interrupted");
    expect(first.state["log"]).toEqual(["seed"]);
    expect(first.state["gateResult"]).toBeUndefined();

    const resumed = await compiled.resume({ threadId: "merge-hitl", resume: { approved: true } });
    expect(resumed.status).toBe("completed");
    expect(resumed.state["log"]).toEqual(["seed", "before", "after"]);
    expect(resumed.state["approval"]).toEqual({ approved: true });
    expect(resumed.state["gateResult"]).toBeUndefined();
  });
});

describe("subgraph merge regressions", () => {
  it("writes stateMap.out when the seed came from a different parent channel", async () => {
    const child: GraphSpec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "child-draft" },
      state: { channels: { draft: { type: "string" } } },
      nodes: [
        {
          id: "keep",
          type: "function",
          with: {
            fn: "subgraphMergeKeepDraft",
            input: { draft: "{{ state.draft }}" },
            output: { map: { draft: "{{ result.draft }}" } },
          },
        },
      ],
      edges: [
        { from: "START", to: "keep" },
        { from: "keep", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;
    const parent: GraphSpec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "parent-draft" },
      state: {
        channels: {
          input: { type: "string" },
          result: { type: "string" },
        },
      },
      nodes: [
        {
          id: "embed",
          type: "subgraph",
          spec: child,
          with: {
            stateMap: {
              in: { draft: "{{ state.input }}" },
              out: { result: "draft" },
            },
          },
        },
      ],
      edges: [
        { from: "START", to: "embed" },
        { from: "embed", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;

    const compiled = await compileGraph(parent, { checkpointer: "none" });
    const result = await compiled.run({ input: { input: "hello" } });
    expect(result.status).toBe("completed");
    expect(result.state["result"]).toBe("hello");
  });

  it("keeps a child's edit to an existing message and appends the new one", async () => {
    const child: GraphSpec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "child-messages" },
      state: { channels: { messages: { type: "messages" } } },
      nodes: [
        {
          id: "edit",
          type: "function",
          with: {
            fn: "subgraphMergeEditMessages",
            input: { messages: "{{ state.messages }}" },
            output: { map: { messages: "{{ result.messages }}" } },
          },
        },
      ],
      edges: [
        { from: "START", to: "edit" },
        { from: "edit", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;
    const parent: GraphSpec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "parent-messages" },
      state: { channels: { messages: { type: "messages" } } },
      nodes: [{ id: "embed", type: "subgraph", spec: child }],
      edges: [
        { from: "START", to: "embed" },
        { from: "embed", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;

    const compiled = await compileGraph(parent, { checkpointer: "none" });
    const result = await compiled.run({
      input: { messages: [new HumanMessage({ id: "m1", content: "orig" })] },
    });
    expect(result.status).toBe("completed");
    const messages = result.state["messages"] as Array<{ id?: string; content?: unknown }>;
    expect(messages.map((message) => [message.id, message.content])).toEqual([
      ["m1", "EDITED"],
      ["m2", "new"],
    ]);
  });

  it("applies a RemoveMessage the child returned for a seeded id", async () => {
    const child: GraphSpec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "child-remove" },
      state: { channels: { messages: { type: "array" } } },
      nodes: [
        {
          id: "drop",
          type: "function",
          with: {
            fn: "subgraphMergeRemoveMessage",
            output: { map: { messages: "{{ result.messages }}" } },
          },
        },
      ],
      edges: [
        { from: "START", to: "drop" },
        { from: "drop", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;
    const parent: GraphSpec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "parent-remove" },
      state: { channels: { messages: { type: "messages" } } },
      nodes: [{ id: "embed", type: "subgraph", spec: child }],
      edges: [
        { from: "START", to: "embed" },
        { from: "embed", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;

    const compiled = await compileGraph(parent, { checkpointer: "none" });
    const result = await compiled.run({
      input: { messages: [new HumanMessage({ id: "m1", content: "orig" })] },
    });
    expect(result.status).toBe("completed");
    const messages = result.state["messages"] as Array<{ id?: string; content?: unknown }>;
    expect(messages.map((message) => [message.id, message.content])).toEqual([["m2", "new"]]);
  });
});

describe("subgraph message channel types", () => {
  function replyChild(channels: Record<string, { type: string; reducer?: string }> | undefined): GraphSpec {
    return {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "child-reply" },
      ...(channels ? { state: { channels } } : { state: { channels: {} } }),
      nodes: [
        {
          id: "reply",
          type: "function",
          with: {
            fn: "subgraphMergeReply",
            input: { id: "m9" },
            output: { map: { messages: "{{ result.messages }}" } },
          },
        },
      ],
      edges: [
        { from: "START", to: "reply" },
        { from: "reply", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;
  }

  function threadParent(child: GraphSpec, nodes?: GraphSpec["nodes"]): GraphSpec {
    const graphNodes = nodes ?? [{ id: "embed", type: "subgraph", spec: child }];
    const edges =
      graphNodes.length === 1
        ? [
            { from: "START", to: "embed" },
            { from: "embed", to: "END" },
          ]
        : [
            { from: "START", to: graphNodes.map((node) => node.id) },
            ...graphNodes.map((node) => ({ from: node.id, to: "END" })),
          ];
    return {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "parent-thread" },
      state: { channels: { messages: { type: "messages" } } },
      nodes: graphNodes,
      edges,
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;
  }

  const seeded = {
    input: {
      messages: [
        new HumanMessage({ id: "m1", content: "one" }),
        new HumanMessage({ id: "m2", content: "two" }),
      ],
    },
  };

  it.each([
    ["messages reducer", { messages: { type: "messages" } }],
    ["array replace", { messages: { type: "array" } }],
    ["append", { messages: { type: "array", reducer: "append" } }],
    ["undeclared", undefined],
  ] as const)("a %s child that returns only its reply keeps the parent thread", async (_label, channels) => {
    const compiled = await compileGraph(threadParent(replyChild(channels)), { checkpointer: "none" });
    const result = await compiled.run(seeded);
    expect(result.status).toBe("completed");
    const messages = result.state["messages"] as Array<{ id?: string; content?: unknown }>;
    expect(messages.map((message) => [message.id, message.content])).toEqual([
      ["m1", "one"],
      ["m2", "two"],
      ["m9", "reply"],
    ]);
  });

  it("completes when two subgraphs remove the same seeded id", async () => {
    const child = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "child-drop" },
      state: { channels: { messages: { type: "messages" } } },
      nodes: [
        {
          id: "drop",
          type: "function",
          with: {
            fn: "subgraphMergeDropM1",
            output: { map: { messages: "{{ result.messages }}" } },
          },
        },
      ],
      edges: [
        { from: "START", to: "drop" },
        { from: "drop", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;
    const compiled = await compileGraph(
      threadParent(child, [
        { id: "branch-a", type: "subgraph", spec: child },
        { id: "branch-b", type: "subgraph", spec: child },
      ]),
      { checkpointer: "none" },
    );
    const result = await compiled.run(seeded);
    expect(result.status).toBe("completed");
    const messages = result.state["messages"] as Array<{ id?: string; content?: unknown }>;
    expect(messages.map((message) => message.id)).toEqual(["m2"]);
  });

  it("lets the later sibling win when one removes an id and the other edits it", async () => {
    const remover = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "child-remover" },
      state: { channels: { messages: { type: "array" } } },
      nodes: [
        {
          id: "drop",
          type: "function",
          with: {
            fn: "subgraphMergeDropM1",
            output: { map: { messages: "{{ result.messages }}" } },
          },
        },
      ],
      edges: [
        { from: "START", to: "drop" },
        { from: "drop", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;
    const editor = {
      ...remover,
      metadata: { name: "child-editor" },
      nodes: [
        {
          id: "edit",
          type: "function",
          with: {
            fn: "subgraphMergeEditM1",
            output: { map: { messages: "{{ result.messages }}" } },
          },
        },
      ],
      edges: [
        { from: "START", to: "edit" },
        { from: "edit", to: "END" },
      ],
    } as unknown as GraphSpec;
    const compiled = await compileGraph(
      threadParent(remover, [
        { id: "branch-a", type: "subgraph", spec: remover },
        { id: "branch-b", type: "subgraph", spec: editor },
      ]),
      { checkpointer: "none" },
    );
    const result = await compiled.run(seeded);
    expect(result.status).toBe("completed");
    const messages = result.state["messages"] as Array<{ id?: string; content?: unknown }>;
    const byId = new Map(messages.map((message) => [message.id, message.content]));
    expect(byId.get("m2")).toBe("two");
    expect(byId.get("m1")).toBe("EDITED");
  });

  it("lets the later sibling win when one edits an id and the other removes it", async () => {
    const remover = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "child-remover" },
      state: { channels: { messages: { type: "array" } } },
      nodes: [
        {
          id: "drop",
          type: "function",
          with: {
            fn: "subgraphMergeDropM1",
            output: { map: { messages: "{{ result.messages }}" } },
          },
        },
      ],
      edges: [
        { from: "START", to: "drop" },
        { from: "drop", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;
    const editor = {
      ...remover,
      metadata: { name: "child-editor" },
      nodes: [
        {
          id: "edit",
          type: "function",
          with: {
            fn: "subgraphMergeEditM1",
            output: { map: { messages: "{{ result.messages }}" } },
          },
        },
      ],
      edges: [
        { from: "START", to: "edit" },
        { from: "edit", to: "END" },
      ],
    } as unknown as GraphSpec;
    const compiled = await compileGraph(
      threadParent(remover, [
        { id: "branch-a", type: "subgraph", spec: editor },
        { id: "branch-b", type: "subgraph", spec: remover },
      ]),
      { checkpointer: "none" },
    );
    const result = await compiled.run(seeded);
    expect(result.status).toBe("completed");
    const messages = result.state["messages"] as Array<{ id?: string; content?: unknown }>;
    const byId = new Map(messages.map((message) => [message.id, message.content]));
    expect(byId.has("m1")).toBe(false);
    expect(byId.get("m2")).toBe("two");
  });
});

describe("subgraph output mapping lint", () => {
  it("flags an unknown child channel and an undeclared parent channel", () => {
    const diags = validateSpec({
      metadata: { name: "bad-out" },
      state: { channels: { note: { type: "string" } } },
      nodes: [
        {
          id: "embed",
          type: "subgraph",
          spec: {
            metadata: { name: "child" },
            state: { channels: { note: { type: "string" } } },
            nodes: [],
            edges: [{ from: "START", to: "END" }],
          },
          with: { stateMap: { out: { summary: "nope", note: "{{ state.missing }}" } } },
        },
      ],
      edges: [
        { from: "START", to: "embed" },
        { from: "embed", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec);

    expect(diags.some((d) => d.code === "UNDECLARED_OUTPUT_CHANNEL" && d.message.includes("summary"))).toBe(true);
    expect(diags.filter((d) => d.code === "SUBGRAPH_OUTPUT_UNKNOWN").map((d) => d.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("nope"), expect.stringContaining("missing")]),
    );
  });

  it("does not require map-inner stateMap.out keys to be parent channels", () => {
    const diags = validateSpec({
      metadata: { name: "map-inner-out" },
      state: { channels: { numbers: { type: "array" }, squares: { type: "array", reducer: "append" } } },
      nodes: [
        {
          id: "each",
          type: "map",
          with: {
            over: "{{ state.numbers }}",
            node: {
              type: "subgraph",
              spec: {
                metadata: { name: "sq" },
                state: { channels: { n: { type: "number" }, squared: { type: "number" } } },
                nodes: [],
                edges: [{ from: "START", to: "END" }],
              },
              with: { stateMap: { out: { squared: "squared" } } },
            },
            collect: { to: "squares" },
          },
        },
      ],
      edges: [
        { from: "START", to: "each" },
        { from: "each", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec);

    expect(diags.some((d) => d.code === "UNDECLARED_OUTPUT_CHANNEL" && d.message.includes("squared"))).toBe(false);
    expect(diags.some((d) => d.code === "SUBGRAPH_OUTPUT_UNKNOWN")).toBe(false);
  });

  it("flags a file subgraph whose stateMap.out names a missing child channel", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-merge-lint-"));
    await fs.writeFile(
      path.join(dir, "parent.graph.yaml"),
      yaml.stringify({
        apiVersion: "flowgraph/v1",
        kind: "Graph",
        metadata: { name: "bad-parent" },
        state: { channels: { note: { type: "string" } } },
        nodes: [
          {
            id: "embed",
            type: "subgraph",
            uses: "./child-log.graph.yaml",
            with: { stateMap: { out: { note: "nope" } } },
          },
        ],
        edges: [
          { from: "START", to: "embed" },
          { from: "embed", to: "END" },
        ],
        runtime: { checkpoint: { enabled: false } },
      }),
    );
    await fs.copyFile(path.join(fixtureDir, "child-log.graph.yaml"), path.join(dir, "child-log.graph.yaml"));
    const loaded = await loadGraph(path.join(dir, "parent.graph.yaml"), { cwd: dir });
    expect(loaded.spec).toBeTruthy();
    expect(
      loaded.diagnostics.some(
        (d) => d.code === "SUBGRAPH_OUTPUT_UNKNOWN" && d.message.includes("nope") && d.severity === "error",
      ),
    ).toBe(true);
  });
});
