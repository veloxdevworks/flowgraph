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

describe("stored graph YAML", () => {
  const yaml = MINIMAL_WITH_ENV();
  function MINIMAL_WITH_ENV(): string {
    return MINIMAL.replace(/name: hello/, "name: hello\n  description: \"${FG_GS_TEST_VALUE}\"");
  }

  const declared = MINIMAL
    .replace("state:", () => 'secrets: [FG_GS_TEST_VALUE]\nconfig:\n  vars: { token: "${FG_GS_TEST_VALUE}", escaped: "$${FG_GS_TEST_VALUE}", other: "$${FG_GS_NOT_DECLARED}" }\nstate:')
    .replace("fn: missing", () => 'fn: missing\n      input: { body: "${FG_GS_TEST_BODY}", kept: "$${FG_GS_TEST_BODY}" }');

  /** Run `fn` with `process.env` replaced by a view that records every name looked up. */
  function recordingEnv<T>(fn: () => T): { result: T; read: Set<string> } {
    const real = process.env;
    const read = new Set<string>();
    process.env = new Proxy(real, {
      get: (target, key) => (typeof key === "string" && read.add(key), Reflect.get(target, key)),
      has: (target, key) => (typeof key === "string" && read.add(key), Reflect.has(target, key)),
      getOwnPropertyDescriptor: (target, key) => (typeof key === "string" && read.add(key), Reflect.getOwnPropertyDescriptor(target, key)),
    });
    try {
      return { result: fn(), read };
    } finally {
      process.env = real;
    }
  }

  it("expands only declared names in config, never node bodies or metadata, and keeps $${X} literal", () => {
    process.env["FG_GS_TEST_VALUE"] = "declared-value";
    process.env["FG_GS_TEST_BODY"] = "body-value";
    try {
      const { result: parsed, read } = recordingEnv(() => parseGraphYaml(declared, { expandEnv: true }));
      expect(parsed.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const spec = parsed.spec!;
      expect(spec.config?.vars).toEqual({ token: "declared-value", escaped: "${FG_GS_TEST_VALUE}", other: "${FG_GS_NOT_DECLARED}" });
      const w = spec.nodes[0]!.with as { input: Record<string, string> };
      expect(w.input).toEqual({ body: "${FG_GS_TEST_BODY}", kept: "$${FG_GS_TEST_BODY}" });
      expect(read.has("FG_GS_TEST_VALUE")).toBe(true);
      expect(read.has("FG_GS_TEST_BODY")).toBe(false);
      expect(parsed.yaml).toBe(declared);

      const meta = parseGraphYaml(yaml, { expandEnv: true });
      expect(meta.spec?.metadata?.description).toBe("${FG_GS_TEST_VALUE}");
    } finally {
      delete process.env["FG_GS_TEST_VALUE"];
      delete process.env["FG_GS_TEST_BODY"];
    }
  });

  it("refuses an undeclared ${NAME} in config without reading it", () => {
    process.env["FG_GS_TEST_BODY"] = "body-value";
    try {
      const undeclared = MINIMAL.replace("state:", 'config:\n  vars: { token: "${FG_GS_TEST_BODY}" }\nstate:');
      const { result: parsed, read } = recordingEnv(() => parseGraphYaml(undeclared, { expandEnv: true }));
      expect(parsed.spec).toBeNull();
      expect(read.has("FG_GS_TEST_BODY")).toBe(false);
      expect(parsed.yaml).not.toContain("body-value");
      expect(parsed.diagnostics.filter((d) => d.code === "SECRET_UNDECLARED").map((d) => d.path)).toEqual(["config.vars.token"]);
    } finally {
      delete process.env["FG_GS_TEST_BODY"];
    }
  });

  it("keeps expanded values of any length out of schema and validation diagnostics", () => {
    const badBackend = (value: string) => {
      process.env["FG_GS_TEST_VALUE"] = value;
      return parseGraphYaml(
        MINIMAL.replace("state:", () => 'secrets: [FG_GS_TEST_VALUE]\nruntime:\n  checkpoint: { backend: "${FG_GS_TEST_VALUE}" }\nstate:'),
        { expandEnv: true },
      );
    };
    try {
      for (const value of ["leaky-backend-value", "zq9"]) {
        const parsed = badBackend(value);
        expect(parsed.spec).toBeNull();
        const text = JSON.stringify(parsed.diagnostics);
        expect(parsed.diagnostics.some((d) => d.path?.startsWith("runtime.checkpoint") && d.message.includes("[REDACTED]"))).toBe(true);
        expect(text).not.toContain(value);
        expect(parsed.yaml).not.toContain(value);
      }
    } finally {
      delete process.env["FG_GS_TEST_VALUE"];
    }
  });

  it("stores raw YAML and expands declared config values only when asked", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-graphs-raw-"));
    process.env["FG_GS_TEST_VALUE"] = "declared-value";
    try {
      const parsed = parseGraphYaml(declared, { expandEnv: true });
      expect(parsed.spec?.config?.vars?.token).toBe("declared-value");
      await persistGraph(dir, "t", parsed.yaml, parsed.spec!, { yamlFormat: "raw" });
      const stored = await fs.readFile(path.join(dir, "t.graph.yaml"), "utf-8");
      expect(stored).toBe(declared);
      expect(stored).not.toContain("declared-value");
      const plain = await loadPersistedGraph(dir, "t");
      expect(plain?.spec.config?.vars?.token).toBe("${FG_GS_TEST_VALUE}");
      expect(plain?.yaml).toBe(declared);
      const trusted = await loadPersistedGraph(dir, "t", { expandEnv: true });
      expect(trusted?.spec.config?.vars).toEqual({ token: "declared-value", escaped: "${FG_GS_TEST_VALUE}", other: "${FG_GS_NOT_DECLARED}" });
      expect(trusted?.yaml).toBe(declared);
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
