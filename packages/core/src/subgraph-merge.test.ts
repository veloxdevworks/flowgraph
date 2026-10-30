import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "yaml";
import { compileGraph } from "./compiler.js";
import { loadGraph, validateSpec } from "./loader.js";
import { registerFunction } from "./nodes/function.js";
import { childChannelRefsInMapping, reducerInput } from "./nodes/subgraph-merge.js";
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
