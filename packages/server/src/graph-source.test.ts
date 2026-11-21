import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("rejects client imports explicitly", () => {
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
    expect(result.spec).toBeNull();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({code:"UPLOAD_IMPORTS_BLOCKED"}));
  });

  it("rejects imports from inline subgraphs and map inners at any depth", () => {
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
    expect(result.spec).toBeNull();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({code:"UPLOAD_IMPORTS_BLOCKED"}));
  });

  it("rejects invalid yaml", () => {
    const result = parseGraphYaml("::: not yaml");
    expect(result.spec).toBeNull();
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});

describe("listPersistedGraphs", () => {
  it("loads pre-upgrade stored graphs while stripping their imports", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-legacy-imports-"));
    try {
      const parsed = parseGraphYaml(MINIMAL);
      const yaml = `${MINIMAL}\nimports:\n  - { providers: "./never-execute.mjs" }\n`;
      await persistGraph(dir, "legacy", yaml, parsed.spec!, { yamlFormat: "raw" });
      const loaded = await loadPersistedGraph(dir, "legacy");
      expect(loaded?.spec.metadata.name).toBe("hello");
      expect(loaded?.spec.imports).toBeUndefined();
      expect(loaded?.yaml).toBe(yaml);
      expect(parseGraphYaml(yaml).diagnostics).toContainEqual(
        expect.objectContaining({ code: "UPLOAD_IMPORTS_BLOCKED" }),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

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

describe("${VAR} expansion", () => {
  const withEnv = (head: string, body = "") =>
    MINIMAL.replace("state:", () => `${head}state:`).replace("      fn: missing\n", () => `      fn: missing\n${body}`);
  const DECLARED = withEnv(
    'secrets: [FG_GS_TEST_VALUE]\nconfig:\n  vars: { token: "${FG_GS_TEST_VALUE}", escaped: "$${FG_GS_TEST_VALUE}", other: "$${FG_GS_OTHER}" }\n',
    '      args: { body: "${FG_GS_TEST_VALUE}", escaped: "$${FG_GS_TEST_VALUE}" }\n',
  );
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("never expands text outside config and runtime, even for a declared name", () => {
    vi.stubEnv("FG_GS_TEST_VALUE", "expanded-value-1234");
    const yaml = withEnv(
      "secrets: [FG_GS_TEST_VALUE]\n",
      '      args: { prompt: "say ${FG_GS_TEST_VALUE}" }\n',
    ).replace("name: hello", () => 'name: hello\n  description: "${FG_GS_TEST_VALUE}"');
    const parsed = parseGraphYaml(yaml, { expandEnv: true });
    expect(parsed.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(parsed.spec?.metadata?.description).toBe("${FG_GS_TEST_VALUE}");
    expect(parsed.spec?.nodes[0]?.with).toMatchObject({ args: { prompt: "say ${FG_GS_TEST_VALUE}" } });
    expect(JSON.stringify(parsed.spec)).not.toContain("expanded-value-1234");
  });

  it("expands a declared config value, keeps $${X} as ${X}, and leaves node bodies literal", () => {
    vi.stubEnv("FG_GS_TEST_VALUE", "expanded-value-1234");
    vi.stubEnv("FG_GS_OTHER", "other-value-5678");
    const parsed = parseGraphYaml(DECLARED, { expandEnv: true });
    expect(parsed.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(parsed.spec?.config?.vars).toEqual({ token: "expanded-value-1234", escaped: "${FG_GS_TEST_VALUE}", other: "${FG_GS_OTHER}" });
    expect(parsed.spec?.nodes[0]?.with).toMatchObject({ args: { body: "${FG_GS_TEST_VALUE}", escaped: "$${FG_GS_TEST_VALUE}" } });
    expect(parsed.yaml).toBe(DECLARED);
  });

  it("refuses an undeclared config placeholder once, and never reads its value", () => {
    vi.stubEnv("FG_GS_UNDECLARED", "must-not-appear-1234");
    const yaml = withEnv('config:\n  vars: { token: "${FG_GS_UNDECLARED}" }\n');
    for (const expandEnv of [true, false]) {
      const parsed = parseGraphYaml(yaml, { expandEnv });
      expect(parsed.spec).toBeNull();
      expect(parsed.diagnostics.filter((d) => d.code === "SECRET_UNDECLARED").map((d) => d.path)).toEqual(["config.vars.token"]);
      expect(JSON.stringify(parsed)).not.toContain("must-not-appear-1234");
    }
  });

  it("does not read the environment unless asked", () => {
    vi.stubEnv("FG_GS_TEST_VALUE", "expanded-value-1234");
    expect(parseGraphYaml(DECLARED).spec?.config?.vars).toMatchObject({ token: "${FG_GS_TEST_VALUE}" });
  });

  it("stores raw YAML and expands it only into the loaded spec of a trusted author", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-graphs-raw-"));
    vi.stubEnv("FG_GS_TEST_VALUE", "expanded-value-1234");
    try {
      const parsed = parseGraphYaml(DECLARED, { expandEnv: true });
      expect(parsed.spec?.config?.vars?.["token"]).toBe("expanded-value-1234");
      await persistGraph(dir, "t", parsed.yaml, parsed.spec!, { yamlFormat: "raw" });
      expect(await fs.readFile(path.join(dir, "t.graph.yaml"), "utf-8")).toBe(DECLARED);
      const plain = await loadPersistedGraph(dir, "t");
      expect(plain?.spec.config?.vars?.["token"]).toBe("${FG_GS_TEST_VALUE}");
      expect(plain?.yaml).toBe(DECLARED);
      const trusted = await loadPersistedGraph(dir, "t", { expandEnv: true });
      expect(trusted?.spec.config?.vars).toEqual({ token: "expanded-value-1234", escaped: "${FG_GS_TEST_VALUE}", other: "${FG_GS_OTHER}" });
      expect(trusted?.yaml).toBe(DECLARED);
      expect(trusted?.meta?.yamlFormat).toBe("raw");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("never expands files stored by older servers", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-graphs-legacy-"));
    vi.stubEnv("FG_GS_TEST_VALUE", "expanded-value-1234");
    try {
      const parsed = parseGraphYaml(DECLARED, { expandEnv: false });
      await persistGraph(dir, "t", DECLARED, parsed.spec!);
      const loaded = await loadPersistedGraph(dir, "t", { expandEnv: true });
      expect(loaded?.meta?.yamlFormat).toBeUndefined();
      expect(loaded?.spec.config?.vars?.["token"]).toBe("${FG_GS_TEST_VALUE}");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
describe("unexpanded config placeholders", () => {
  it("refuses an undeclared ${NAME} left in a server-parsed graph", () => {
    const yaml = MINIMAL.replace("state:", 'config:\n  vars: { token: "${FG_GS_UNDECLARED}" }\nstate:');
    const parsed = parseGraphYaml(yaml, { expandEnv: false });
    expect(parsed.spec).toBeNull();
    expect(parsed.diagnostics.map((d) => [d.code, d.path, d.message])).toContainEqual([
      "SECRET_UNDECLARED",
      "config.vars.token",
      '`${FG_GS_UNDECLARED}` reads secret "FG_GS_UNDECLARED", which the graph does not declare. Add FG_GS_UNDECLARED to the top-level secrets: list.',
    ]);
  });
});

describe("host-support triggers", () => {
  it("warns that the server ignores triggers and still returns the spec", () => {
    const yaml = `
apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: hello
triggers:
  - { id: nightly, type: cron, schedule: "0 2 * * *" }
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
    expect(result.spec).not.toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "TRIGGERS_HOST_UNSUPPORTED", severity: "warning" }),
    );
    expect(result.diagnostics.find((d) => d.code === "TRIGGERS_HOST_UNSUPPORTED")?.message).toContain("flowgraph server");
    expect(result.diagnostics.find((d) => d.code === "TRIGGERS_HOST_UNSUPPORTED")?.message).not.toMatch(/phase/i);
  });
});
