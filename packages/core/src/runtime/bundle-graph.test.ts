import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import yaml from "yaml";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import { bundleGraphForRemote } from "./bundle-graph.js";

let fixtureDir = "";

const leafChild: GraphSpec = {
  apiVersion: "flowgraph/v1",
  kind: "Graph",
  metadata: { name: "leaf-child" },
  nodes: [
    {
      id: "echo",
      type: "script",
      with: { code: "export default ({ input }) => ({ ok: true, value: input?.x ?? null });" },
    },
  ],
  edges: [
    { from: "START", to: "echo" },
    { from: "echo", to: "END" },
  ],
};

const midChild: GraphSpec = {
  apiVersion: "flowgraph/v1",
  kind: "Graph",
  metadata: { name: "mid-child" },
  imports: [{ subgraph: "./leaf.graph.yaml", as: "leaf" }],
  nodes: [
    {
      id: "run-leaf",
      type: "subgraph",
      uses: "leaf",
    },
  ],
  edges: [
    { from: "START", to: "run-leaf" },
    { from: "run-leaf", to: "END" },
  ],
};

beforeAll(async () => {
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "flowgraph-bundle-"));
  await fs.writeFile(path.join(fixtureDir, "leaf.graph.yaml"), yaml.stringify(leafChild));
  await fs.writeFile(path.join(fixtureDir, "mid.graph.yaml"), yaml.stringify(midChild));
  await fs.mkdir(path.join(fixtureDir, "agents", "reviewer"), { recursive: true });
  await fs.writeFile(
    path.join(fixtureDir, "agents", "reviewer", "AGENT.md"),
    `---
name: reviewer
---
You are a careful code reviewer.
`,
  );
});

afterAll(async () => {
  if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
});

describe("bundleGraphForRemote", () => {
  it("inlines a one-level subgraph uses → spec", async () => {
    const parent: GraphSpec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "parent" },
      imports: [{ subgraph: "./leaf.graph.yaml", as: "leaf" }],
      nodes: [{ id: "embed", type: "subgraph", uses: "leaf" }],
      edges: [
        { from: "START", to: "embed" },
        { from: "embed", to: "END" },
      ],
    };

    const result = await bundleGraphForRemote(parent, { cwd: fixtureDir });
    expect(result.blockers).toEqual([]);
    expect(result.inlined.some((n) => n.includes('subgraph "embed"') && n.includes("inlined 1 node"))).toBe(
      true,
    );
    const embed = result.spec.nodes.find((n) => n.id === "embed")!;
    expect(embed.uses).toBeUndefined();
    expect(embed.spec?.metadata?.name).toBe("leaf-child");
    expect(embed.spec?.nodes[0]?.id).toBe("echo");
    expect(result.spec.imports).toBeUndefined();
  });

  it("inlines nested subgraphs two levels deep", async () => {
    const parent: GraphSpec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "nested-parent" },
      nodes: [{ id: "mid", type: "subgraph", uses: "./mid.graph.yaml" }],
      edges: [
        { from: "START", to: "mid" },
        { from: "mid", to: "END" },
      ],
    };

    const result = await bundleGraphForRemote(parent, { cwd: fixtureDir });
    expect(result.blockers).toEqual([]);
    const mid = result.spec.nodes.find((n) => n.id === "mid")!;
    expect(mid.spec).toBeDefined();
    const runLeaf = mid.spec!.nodes.find((n) => n.id === "run-leaf")!;
    expect(runLeaf.uses).toBeUndefined();
    expect(runLeaf.spec?.metadata?.name).toBe("leaf-child");
    expect(result.inlined.length).toBeGreaterThanOrEqual(2);
  });

  it("inlines AGENT.md as with.system (no pre-existing system)", async () => {
    const parent: GraphSpec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "agent-parent" },
      imports: [{ agent: "./agents/reviewer", as: "reviewer" }],
      providers: {
        mock: { kind: "langchain", vendor: "openai", model: "gpt-4o-mini" },
      },
      nodes: [
        {
          id: "review",
          type: "agent",
          provider: "mock",
          with: { agent: "reviewer", prompt: "Review {{ input.text }}" },
        },
      ],
      edges: [
        { from: "START", to: "review" },
        { from: "review", to: "END" },
      ],
    };

    const result = await bundleGraphForRemote(parent, { cwd: fixtureDir });
    expect(result.blockers).toEqual([]);
    const review = result.spec.nodes.find((n) => n.id === "review")!;
    const withBlock = review.with as { agent?: string; system?: string; prompt?: string };
    expect(withBlock.agent).toBeUndefined();
    expect(withBlock.system).toContain("careful code reviewer");
    expect(result.inlined.some((n) => n.includes('agent "review"') && n.includes("with.system"))).toBe(
      true,
    );
    expect(result.spec.imports).toBeUndefined();
  });

  it("appends existing with.system after AGENT.md body", async () => {
    const parent: GraphSpec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "agent-append" },
      nodes: [
        {
          id: "review",
          type: "agent",
          provider: "mock",
          with: {
            agent: "./agents/reviewer",
            system: "Be terse.",
            prompt: "Go",
          },
        },
      ],
      edges: [
        { from: "START", to: "review" },
        { from: "review", to: "END" },
      ],
    };

    const result = await bundleGraphForRemote(parent, { cwd: fixtureDir });
    expect(result.blockers).toEqual([]);
    const withBlock = result.spec.nodes[0]!.with as { system?: string };
    expect(withBlock.system).toBe("You are a careful code reviewer.\n\nBe terse.");
  });

  it("reports blockers for skill, custom imports, stdio MCP, and shell", async () => {
    const parent: GraphSpec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "blocked" },
      imports: [
        { skill: "./skills/foo" },
        { nodes: "./custom-nodes.ts" },
        { providers: "./custom-providers.ts" },
        { reducers: "./custom-reducers.ts" },
      ],
      mcpServers: {
        local: { transport: "stdio", command: "npx", args: ["-y", "fake-mcp"] },
      },
      nodes: [
        { id: "run-skill", type: "skill", uses: "foo" },
        { id: "sh", type: "shell", with: { command: "echo hi" } },
      ],
      edges: [
        { from: "START", to: "run-skill" },
        { from: "run-skill", to: "sh" },
        { from: "sh", to: "END" },
      ],
    };

    const result = await bundleGraphForRemote(parent, { cwd: fixtureDir });
    expect(result.blockers.some((b) => b.includes("imports.skill"))).toBe(true);
    expect(result.blockers.some((b) => b.includes("imports.nodes"))).toBe(true);
    expect(result.blockers.some((b) => b.includes("imports.providers"))).toBe(true);
    expect(result.blockers.some((b) => b.includes("imports.reducers"))).toBe(true);
    expect(result.blockers.some((b) => b.includes("mcpServers.local") && b.includes("stdio"))).toBe(
      true,
    );
    expect(result.blockers.some((b) => b.includes('type skill'))).toBe(true);
    expect(result.blockers.some((b) => b.includes('type shell'))).toBe(true);
  });

  it("is idempotent on an already-bundled spec", async () => {
    const parent: GraphSpec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "parent" },
      nodes: [{ id: "embed", type: "subgraph", uses: "./leaf.graph.yaml" }],
      edges: [
        { from: "START", to: "embed" },
        { from: "embed", to: "END" },
      ],
    };

    const once = await bundleGraphForRemote(parent, { cwd: fixtureDir });
    const twice = await bundleGraphForRemote(once.spec, { cwd: fixtureDir });
    expect(twice.blockers).toEqual([]);
    expect(twice.spec.nodes[0]?.spec?.metadata?.name).toBe("leaf-child");
    expect(twice.spec.nodes[0]?.uses).toBeUndefined();
    // Second pass should not re-emit the "uses → inlined" note (already inline).
    expect(twice.inlined.some((n) => n.includes("uses:"))).toBe(false);
  });
});
