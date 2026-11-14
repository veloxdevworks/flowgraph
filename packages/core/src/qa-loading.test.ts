import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphSpecSchema, type GraphSpec } from "@flowgraph/spec";
import { loadGraph, validateSpec } from "./loader.js";
import { compileGraph } from "./compiler.js";
import { preflightGraphSkills } from "./preflight-graph.js";
import { registerFunction } from "./nodes/function.js";
import { createScriptedProvider } from "./providers/index.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "fg-qa-loading-"));
  dirs.push(dir);
  return dir;
}
function graph(nodes: unknown[], edges: unknown[], extra = {}): GraphSpec {
  return GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "qa-loading" },
    state: { channels: { message: { type: "string", reducer: "lastWrite" } } },
    nodes,
    edges,
    ...extra,
  });
}
const step = (id: string) => ({
  id,
  type: "function",
  with: { fn: "qaLoadingValue", output: { to: "message" } },
});
const errors = (spec: GraphSpec) => validateSpec(spec).filter((d) => d.severity === "error");

describe("PLAT-302 / PLAT-335: validate before execution", () => {
  it("rejects missing router targets", () => {
    const spec = graph(
      [
        {
          id: "route",
          type: "router",
          with: { routes: { bad: { default: true, to: "missing" } } },
        },
      ],
      [{ from: "START", to: "route" }],
    );
    expect(errors(spec)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("missing") }),
      ]),
    );
  });

  it("rejects truly unreachable nodes", () => {
    expect(
      errors(
        graph(
          [step("live"), step("orphan")],
          [
            { from: "START", to: "live" },
            { from: "live", to: "END" },
          ],
        ),
      ),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "UNREACHABLE_FROM_START" })]),
    );
  });

  it("allows a helper referenced only as an agent tool without dummy edges", async () => {
    registerFunction("qaLoadingValue", () => "helper-result");
    const provider = createScriptedProvider("qa-loading-provider", async (_req, ctx) => ({
      output: await ctx.invokeTool("helper", {}),
      stopReason: "done",
    }));
    const spec = graph(
      [
        step("helper"),
        {
          id: "ask",
          type: "agent",
          provider: provider.name,
          with: { prompt: "use helper", tools: [{ node: "helper" }], output: { to: "message" } },
        },
      ],
      [
        { from: "START", to: "ask" },
        { from: "ask", to: "END" },
      ],
    );
    expect(errors(spec)).toEqual([]);
    const result = await (await compileGraph(spec, { providers: [provider] })).run();
    expect(result.status).toBe("completed");
    expect(result.state.message).toBe("helper-result");
  });

  it("allows a declared hook recovery target without dummy inbound edges", async () => {
    registerFunction("qaLoadingFail", () => {
      throw new Error("expected failure");
    });
    registerFunction("qaLoadingValue", () => "recovered");
    const spec = graph(
      [{ id: "fail", type: "function", with: { fn: "qaLoadingFail" } }, step("recover")],
      [
        { from: "START", to: "fail" },
        { from: "fail", to: "END" },
        { from: "recover", to: "END" },
      ],
      {
        runtime: { hooks: [{ on: "node:error", where: { nodeId: "fail" }, do: "route:recover" }] },
      },
    );
    expect(errors(spec)).toEqual([]);
    const result = await (await compileGraph(spec)).run();
    expect(result.status).toBe("completed");
    expect(result.state.message).toBe("recovered");
  });

  it.each(["{{ length(state.message) }}", "{{ constructor() }}"])(
    "rejects unknown expression functions in %s",
    (value) => {
      const spec = graph(
        [{ id: "ask", type: "agent", with: { prompt: value } }],
        [
          { from: "START", to: "ask" },
          { from: "ask", to: "END" },
        ],
      );
      expect(errors(spec)).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "EXPR_UNKNOWN_FUNCTION" })]),
      );
    },
  );

  it("rejects excessive expression nesting with an attributed diagnostic", () => {
    const spec = graph(
      [
        {
          id: "ask",
          type: "agent",
          with: { prompt: `{{ ${"(".repeat(2000)}1${")".repeat(2000)} }}` },
        },
      ],
      [
        { from: "START", to: "ask" },
        { from: "ask", to: "END" },
      ],
    );
    expect(errors(spec)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "EXPR_DEPTH", path: expect.stringContaining("ask") }),
      ]),
    );
  });

  it("bounds repeated diagnostics without spreading an unbounded error array", () => {
    const spec = graph(
      [
        {
          id: "ask",
          type: "agent",
          with: { prompt: "{{ length(state.message) }}".repeat(50_000) },
        },
      ],
      [
        { from: "START", to: "ask" },
        { from: "ask", to: "END" },
      ],
    );
    const found = errors(spec).filter((d) => d.code === "EXPR_UNKNOWN_FUNCTION");
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThanOrEqual(50);
  });

  it("checks channel default types and retains collision detection", () => {
    const spec = graph(
      [step("live")],
      [
        { from: "START", to: "live" },
        { from: "live", to: "END" },
      ],
      {
        state: {
          channels: { message: { type: "number", default: "bad" }, live: { type: "string" } },
        },
      },
    );
    expect(errors(spec)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "CHANNEL_DEFAULT_TYPE" }),
        expect.objectContaining({ code: "NODE_CHANNEL_NAME_COLLISION" }),
      ]),
    );
  });
});

describe("PLAT-304 / PLAT-305 / PLAT-335: source-relative imports", () => {
  it("loads a child's module imports from the child file rather than the parent workspace", async () => {
    const dir = await directory();
    await mkdir(join(dir, "child"));
    const module = (value: string) =>
      `export default [{ type: 'qa-source-node', configSchema: { safeParse: (data) => ({success:true,data}) }, build() { return { async run() { return {update: {message: ${JSON.stringify(value)}}}; } }; } }];`;
    await writeFile(join(dir, "child/register.mjs"), module("child-module"));
    await writeFile(join(dir, "register.mjs"), module("wrong-parent-module"));
    await writeFile(
      join(dir, "child/flow.yaml"),
      JSON.stringify(
        graph(
          [{ id: "value", type: "qa-source-node" }],
          [
            { from: "START", to: "value" },
            { from: "value", to: "END" },
          ],
          { imports: [{ nodes: "./register.mjs" }] },
        ),
      ),
    );
    const parentFile = join(dir, "parent.yaml");
    await writeFile(
      parentFile,
      JSON.stringify(
        graph(
          [
            {
              id: "child",
              type: "subgraph",
              uses: "./child/flow.yaml",
              with: { stateMap: { out: { message: "message" } } },
            },
          ],
          [
            { from: "START", to: "child" },
            { from: "child", to: "END" },
          ],
        ),
      ),
    );
    const loaded = await loadGraph(parentFile);
    const result = await (await compileGraph(loaded.spec!, { graphPath: parentFile })).run();
    expect(result.status).toBe("completed");
    expect(result.state.message).toBe("child-module");
  });

  it("allows a shared child in separate DAG branches", async () => {
    const dir = await directory();
    await writeFile(
      join(dir, "leaf.yaml"),
      JSON.stringify(graph([], [{ from: "START", to: "END" }])),
    );
    const children = ["left", "right"].map((id) => ({ id, type: "subgraph", uses: "./leaf.yaml" }));
    const parent = graph(children, [
      { from: "START", to: ["left", "right"] },
      { from: "left", to: "END" },
      { from: "right", to: "END" },
    ]);
    await writeFile(join(dir, "parent.yaml"), JSON.stringify(parent));
    const loaded = await loadGraph(join(dir, "parent.yaml"));
    expect(loaded.spec).not.toBeNull();
    expect(loaded.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
  it("loads nested aliases independently of cwd and runtime.workspace", async () => {
    registerFunction("qaLoadingValue", () => "leaf-result");
    const dir = await directory();
    await mkdir(join(dir, "graphs/nested/deep"), { recursive: true });
    await mkdir(join(dir, "elsewhere"));
    const child = (alias: string, file: string, extra = {}) =>
      graph(
        [
          {
            id: "child",
            type: "subgraph",
            uses: alias,
            with: { stateMap: { out: { message: "message" } } },
          },
        ],
        [
          { from: "START", to: "child" },
          { from: "child", to: "END" },
        ],
        { imports: [{ subgraph: file, as: alias }], ...extra },
      );
    await writeFile(
      join(dir, "graphs/nested/deep/leaf.yaml"),
      JSON.stringify(
        graph(
          [step("value")],
          [
            { from: "START", to: "value" },
            { from: "value", to: "END" },
          ],
        ),
      ),
    );
    await writeFile(
      join(dir, "graphs/nested/middle.yaml"),
      JSON.stringify(child("leaf", "./deep/leaf.yaml")),
    );
    const rootFile = join(dir, "graphs/root.yaml");
    await writeFile(
      rootFile,
      JSON.stringify(
        child("middle", "./nested/middle.yaml", { runtime: { workspace: "../elsewhere" } }),
      ),
    );
    const loaded = await loadGraph(rootFile);
    expect(loaded.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect((await preflightGraphSkills(loaded.spec!, { cwd: join(dir, "graphs") })).ok).toBe(true);
    const result = await (
      await compileGraph(loaded.spec!, { graphPath: rootFile, cwd: join(dir, "elsewhere") })
    ).run();
    expect(result.status).toBe("completed");
    expect(result.state.message).toBe("leaf-result");
  });

  it.each(["subgraph", "skill", "nodes"])("reports an unused missing %s import", async (kind) => {
    const dir = await directory();
    const file = join(dir, "root.yaml");
    const spec = graph([], [{ from: "START", to: "END" }], {
      imports: [{ [kind]: "./missing.yaml", ...(kind === "nodes" ? {} : { as: "unused" }) }],
    });
    await writeFile(file, JSON.stringify(spec));
    const loaded = await loadGraph(file);
    expect(loaded.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "error", code: "IMPORT_NOT_FOUND" }),
      ]),
    );
  });
});
