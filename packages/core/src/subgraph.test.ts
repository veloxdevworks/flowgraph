import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import yaml from "yaml";
import { compileGraph } from "./compiler.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";

let fixtureDir = "";

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
