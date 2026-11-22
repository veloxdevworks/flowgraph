import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import type { GraphSpec, NodeSpec } from "@flowgraph/spec";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import yaml from "yaml";
import { compileGraph } from "./compiler.js";
import type { Hook } from "./hooks/types.js";
import type { McpHub } from "./mcp/types.js";
import { registerFunction } from "./nodes/function.js";
import { createScriptedProvider } from "./providers/mock.js";

let fixtureDir = "";

beforeAll(async () => {
  fixtureDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "flowgraph-subgraph-host-")),
  );
});

afterAll(async () => {
  await fs.rm(fixtureDir, { recursive: true, force: true });
});

function chain(name: string, nodes: NodeSpec[], extra: Partial<GraphSpec> = {}): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name },
    nodes,
    edges: [
      { from: "START", to: nodes[0]!.id },
      ...nodes.map((node, index) => ({ from: node.id, to: nodes[index + 1]?.id ?? "END" })),
    ],
    ...extra,
  } as GraphSpec;
}

function embed(child: GraphSpec, id = "embed"): NodeSpec {
  return {
    id,
    type: "subgraph",
    spec: child,
    with: {
      stateMap: { out: { toolResult: "toolResult", resourceResult: "resourceResult" } },
    },
  } as NodeSpec;
}

function fakeHub(label = "hub") {
  return {
    listTools: vi.fn(async () => [{ name: "lookup", schema: { type: "object" } }]),
    callTool: vi.fn(async (server: string, tool: string, args: unknown) => ({
      label,
      server,
      tool,
      args,
    })),
    readResource: vi.fn(async (server: string, uri: string) => ({ label, server, uri })),
    close: vi.fn(async () => undefined),
  } satisfies McpHub;
}

function mcpChild(): GraphSpec {
  return chain("mcp-child", [
    {
      id: "lookup",
      type: "mcp",
      with: {
        server: "tracker",
        tool: "lookup",
        arguments: { project: "{{ config.vars.project }}" },
        output: { to: "toolResult" },
      },
    },
    {
      id: "resource",
      type: "mcp",
      with: {
        server: "tracker",
        resource: "tracker://{{ config.vars.project }}",
        output: { to: "resourceResult" },
      },
    },
  ]);
}

describe("embedded host capabilities", () => {
  it("uses the same approved hub for root, file, and deeply nested tool/resource calls", async () => {
    const child = mcpChild();
    const childPath = path.join(fixtureDir, "mcp-child.graph.yaml");
    await fs.writeFile(childPath, yaml.stringify(child));
    const hub = fakeHub();
    const options = { mcp: hub, runConfig: { vars: { project: "DEMO" } } };
    const graphs = [
      child,
      chain("file-parent", [
        {
          id: "file",
          type: "subgraph",
          uses: childPath,
          with: {
            stateMap: { out: { toolResult: "toolResult", resourceResult: "resourceResult" } },
          },
        },
      ]),
      chain("deep-parent", [embed(chain("middle", [embed(child, "inner")]))]),
    ];
    for (const spec of graphs) {
      const result = await (await compileGraph(spec, options)).run();
      expect(result.status, result.error?.message).toBe("completed");
      expect(result.state.toolResult).toEqual({
        label: "hub",
        server: "tracker",
        tool: "lookup",
        args: { project: "DEMO" },
      });
      expect(result.state.resourceResult).toEqual({
        label: "hub",
        server: "tracker",
        uri: "tracker://DEMO",
      });
    }
    expect(hub.callTool).toHaveBeenCalledTimes(3);
    expect(hub.readResource).toHaveBeenCalledTimes(3);
    // A child borrows the connection; it does not own its teardown.
    expect(hub.close).not.toHaveBeenCalled();
  });

  it("does not restore an MCP capability withheld by the host policy", async () => {
    const hub = fakeHub();
    const compiled = await compileGraph(
      chain("blocked-root", [embed(chain("blocked-middle", [embed(mcpChild())]))]),
      {
        mcp: hub,
        nodePolicy: { blockMcp: true },
      },
    );
    const result = await compiled.run();
    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("MCP is not configured");
    expect(hub.callTool).not.toHaveBeenCalled();
    expect(hub.readResource).not.toHaveBeenCalled();
  });

  it("retains the host's function restrictions at every embedded boundary", async () => {
    const called = vi.fn(() => "forbidden");
    registerFunction("subgraphHostForbidden", called);
    const child = chain("restricted-child", [
      { id: "forbidden", type: "function", with: { fn: "subgraphHostForbidden" } },
    ]);
    const childPath = path.join(fixtureDir, "restricted.graph.yaml");
    await fs.writeFile(childPath, yaml.stringify(child));
    const compiled = await compileGraph(
      chain("restricted-root", [{ id: "embed", type: "subgraph", uses: childPath }]),
      {
        nodePolicy: { allowedFunctions: [] },
      },
    );
    const result = await compiled.run();
    expect(result.status).toBe("error");
    expect(result.error).toMatchObject({ code: "FUNCTION_BLOCKED" });
    expect(called).not.toHaveBeenCalled();
  });

  it("enforces host agent-tool hooks in a nested MCP agent without broadening its tool list", async () => {
    const hub = fakeHub();
    const guarded = createScriptedProvider("subgraph-host-guarded", async (request, ctx) => {
      expect(request.tools.map((tool) => tool.name)).toEqual(["tracker:lookup"]);
      await ctx.invokeTool("tracker:lookup", { project: "DEMO" });
      return { output: "unexpected", stopReason: "done" };
    });
    const hook = vi.fn<Hook["handler"]>(() => ({
      kind: "veto",
      reason: "host denied this mutation",
    }));
    const child = chain("guarded-child", [
      {
        id: "agent",
        type: "agent",
        provider: guarded.name,
        with: {
          prompt: "Look up the issue",
          tools: [{ mcp: "tracker", tools: ["lookup"] }],
        },
      },
    ]);
    const compiled = await compileGraph(
      chain("guarded-root", [embed(chain("guarded-middle", [embed(child)]))]),
      {
        mcp: hub,
        providers: [guarded],
        hooks: [{ phase: "agent:beforeToolCall", where: { tool: "tracker:lookup" }, handler: hook }],
      },
    );
    const result = await compiled.run();
    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("host denied this mutation");
    expect(hook).toHaveBeenCalledOnce();
    expect(hub.callTool).not.toHaveBeenCalled();
  });

  it("inherits only host vars/defaults while retaining child config, paths and lifecycle", async () => {
    registerFunction("subgraphHostInspect", (_input, ctx) => ({
      vars: ctx.config.vars,
      defaults: ctx.config.defaults,
      graphDir: ctx.config.graphDir,
      skills: ctx.config.skills,
      agents: ctx.config.agents,
      subgraphs: ctx.config.subgraphs,
      channels: Object.keys(ctx.config.channels ?? {}).sort(),
      runId: ctx.meta.runId,
      threadId: ctx.meta.threadId,
      graph: ctx.meta.graph,
      hasRunBefore: ctx.hooks?.has("run:before"),
    }));
    const childDir = path.join(fixtureDir, "child-directory");
    await fs.mkdir(childDir, { recursive: true });
    const child = chain(
      "config-child",
      [
        {
          id: "inspect",
          type: "function",
          with: {
            fn: "subgraphHostInspect",
            output: { to: "result" },
          },
        },
      ],
      {
        config: {
          vars: { shared: "child", childOnly: true },
          defaults: { provider: "child-provider" },
        },
      },
    );
    const childPath = path.join(childDir, "config.graph.yaml");
    await fs.writeFile(childPath, yaml.stringify(child));
    const lifecycle = vi.fn<Hook["handler"]>();
    const nodeHook = vi.fn<Hook["handler"]>();
    const parent = chain("config-parent", [{ id: "embed", type: "subgraph", uses: childPath }], {
      config: {
        vars: { rootOnly: true, shared: "root" },
        defaults: { provider: "root-provider" },
      },
      state: { channels: { rootOnlyChannel: { type: "string" }, result: { type: "object" } } },
      // Graph-bound hooks stay at the declaring graph; this must not veto the child.
      runtime: { hooks: [{ on: "node:before", where: { nodeId: "inspect" }, do: "deny" }] },
    });
    const compiled = await compileGraph(parent, {
      runConfig: {
        vars: { shared: "host", hostOnly: true },
        defaults: { model: "host-model" },
        skills: { rootSkill: "./root-skill" },
        agents: { rootAgent: "./root-agent" },
        subgraphs: { rootGraph: "./root-graph" },
      },
      hooks: [
        { phase: "run:before", handler: lifecycle },
        { phase: "node:before", where: { nodeId: "inspect" }, handler: nodeHook },
      ],
    });
    const result = await compiled.run({ threadId: "host-config-thread" });
    expect(result.status, result.error?.message).toBe("completed");
    expect(result.state.result).toEqual({
      vars: { shared: "host", childOnly: true, hostOnly: true },
      defaults: { provider: "child-provider", model: "host-model" },
      graphDir: childDir,
      skills: {},
      agents: {},
      subgraphs: {},
      channels: ["outputs", "result"],
      runId: result.runId,
      threadId: "host-config-thread",
      graph: "config-parent",
      hasRunBefore: false,
    });
    expect(lifecycle).toHaveBeenCalledOnce();
    expect(nodeHook).toHaveBeenCalledOnce();
    expect(nodeHook.mock.calls[0]?.[0].run.runId).toBe(result.runId);
  });

  it("keeps separate compiled parents' hubs/config isolated under concurrent execution", async () => {
    const spec = chain("isolated-parent", [embed(mcpChild())]);
    const hubs = [fakeHub("one"), fakeHub("two")];
    const results = await Promise.all(
      hubs.map(async (mcp, index) => {
        const compiled = await compileGraph(spec, {
          mcp,
          runConfig: { vars: { project: `P${index}` } },
        });
        return compiled.run({ threadId: `isolated-${index}` });
      }),
    );
    for (const [index, result] of results.entries()) {
      expect(result.status, result.error?.message).toBe("completed");
      expect(hubs[index]?.callTool).toHaveBeenCalledExactlyOnceWith("tracker", "lookup", {
        project: `P${index}`,
      });
      expect(hubs[index]?.readResource).toHaveBeenCalledExactlyOnceWith("tracker", `tracker://P${index}`);
    }
  });

  it("owns nested host variables separately from the caller, root and sibling children", async () => {
    registerFunction("subgraphHostMutateVariables", (input, ctx) => {
      const nested = ctx.config.vars!.nested as {
        project: string;
        items: Array<{ label: string }>;
      };
      const before = structuredClone(nested);
      nested.project = (input as { project: string }).project;
      nested.items[0]!.label = "child mutation";
      return before;
    });
    registerFunction("subgraphHostReadVariables", (_input, ctx) =>
      structuredClone(ctx.config.vars!.nested),
    );
    const child = (project: string) =>
      chain("mutable-vars-child", [
        {
          id: "mutate",
          type: "function",
          with: {
            fn: "subgraphHostMutateVariables",
            output: { to: "result" },
          }, input: { project },
        },
      ]);
    const parent = chain("mutable-vars-parent", [
      {
        id: "first-child",
        type: "subgraph",
        spec: child("first"),
        with: { stateMap: { out: { first: "result" } } },
      },
      {
        id: "second-child",
        type: "subgraph",
        spec: child("second"),
        with: { stateMap: { out: { second: "result" } } },
      },
      {
        id: "read-root",
        type: "function",
        with: { fn: "subgraphHostReadVariables", output: { to: "root" } },
      },
    ]);
    const original = { project: "DEMO", items: [{ label: "original" }] };
    const options = { runConfig: { vars: { nested: structuredClone(original) } } };
    const result = await (await compileGraph(parent, options)).run();
    expect(result.status, result.error?.message).toBe("completed");
    expect(result.state.first).toEqual(original);
    expect(result.state.second).toEqual(original);
    expect(result.state.root).toEqual(original);
    expect(options.runConfig.vars.nested).toEqual(original);
  });

  it("preserves root-only functions and opaque host values without imposing a new serialization contract", async () => {
    class HostHandle {
      value = "host-owned";
    }
    const handle = new HostHandle();
    const callback = () => "callback-result";
    registerFunction("subgraphHostOpaqueCompatibility", (_input, ctx) => {
      expect(ctx.config.vars!.handle).toBe(handle);
      expect(ctx.config.vars!.callback).toBe(callback);
      return (ctx.config.vars!.callback as () => string)();
    });
    const spec = chain("root-only-opaque-vars", [
      {
        id: "inspect",
        type: "function",
        with: {
          fn: "subgraphHostOpaqueCompatibility",
          output: { to: "result" },
        },
      },
    ]);
    const result = await (
      await compileGraph(spec, { runConfig: { vars: { handle, callback } } })
    ).run();
    expect(result.status, result.error?.message).toBe("completed");
    expect(result.state.result).toBe("callback-result");
  });

  it("keeps parallel map children's arguments and host hooks separate", async () => {
    const hub = fakeHub();
    const child = chain(
      "map-child",
      [
        {
          id: "lookup",
          type: "mcp",
          with: {
            server: "tracker",
            tool: "lookup",
            arguments: { project: "{{ config.vars.project }}", item: "{{ state.itemId }}" },
            output: { to: "toolResult" },
          },
        },
      ],
      { state: { channels: { itemId: { type: "number" }, toolResult: { type: "object" } } } },
    );
    const seen: unknown[] = [];
    const spec = chain(
      "map-parent",
      [
        {
          id: "packages",
          type: "map",
          with: {
            over: "{{ state.items }}",
            as: "package",
            concurrency: 2,
            node: {
              type: "subgraph",
              spec: child,
              input: { itemId: "{{ package }}" },
              with: { stateMap: { out: { toolResult: "toolResult" } } },
            },
            collect: { to: "results" },
          },
        },
      ],
      { state: { channels: { items: { type: "array" } } } },
    );
    const compiled = await compileGraph(spec, {
      mcp: hub,
      runConfig: { vars: { project: "DEMO" } },
      hooks: [
        {
          phase: "node:before",
          where: { nodeId: "lookup" },
          handler: ({ state }) => {
            seen.push(state.itemId);
          },
        },
      ],
    });
    const result = await compiled.run({ input: { items: [1, 2] } });
    expect(result.status, result.error?.message).toBe("completed");
    expect(result.state.results).toEqual(
      [1, 2].map((item) => ({
        label: "hub",
        server: "tracker",
        tool: "lookup",
        args: { project: "DEMO", item },
      })),
    );
    expect(seen.sort()).toEqual([1, 2]);
    expect(hub.callTool).toHaveBeenCalledTimes(2);
  });

  it("reacquires host capabilities after recompilation and resumes without repeating completed child calls", async () => {
    const saver = new MemorySaver();
    const before = fakeHub("before");
    const after = fakeHub("after");
    const resumedHook = vi.fn<Hook["handler"]>();
    const child = chain("resume-child", [
      {
        id: "lookup",
        type: "mcp",
        with: { server: "tracker", tool: "lookup", output: { to: "toolResult" } },
      },
      { id: "approval", type: "hitl", with: { mode: "approve", message: "Continue?" } },
      {
        id: "resource",
        type: "mcp",
        with: {
          server: "tracker",
          resource: "tracker://{{ config.vars.project }}",
          output: { to: "resourceResult" },
        },
      },
    ]);
    const spec = chain("resume-parent", [embed(child)]);
    const first = await (
      await compileGraph(spec, { checkpointer: saver, mcp: before })
    ).run({ threadId: "host-resume" });
    expect(first.status).toBe("interrupted");
    const resumed = await (
      await compileGraph(spec, {
        checkpointer: saver,
        mcp: after,
        runConfig: { vars: { project: "DEMO" } },
        hooks: [{ phase: "node:before", where: { nodeId: "resource" }, handler: resumedHook }],
      })
    ).resume({ threadId: "host-resume", resume: true });
    expect(resumed.status, resumed.error?.message).toBe("completed");
    expect(before.callTool).toHaveBeenCalledOnce();
    expect(after.callTool).not.toHaveBeenCalled();
    expect(after.readResource).toHaveBeenCalledExactlyOnceWith("tracker", "tracker://DEMO");
    expect(resumedHook).toHaveBeenCalledOnce();
    expect(resumedHook.mock.calls[0]?.[0].run.threadId).toBe("host-resume");
    expect(resumed.state.resourceResult).toEqual({
      label: "after",
      server: "tracker",
      uri: "tracker://DEMO",
    });
  });
});
