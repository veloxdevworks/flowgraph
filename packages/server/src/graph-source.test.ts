import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { persistGraph, listPersistedGraphs, loadPersistedGraph, parseGraphYaml, appendEventJournal, loadEventJournal } from "./graph-source.js";
import { SessionRegistry } from "./session-registry.js";
import type { ServerEvent } from "./types.js";

const MINIMAL = `
apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: hello
state:
  channels:
    text: { type: string }
nodes:
  - id: echo
    type: function
    with:
      fn: missing
edges:
  - { from: START, to: echo }
  - { from: echo, to: END }
`;

describe("parseGraphYaml", () => {
  it("parses a minimal graph", () => {
    const result = parseGraphYaml(MINIMAL);
    if (!result.spec) {
      throw new Error(result.diagnostics.map((d) => d.message).join("; "));
    }
    expect(result.spec.metadata.name).toBe("hello");
    expect(result.importsStripped).toBe(false);
  });

  it("strips client imports", () => {
    const yaml = `
apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: hello
imports:
  - { reducers: "./register.ts" }
state:
  channels:
    text: { type: string }
nodes:
  - id: echo
    type: function
    with:
      fn: missing
edges:
  - { from: START, to: echo }
  - { from: echo, to: END }
`;
    const result = parseGraphYaml(yaml);
    if (!result.spec) {
      throw new Error(result.diagnostics.map((d) => d.message).join("; "));
    }
    expect(result.importsStripped).toBe(true);
    expect(result.spec.imports).toBeUndefined();
  });

  it("strips imports from inline subgraphs and map inners at any depth", () => {
    const yaml = `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: nested-imports }
state:
  channels:
    items: { type: array }
nodes:
  - id: sg
    type: subgraph
    spec:
      apiVersion: flowgraph/v1
      kind: Graph
      metadata: { name: child }
      imports:
        - { providers: "/tmp/anything.mjs" }
      nodes:
        - id: inner
          type: subgraph
          spec:
            apiVersion: flowgraph/v1
            kind: Graph
            metadata: { name: grandchild }
            imports:
              - { nodes: "/tmp/anything.mjs" }
            nodes:
              - { id: w, type: wait, with: { duration: "1ms" } }
            edges:
              - { from: START, to: w }
              - { from: w, to: END }
      edges:
        - { from: START, to: inner }
        - { from: inner, to: END }
  - id: m
    type: map
    with:
      over: "{{ state.items }}"
      node:
        id: each
        type: subgraph
        spec:
          apiVersion: flowgraph/v1
          kind: Graph
          metadata: { name: per-item }
          imports:
            - { reducers: "/tmp/anything.mjs" }
          nodes:
            - { id: w, type: wait, with: { duration: "1ms" } }
          edges:
            - { from: START, to: w }
            - { from: w, to: END }
edges:
  - { from: START, to: sg }
  - { from: sg, to: m }
  - { from: m, to: END }
`;
    const result = parseGraphYaml(yaml, { expandEnv: false });
    if (!result.spec) throw new Error(result.diagnostics.map((d) => d.message).join("; "));
    expect(result.importsStripped).toBe(true);
    expect(JSON.stringify(result.spec)).not.toContain("anything.mjs");
  });

  it("rejects invalid yaml", () => {
    const result = parseGraphYaml("::: not yaml");
    expect(result.spec).toBeNull();
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});

describe("listPersistedGraphs", () => {
  it("lists meta for persisted graphs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-graphs-"));
    try {
      const parsed = parseGraphYaml(MINIMAL);
      expect(parsed.spec).toBeTruthy();
      await persistGraph(dir, "thread-a", parsed.yaml, parsed.spec!, { label: "Alpha" });
      const list = await listPersistedGraphs(dir);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ threadId: "thread-a", label: "Alpha", graphName: "hello" });
      const loaded = await loadPersistedGraph(dir, "thread-a");
      expect(loaded?.meta?.label).toBe("Alpha");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("event journal", () => {
  it("appends and reloads events; cold subscribe replays jsonl", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-journal-"));
    try {
      const event: ServerEvent = {
        id: "e1",
        type: "node.end",
        ts: "2026-01-01T00:00:00.000Z",
        runId: "r1",
        threadId: "t-lab",
        graph: "hello",
        scope: {},
        data: { nodeId: "echo" },
        seq: 3,
      };
      appendEventJournal(dir, "t-lab", event);
      const loaded = loadEventJournal(dir, "t-lab");
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toMatchObject({ type: "node.end", seq: 3 });

      const registry = new SessionRegistry(10, {
        onPersist: (threadId, ev) => appendEventJournal(dir, threadId, ev),
        loadJournal: (threadId) => loadEventJournal(dir, threadId),
      });
      const replayed: number[] = [];
      registry.subscribe("t-lab", (ev) => replayed.push(ev.seq), 0);
      expect(replayed).toContain(3);
      expect(registry.get("t-lab")?.lastSeq).toBe(3);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("stored graph YAML", () => {
  const yaml = MINIMAL_WITH_ENV();
  function MINIMAL_WITH_ENV(): string {
    return MINIMAL.replace(/name: hello/, "name: hello\n  description: \"${FG_GS_TEST_VALUE}\"");
  }

  it("stores raw YAML and expands it only when asked", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-graphs-raw-"));
    process.env["FG_GS_TEST_VALUE"] = "expanded-value";
    try {
      const parsed = parseGraphYaml(yaml, { expandEnv: true });
      expect(parsed.spec?.metadata?.description).toBe("expanded-value");
      await persistGraph(dir, "t", yaml, parsed.spec!, { yamlFormat: "raw" });
      expect(await fs.readFile(path.join(dir, "t.graph.yaml"), "utf-8")).not.toContain("expanded-value");
      const plain = await loadPersistedGraph(dir, "t");
      expect(plain?.spec.metadata?.description).toBe("${FG_GS_TEST_VALUE}");
      expect(plain?.yaml).toBe(yaml);
      const trusted = await loadPersistedGraph(dir, "t", { expandEnv: true });
      expect(trusted?.spec.metadata?.description).toBe("expanded-value");
      expect(trusted?.yaml).toBe(yaml);
      expect(trusted?.meta?.yamlFormat).toBe("raw");
    } finally {
      delete process.env["FG_GS_TEST_VALUE"];
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("never expands files stored by older servers", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-graphs-legacy-"));
    process.env["FG_GS_TEST_VALUE"] = "expanded-value";
    try {
      const parsed = parseGraphYaml(yaml, { expandEnv: false });
      await persistGraph(dir, "t", yaml, parsed.spec!);
      const loaded = await loadPersistedGraph(dir, "t", { expandEnv: true });
      expect(loaded?.meta?.yamlFormat).toBeUndefined();
      expect(loaded?.spec.metadata?.description).toBe("${FG_GS_TEST_VALUE}");
    } finally {
      delete process.env["FG_GS_TEST_VALUE"];
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
