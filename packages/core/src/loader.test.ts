import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { compileGraph } from "./compiler.js";
import {
  envExpansionCollisionDiagnostics,
  loadGraph,
  NODE_BODY_ENV_EXPANSION,
  validateSpec,
} from "./loader.js";
import { registerFunction } from "./nodes/function.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";

beforeAll(() => {
  registerFunction("emitA", () => "a");
  registerFunction("emitB", () => "b");
});

function parallelFanOutSpec(reducer: "append" | undefined): GraphSpec {
  return {
    metadata: { name: "parallel-fanout" },
    state: {
      channels: {
        tags: reducer === "append" ? { type: "array", reducer: "append" } : { type: "array" },
      },
    },
    nodes: [
      { id: "branch-a", type: "function", with: { fn: "emitA", output: { to: "tags" } } },
      { id: "branch-b", type: "function", with: { fn: "emitB", output: { to: "tags" } } },
    ],
    edges: [
      { from: "START", to: ["branch-a", "branch-b"] },
      { from: "branch-a", to: "END" },
      { from: "branch-b", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

describe("parallel fan-out reducer behavior", () => {
  it("append preserves both branch writes", async () => {
    const spec = parallelFanOutSpec("append");
    const compiled = await compileGraph(spec, {});
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect([...(r.state["tags"] as string[])].sort()).toEqual(["a", "b"]);
  });

  it("lastWrite keeps only one branch write", async () => {
    const spec = parallelFanOutSpec(undefined);
    const compiled = await compileGraph(spec, {});
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    const tags = r.state["tags"] as string[];
    expect(tags).toHaveLength(1);
    expect(["a", "b"]).toContain(tags[0]);
  });
});

describe("validateSpec graph lint", () => {
  it("warns when append reducer is paired with a non-array channel", () => {
    const diags = validateSpec({
      metadata: { name: "bad-reducer" },
      nodes: [],
      edges: [{ from: "START", to: "END" }],
      state: { channels: { x: { type: "string", reducer: "append" } } },
    } as unknown as GraphSpec);
    expect(diags.some((d) => d.code === "REDUCER_TYPE_MISMATCH")).toBe(true);
  });

  it("errors on unregistered custom reducer", () => {
    const diags = validateSpec({
      metadata: { name: "missing-custom" },
      nodes: [],
      edges: [{ from: "START", to: "END" }],
      state: { channels: { x: { type: "array", reducer: "custom:notRegisteredHere" } } },
    } as unknown as GraphSpec);
    expect(diags.some((d) => d.code === "UNREGISTERED_REDUCER" && d.severity === "error")).toBe(true);
  });

  it("warns for nodes not reachable from START", () => {
    const diags = validateSpec({
      metadata: { name: "orphan" },
      nodes: [
        { id: "live", type: "function", with: { fn: "emitA", output: { to: "tags" } } },
        { id: "orphan", type: "function", with: { fn: "emitB", output: { to: "tags" } } },
      ],
      edges: [
        { from: "START", to: "live" },
        { from: "live", to: "END" },
      ],
      state: { channels: { tags: { type: "array", reducer: "append" } } },
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec);
    expect(diags.some((d) => d.code === "UNREACHABLE_FROM_START" && d.message.includes("orphan"))).toBe(true);
  });

  it("errors when output.to targets an undeclared channel", () => {
    const diags = validateSpec({
      metadata: { name: "undeclared-to" },
      nodes: [
        { id: "shell-1", type: "shell", with: { command: "echo hi", output: { to: "shell" } } },
      ],
      edges: [
        { from: "START", to: "shell-1" },
        { from: "shell-1", to: "END" },
      ],
      state: { channels: {} },
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec);
    expect(
      diags.some(
        (d) =>
          d.code === "UNDECLARED_OUTPUT_CHANNEL" &&
          d.severity === "error" &&
          d.message.includes("shell") &&
          d.path === "nodes.shell-1.with.output",
      ),
    ).toBe(true);
  });

  it("errors when output.map keys target undeclared channels", () => {
    const diags = validateSpec({
      metadata: { name: "undeclared-map" },
      nodes: [
        {
          id: "a",
          type: "shell",
          with: {
            command: "echo hi",
            output: { map: { stdout: "{{ result.stdout }}", missing: "{{ result.stderr }}" } },
          },
        },
      ],
      edges: [
        { from: "START", to: "a" },
        { from: "a", to: "END" },
      ],
      state: { channels: { stdout: { type: "string" } } },
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec);
    const undeclared = diags.filter((d) => d.code === "UNDECLARED_OUTPUT_CHANNEL");
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0]!.message).toContain("missing");
  });

  it("errors when subgraph stateMap.out values target undeclared parent channels", () => {
    const diags = validateSpec({
      metadata: { name: "undeclared-statemap" },
      nodes: [
        {
          id: "child",
          type: "subgraph",
          uses: "child-graph",
          with: {
            stateMap: { out: { summary: "testResults" } },
          },
        },
      ],
      edges: [
        { from: "START", to: "child" },
        { from: "child", to: "END" },
      ],
      state: { channels: {} },
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec);
    expect(
      diags.some(
        (d) =>
          d.code === "UNDECLARED_OUTPUT_CHANNEL" &&
          d.message.includes("testResults") &&
          d.path === "nodes.child.with.stateMap.out",
      ),
    ).toBe(true);
  });

  it("does not error when output channels are declared", () => {
    const diags = validateSpec({
      metadata: { name: "declared-ok" },
      nodes: [
        { id: "shell-1", type: "shell", with: { command: "echo hi", output: { to: "shell" } } },
        {
          id: "map-1",
          type: "map",
          with: {
            over: "{{ state.items }}",
            node: { type: "shell", with: { command: "echo" } },
            collect: { to: "results" },
          },
        },
      ],
      edges: [
        { from: "START", to: "shell-1" },
        { from: "shell-1", to: "map-1" },
        { from: "map-1", to: "END" },
      ],
      state: {
        channels: {
          shell: { type: "object" },
          items: { type: "array" },
          results: { type: "array", reducer: "append" },
        },
      },
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec);
    expect(diags.some((d) => d.code === "UNDECLARED_OUTPUT_CHANNEL")).toBe(false);
  });

  it("errors when a node id collides with a state channel name", () => {
    const diags = validateSpec({
      metadata: { name: "node-channel-collision" },
      nodes: [
        { id: "survey", type: "function", with: { fn: "noop" } },
      ],
      edges: [
        { from: "START", to: "survey" },
        { from: "survey", to: "END" },
      ],
      state: { channels: { survey: { type: "object" } } },
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec);
    expect(
      diags.some(
        (d) =>
          d.code === "NODE_CHANNEL_NAME_COLLISION" &&
          d.severity === "error" &&
          d.message.includes("survey") &&
          d.path === "nodes.survey",
      ),
    ).toBe(true);
  });

  it("errors when a node id collides with an output.to channel", () => {
    const diags = validateSpec({
      metadata: { name: "output-to-collision" },
      nodes: [
        {
          id: "survey",
          type: "shell",
          with: { command: "echo hi", output: { to: "survey" } },
        },
      ],
      edges: [
        { from: "START", to: "survey" },
        { from: "survey", to: "END" },
      ],
      state: { channels: { survey: { type: "object" } } },
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec);
    expect(diags.some((d) => d.code === "NODE_CHANNEL_NAME_COLLISION")).toBe(true);
  });

  it("errors when a node is named outputs (reserved channel)", () => {
    const diags = validateSpec({
      metadata: { name: "outputs-collision" },
      nodes: [{ id: "outputs", type: "shell", with: { command: "echo hi" } }],
      edges: [
        { from: "START", to: "outputs" },
        { from: "outputs", to: "END" },
      ],
      state: { channels: {} },
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec);
    expect(
      diags.some(
        (d) => d.code === "NODE_CHANNEL_NAME_COLLISION" && d.message.includes("outputs"),
      ),
    ).toBe(true);
  });
});

describe("envExpansionCollisionDiagnostics", () => {
  const minimal = (shellWith: string) => `
apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: env-collision-test
nodes:
  - id: run
    type: shell
    with:
${shellWith}
edges:
  - { from: START, to: run }
  - { from: run, to: END }
`;

  it("warns on ${VAR} inside shell command", () => {
    const diags = envExpansionCollisionDiagnostics(
      minimal(`      command: |
        BRANCH="plan/\${SLUG}"
        echo "$BRANCH"
`),
    );
    expect(diags.some((d) => d.code === NODE_BODY_ENV_EXPANSION && d.path === "nodes.run.with.command")).toBe(
      true,
    );
    expect(diags.some((d) => d.message.includes("${SLUG}"))).toBe(true);
  });

  it("warns on ${VAR:-default} inside shell command", () => {
    const diags = envExpansionCollisionDiagnostics(
      minimal(`      command: 'echo "\${SPEC_SLUG:-}"'`),
    );
    expect(diags.some((d) => d.code === NODE_BODY_ENV_EXPANSION && d.message.includes("SPEC_SLUG"))).toBe(
      true,
    );
  });

  it("warns on ${VAR} inside shell args", () => {
    const diags = envExpansionCollisionDiagnostics(
      minimal(`      command: echo
      args:
        - "\${PLAN_TITLE}"
`),
    );
    expect(diags.some((d) => d.code === NODE_BODY_ENV_EXPANSION && d.path === "nodes.run.with.args[0]")).toBe(
      true,
    );
  });

  it("warns on ${VAR} inside shell env values", () => {
    const diags = envExpansionCollisionDiagnostics(
      minimal(`      command: echo hi
      env:
        X: "\${CODEBASE_PATH:-/tmp}"
`),
    );
    expect(diags.some((d) => d.code === NODE_BODY_ENV_EXPANSION && d.path === "nodes.run.with.env.X")).toBe(
      true,
    );
  });

  it("does not warn on bare $VAR (unbraced)", () => {
    const diags = envExpansionCollisionDiagnostics(
      minimal(`      command: |
        BRANCH="plan/$SLUG"
        echo "$SPEC_SLUG"
`),
    );
    expect(diags.some((d) => d.code === NODE_BODY_ENV_EXPANSION)).toBe(false);
  });

  it("does not warn on ${VAR} inside config/runtime (legitimate load-time use)", () => {
    const yaml = `
apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: ok-config-env
config:
  defaults:
    model: "\${FLOWGRAPH_MODEL:-claude-sonnet-4.5}"
  vars:
    project: "\${FLOWGRAPH_PROJECT}"
runtime:
  checkpoint:
    enabled: true
    path: "\${FLOWGRAPH_CHECKPOINT_PATH:-.flowgraph/checkpoints.db}"
nodes:
  - id: run
    type: shell
    with:
      command: echo hi
edges:
  - { from: START, to: run }
  - { from: run, to: END }
`;
    const diags = envExpansionCollisionDiagnostics(yaml);
    expect(diags.some((d) => d.code === NODE_BODY_ENV_EXPANSION)).toBe(false);
  });

  it("loadGraph returns NODE_BODY_ENV_EXPANSION on the success path", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-env-lint-"));
    const file = path.join(dir, "g.graph.yaml");
    await fs.writeFile(
      file,
      minimal(`      command: 'BRANCH="plan/\${SLUG}"'`),
      "utf8",
    );
    try {
      const { spec, diagnostics } = await loadGraph(file, { cwd: dir });
      expect(spec).not.toBeNull();
      expect(
        diagnostics.some(
          (d) => d.code === NODE_BODY_ENV_EXPANSION && d.severity === "warning",
        ),
      ).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("normalizeNodeTypeAliases", () => {
  it("rewrites deprecated code/intelligent types and hook phases", async () => {
    const { normalizeNodeTypeAliases } = await import("./loader.js");
    const parsed = normalizeNodeTypeAliases({
      nodes: [
        { id: "a", type: "code", with: { fn: "x" } },
        { id: "b", type: "intelligent", with: { prompt: "hi" } },
        {
          id: "m",
          type: "map",
          with: { items: "{{ state.xs }}", node: { type: "code", with: { fn: "y" } } },
        },
      ],
      runtime: {
        hooks: [{ on: "intelligent:beforeToolCall", do: "interrupt" }],
      },
    }) as {
      nodes: Array<{ type: string; with?: { node?: { type: string } } }>;
      runtime: { hooks: Array<{ on: string }> };
    };
    expect(parsed.nodes[0]!.type).toBe("function");
    expect(parsed.nodes[1]!.type).toBe("agent");
    expect(parsed.nodes[2]!.with?.node?.type).toBe("function");
    expect(parsed.runtime.hooks[0]!.on).toBe("agent:beforeToolCall");
  });
});

describe("validateSpec node config", () => {
  it("errors on unregistered node type", () => {
    const diags = validateSpec({
      metadata: { name: "unknown-type" },
      nodes: [{ id: "x", type: "not-a-real-type", with: {} }],
      edges: [
        { from: "START", to: "x" },
        { from: "x", to: "END" },
      ],
    } as unknown as GraphSpec);
    expect(
      diags.some(
        (d) =>
          d.code === "UNKNOWN_NODE_TYPE" &&
          d.severity === "error" &&
          d.path === "nodes.x.type",
      ),
    ).toBe(true);
  });

  it("errors when hitl with is missing required message", () => {
    const diags = validateSpec({
      metadata: { name: "bad-hitl" },
      nodes: [{ id: "gate", type: "hitl", with: { mode: "approve" } }],
      edges: [
        { from: "START", to: "gate" },
        { from: "gate", to: "END" },
      ],
    } as unknown as GraphSpec);
    const cfg = diags.filter((d) => d.code === "NODE_CONFIG_ERROR");
    expect(cfg.length).toBeGreaterThan(0);
    expect(cfg.some((d) => d.path?.includes("nodes.gate.with") && d.message.includes("message"))).toBe(
      true,
    );
  });

  it("does not emit NODE_CONFIG_ERROR for a valid hitl node", () => {
    const diags = validateSpec({
      metadata: { name: "ok-hitl" },
      nodes: [{ id: "gate", type: "hitl", with: { mode: "approve", message: "OK?" } }],
      edges: [
        { from: "START", to: "gate" },
        { from: "gate", to: "END" },
      ],
    } as unknown as GraphSpec);
    expect(diags.some((d) => d.code === "NODE_CONFIG_ERROR")).toBe(false);
    expect(diags.some((d) => d.code === "UNKNOWN_NODE_TYPE")).toBe(false);
  });

  it("describes the expected output mapping shape when output is invalid", () => {
    const diags = validateSpec({
      metadata: { name: "bad-output" },
      nodes: [
        {
          id: "fetch",
          type: "http",
          with: { method: "GET", url: "https://example.com", output: "httpResult" },
        },
      ],
      edges: [
        { from: "START", to: "fetch" },
        { from: "fetch", to: "END" },
      ],
    } as unknown as GraphSpec);
    const cfg = diags.filter((d) => d.code === "NODE_CONFIG_ERROR");
    expect(cfg.length).toBeGreaterThan(0);
    expect(
      cfg.some(
        (d) =>
          d.path === "nodes.fetch.with.output" &&
          (/expected "none"/.test(d.message) || /expected \{ to:/.test(d.message)),
      ),
    ).toBe(true);
  });
});
