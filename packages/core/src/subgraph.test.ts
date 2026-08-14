import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import yaml from "yaml";
import { compileGraph } from "./compiler.js";
import { loadGraph } from "./loader.js";
import { registerFunction } from "./nodes/function.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

let fixtureDir = "";

beforeAll(() => {
  registerFunction("echoBang", (input) => {
    const value = (input as { value?: string }).value ?? "ok";
    return `${value}!`;
  });
});

const childSpec: GraphSpec = {
  apiVersion: "flowgraph/v1",
  kind: "Graph",
  metadata: { name: "child-hitl" },
  state: { channels: { gateResult: { type: "object" } } },
  nodes: [
    {
      id: "human-gate",
      type: "hitl",
      with: {
        mode: "approve",
        message: "Approve nested subgraph step?",
        output: { to: "gateResult" },
      },
    },
  ],
  edges: [
    { from: "START", to: "human-gate" },
    { from: "human-gate", to: "END" },
  ],
  runtime: { checkpoint: { enabled: true, backend: "memory" } },
} as unknown as GraphSpec;

beforeAll(async () => {
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "flowgraph-subgraph-"));
  await fs.writeFile(path.join(fixtureDir, "child.graph.yaml"), yaml.stringify(childSpec));
});

afterAll(async () => {
  if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
});

function parentSpec(): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "parent-subgraph" },
    state: {
      channels: {
        topic: { type: "string", default: "demo" },
        approval: { type: "object" },
      },
    },
    nodes: [
      {
        id: "embed",
        type: "subgraph",
        uses: "./child.graph.yaml",
        with: {
          stateMap: {
            in: { topic: "topic" },
            out: { approval: "gateResult" },
          },
        },
      },
    ],
    edges: [
      { from: "START", to: "embed" },
      { from: "embed", to: "END" },
    ],
    runtime: { checkpoint: { enabled: true, backend: "memory" } },
  } as unknown as GraphSpec;
}

describe("nested subgraph HITL", () => {
  it("propagates child interrupt to the parent run", async () => {
    const compiled = await compileGraph(parentSpec(), { cwd: fixtureDir, checkpointer: "memory" });
    const result = await compiled.run({ threadId: "sub-1", input: { topic: "hello" }, onInterrupt: "fail" });

    expect(result.status).toBe("interrupted");
    expect(result.interrupts?.[0]?.reason).toContain("Approve nested subgraph step");
  });

  it("resumes through the child and projects state back via stateMap.out", async () => {
    const compiled = await compileGraph(parentSpec(), { cwd: fixtureDir, checkpointer: "memory" });
    const first = await compiled.run({ threadId: "sub-2", onInterrupt: "fail" });
    expect(first.status).toBe("interrupted");

    const resumed = await compiled.resume({ threadId: "sub-2", resume: { approved: true } });
    expect(resumed.status).toBe("completed");
    expect((resumed.state["approval"] as { approved?: boolean }).approved).toBe(true);
  });
});

describe("nested subgraph events", () => {
  it("forwards child node.start/node.end onto the parent bus with parentSpanId", async () => {
    const simpleChild: GraphSpec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "child-simple" },
      state: { channels: { value: { type: "string" }, out: { type: "string" } } },
      nodes: [
        {
          id: "echo",
          type: "function",
          with: {
            fn: "echoBang",
            input: { value: "{{ state.value }}" },
            output: { to: "out" },
          },
        },
      ],
      edges: [
        { from: "START", to: "echo" },
        { from: "echo", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;

    await fs.writeFile(path.join(fixtureDir, "simple-child.graph.yaml"), yaml.stringify(simpleChild));

    const parent: GraphSpec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "parent-events" },
      state: {
        channels: {
          value: { type: "string", default: "hi" },
          result: { type: "string" },
        },
      },
      nodes: [
        {
          id: "embed",
          type: "subgraph",
          uses: "./simple-child.graph.yaml",
          with: {
            stateMap: {
              in: { value: "value" },
              out: { result: "out" },
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

    const compiled = await compileGraph(parent, { cwd: fixtureDir, checkpointer: "none" });
    const seen: { type: string; nodeId?: string; parentSpanId?: string }[] = [];
    compiled.events.subscribe((ev) => {
      seen.push({
        type: ev.type,
        ...(ev.scope.nodeId !== undefined ? { nodeId: ev.scope.nodeId } : {}),
        ...(ev.scope.parentSpanId !== undefined ? { parentSpanId: ev.scope.parentSpanId } : {}),
      });
    });

    const result = await compiled.run({ threadId: "evt-1", input: { value: "hi" } });
    expect(result.status).toBe("completed");

    const childStarts = seen.filter((e) => e.type === "node.start" && e.nodeId === "echo");
    const childEnds = seen.filter((e) => e.type === "node.end" && e.nodeId === "echo");
    expect(childStarts.length).toBeGreaterThanOrEqual(1);
    expect(childEnds.length).toBeGreaterThanOrEqual(1);
    expect(childStarts.every((e) => e.parentSpanId === "embed")).toBe(true);
    expect(childEnds.every((e) => e.parentSpanId === "embed")).toBe(true);

    const parentStarts = seen.filter((e) => e.type === "node.start" && e.nodeId === "embed");
    expect(parentStarts.length).toBeGreaterThanOrEqual(1);
    expect(parentStarts.every((e) => e.parentSpanId === undefined)).toBe(true);
  });
});

describe("subgraph file-relative imports", () => {
  it("resolves ../register.ts from a subgraph in a subfolder against the child file", async () => {
    // software-factory layout: parent/register.ts, parent/subgraphs/child.graph.yaml
    // with `{ reducers: ../register.ts }`. Parent-relative resolution would load
    // the decoy at fixtures/register.ts instead.
    const parentDir = path.join(__dirname, "runtime/fixtures/nested-subgraph-imports");
    const loaded = await loadGraph("parent.graph.yaml", { cwd: parentDir });
    expect(loaded.spec).not.toBeNull();

    const compiled = await compileGraph(loaded.spec!, {
      cwd: parentDir,
      graphPath: loaded.resolvedPath,
      checkpointer: "none",
    });
    const result = await compiled.run({ threadId: "nested-import-1" });

    expect(result.status).toBe("completed");
    expect(result.state["result"]).toEqual({ source: "graph-dir-register" });
  });
});
