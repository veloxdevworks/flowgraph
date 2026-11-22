import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "../compiler.js";
import { registry } from "../registry.js";
import { validateSpec } from "../loader.js";
import {
  defineProvider,
  defineProviderPlugin,
  getProvider,
  isProviderPlugin,
  registerProviderPlugin,
  unregisterProviderPlugin,
} from "../providers/index.js";

let fixtureDir = "";

beforeAll(async () => {
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "flowgraph-plugins-"));

  // Valid namespaced plugin A
  await fs.writeFile(
    path.join(fixtureDir, "plugin-a.mjs"),
    `export default [{
  type: "acme/echo",
  configSchema: { safeParse: (d) => ({ success: true, data: d }) },
  build() {
    return {
      async run() { return { update: { out: "from-a" } }; }
    };
  },
}];
`,
  );

  // Valid namespaced plugin B registering the SAME type name (for isolation + collision tests)
  await fs.writeFile(
    path.join(fixtureDir, "plugin-b.mjs"),
    `export default [{
  type: "acme/echo",
  configSchema: { safeParse: (d) => ({ success: true, data: d }) },
  build() {
    return {
      async run() { return { update: { out: "from-b" } }; }
    };
  },
}];
`,
  );

  // Unnamespaced plugin (must fail with PLUGIN_TYPE_INVALID)
  await fs.writeFile(
    path.join(fixtureDir, "plugin-unnamespaced.mjs"),
    `export default [{
  type: "plain-type",
  configSchema: { safeParse: (d) => ({ success: true, data: d }) },
  build() { return { async run() { return {}; } }; },
}];
`,
  );

  // Plugin colliding with built-in node type (must fail with PLUGIN_TYPE_COLLISION)
  await fs.writeFile(
    path.join(fixtureDir, "plugin-builtin-collide.mjs"),
    `export default [{
  type: "shell",
  configSchema: { safeParse: (d) => ({ success: true, data: d }) },
  build() { return { async run() { return {}; } }; },
}];
`,
  );

  // Two reducer plugins with colliding reducer name
  await fs.writeFile(
    path.join(fixtureDir, "reducer-1.mjs"),
    `export default { mergeTags: (a, b) => [...(a ?? []), ...(b ?? [])] };\n`,
  );
  await fs.writeFile(
    path.join(fixtureDir, "reducer-2.mjs"),
    `export default { mergeTags: (a, b) => b ?? a };\n`,
  );

  // Terminal plugin node (no outgoing edge to END required)
  await fs.writeFile(
    path.join(fixtureDir, "plugin-terminal.mjs"),
    `export default [{
  type: "acme/stop",
  configSchema: { safeParse: (d) => ({ success: true, data: d }) },
  capabilities: { terminal: true },
  build() {
    return {
      async run() { return { update: { out: "stopped-cleanly" } }; }
    };
  },
}];
`,
  );

  // Map worker plugin that completes for normal items and interrupts for "pause"
  await fs.writeFile(
    path.join(fixtureDir, "plugin-map-worker.mjs"),
    `export default [{
  type: "acme/map-item",
  configSchema: { safeParse: (d) => ({ success: true, data: d }) },
  capabilities: { interruptible: true },
  build() {
    return {
      async run(_state, ctx) {
        const value = ctx._input?.value;
        if (value === "pause") {
          const answer = ctx.interrupt({ reason: "need-item", payload: { value } });
          return { update: { result: answer } };
        }
        return { update: { result: "done:" + String(value) } };
      }
    };
  },
}];
`,
  );

  // File subgraph importing a colliding reducer
  await fs.writeFile(
    path.join(fixtureDir, "child-other-reducer.graph.yaml"),
    `apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: child-other-reducer
imports:
  - reducers: ./reducer-2.mjs
state:
  channels:
    tags:
      type: array
      reducer: "custom:mergeTags"
nodes: []
edges:
  - { from: START, to: END }
`,
  );

  // Provider plugin module A
  await fs.writeFile(
    path.join(fixtureDir, "provider-plugin.mjs"),
    `export default {
  name: "acme/custom-llm",
  optionsSchema: {
    safeParse(raw) {
      if (!raw || typeof raw !== "object" || typeof raw.tag !== "string" || !raw.tag) {
        return { success: false, error: { issues: [{ path: ["tag"], message: "tag must be a non-empty string" }] } };
      }
      return { success: true, data: { tag: raw.tag } };
    },
  },
  create(options, ctx) {
    return {
      name: ctx.name,
      capabilities: { streaming: false, toolCalling: false, structuredOutput: false },
      async run(req) {
        return { output: options.tag + ":" + req.prompt, stopReason: "done" };
      },
    };
  },
};
`,
  );

  // Distinct provider plugin module claiming the same plugin name
  await fs.writeFile(
    path.join(fixtureDir, "provider-plugin-other.mjs"),
    `export default {
  name: "acme/custom-llm",
  create(_options, ctx) {
    return {
      name: ctx.name,
      capabilities: { streaming: false, toolCalling: false, structuredOutput: false },
      async run(req) {
        return { output: "other:" + req.prompt, stopReason: "done" };
      },
    };
  },
};
`,
  );

  // File subgraphs for parent+child shared/colliding plugin tests
  await fs.writeFile(
    path.join(fixtureDir, "child-same-node.graph.yaml"),
    `apiVersion: flowgraph/v1
kind: Graph
metadata: { name: child-same-node }
imports:
  - nodes: ./plugin-a.mjs
state:
  channels:
    out: { type: string }
nodes:
  - { id: child-echo, type: acme/echo }
edges:
  - { from: START, to: child-echo }
  - { from: child-echo, to: END }
runtime:
  checkpoint: { enabled: false }
`,
  );

  await fs.writeFile(
    path.join(fixtureDir, "child-other-node.graph.yaml"),
    `apiVersion: flowgraph/v1
kind: Graph
metadata: { name: child-other-node }
imports:
  - nodes: ./plugin-b.mjs
state:
  channels:
    out: { type: string }
nodes:
  - { id: child-echo, type: acme/echo }
edges:
  - { from: START, to: child-echo }
  - { from: child-echo, to: END }
runtime:
  checkpoint: { enabled: false }
`,
  );

  await fs.writeFile(
    path.join(fixtureDir, "child-same-provider.graph.yaml"),
    `apiVersion: flowgraph/v1
kind: Graph
metadata: { name: child-same-provider }
imports:
  - providers: ./provider-plugin.mjs
providers:
  custom:
    kind: plugin
    plugin: acme/custom-llm
    options: { tag: child }
state:
  channels:
    out: { type: string }
nodes:
  - id: a
    type: agent
    provider: custom
    with:
      prompt: hello
      output: { to: out }
edges:
  - { from: START, to: a }
  - { from: a, to: END }
runtime:
  checkpoint: { enabled: false }
`,
  );

  await fs.writeFile(
    path.join(fixtureDir, "child-other-provider.graph.yaml"),
    `apiVersion: flowgraph/v1
kind: Graph
metadata: { name: child-other-provider }
imports:
  - providers: ./provider-plugin-other.mjs
providers:
  custom:
    kind: plugin
    plugin: acme/custom-llm
    options: { tag: child }
state:
  channels:
    out: { type: string }
nodes:
  - id: a
    type: agent
    provider: custom
    with:
      prompt: hello
      output: { to: out }
edges:
  - { from: START, to: a }
  - { from: a, to: END }
runtime:
  checkpoint: { enabled: false }
`,
  );
});

afterAll(async () => {
  if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
});

function baseSpec(overrides: Record<string, unknown>): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "plugin-isolation-test" },
    state: { channels: { out: { type: "string" } } },
    nodes: [{ id: "n", type: "acme/echo" }],
    edges: [
      { from: "START", to: "n" },
      { from: "n", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
    ...overrides,
  } as unknown as GraphSpec;
}

describe("namespaced plugins, collision errors, per-compile registry and plugin providers", () => {
  it("isolates imported plugin node types per compile without mutating the global registry", async () => {
    const specA = baseSpec({ imports: [{ nodes: "./plugin-a.mjs" }] });
    const specB = baseSpec({ imports: [{ nodes: "./plugin-b.mjs" }] });

    const [compiledA, compiledB] = await Promise.all([
      compileGraph(specA, { cwd: fixtureDir }),
      compileGraph(specB, { cwd: fixtureDir }),
    ]);

    expect(registry.get("acme/echo")).toBeUndefined();
    const resA = await compiledA.run();
    const resB = await compiledB.run();
    expect(resA.status).toBe("completed");
    expect(resB.status).toBe("completed");
    expect(resA.state["out"]).toBe("from-a");
    expect(resB.state["out"]).toBe("from-b");
  });

  it("allows parent and file subgraph to import the same node plugin, but fails on different factories", async () => {
    const sameSpec = baseSpec({
      imports: [{ nodes: "./plugin-a.mjs" }],
      nodes: [
        { id: "parent-echo", type: "acme/echo" },
        {
          id: "sub",
          type: "subgraph",
          uses: "./child-same-node.graph.yaml",
          with: { stateMap: { out: { out: "out" } } },
        },
      ],
      edges: [
        { from: "START", to: "parent-echo" },
        { from: "parent-echo", to: "sub" },
        { from: "sub", to: "END" },
      ],
    });
    const sameRes = await (await compileGraph(sameSpec, { cwd: fixtureDir })).run();
    expect(sameRes.status).toBe("completed");
    expect(sameRes.state["out"]).toBe("from-a");

    const collidingSpec = baseSpec({
      imports: [{ nodes: "./plugin-a.mjs" }],
      nodes: [
        {
          id: "sub",
          type: "subgraph",
          uses: "./child-other-node.graph.yaml",
          with: { stateMap: { out: { out: "out" } } },
        },
      ],
      edges: [
        { from: "START", to: "sub" },
        { from: "sub", to: "END" },
      ],
    });
    const collidingRes = await (await compileGraph(collidingSpec, { cwd: fixtureDir })).run();
    expect(collidingRes.status).toBe("error");
    expect((collidingRes.error as Error & { code?: string })?.code).toBe("PLUGIN_TYPE_COLLISION");
    expect(collidingRes.error?.message).toContain("./plugin-a.mjs");
    expect(collidingRes.error?.message).not.toContain("built-in or host");
  });

  it("allows parent and file subgraph to import the same provider plugin, but fails on different plugins", async () => {
    const sameSpec = baseSpec({
      imports: [{ providers: "./provider-plugin.mjs" }],
      providers: {
        custom: {
          kind: "plugin",
          plugin: "acme/custom-llm",
          options: { tag: "parent" },
        },
      },
      nodes: [
        {
          id: "sub",
          type: "subgraph",
          uses: "./child-same-provider.graph.yaml",
          with: { stateMap: { out: { out: "out" } } },
        },
      ],
      edges: [
        { from: "START", to: "sub" },
        { from: "sub", to: "END" },
      ],
    });
    const sameRes = await (await compileGraph(sameSpec, { cwd: fixtureDir })).run();
    expect(sameRes.status).toBe("completed");
    expect(sameRes.state["out"]).toBe("child:hello");

    const collidingSpec = baseSpec({
      imports: [{ providers: "./provider-plugin.mjs" }],
      providers: {
        custom: {
          kind: "plugin",
          plugin: "acme/custom-llm",
          options: { tag: "parent" },
        },
      },
      nodes: [
        {
          id: "sub",
          type: "subgraph",
          uses: "./child-other-provider.graph.yaml",
          with: { stateMap: { out: { out: "out" } } },
        },
      ],
      edges: [
        { from: "START", to: "sub" },
        { from: "sub", to: "END" },
      ],
    });
    const collidingRes = await (await compileGraph(collidingSpec, { cwd: fixtureDir })).run();
    expect(collidingRes.status).toBe("error");
    expect((collidingRes.error as Error & { code?: string })?.code).toBe("PLUGIN_PROVIDER_COLLISION");
    expect(collidingRes.error?.message).toContain("./provider-plugin.mjs");
    expect(collidingRes.error?.message).not.toContain("built-in or host");

    // Host-provided provider plugin colliding with an imported plugin says "built-in or host"
    const hostPlugin = defineProviderPlugin({
      name: "acme/custom-llm",
      create: (_opts, ctx) => ({
        name: ctx.name,
        capabilities: { streaming: false, toolCalling: false, structuredOutput: false },
        run: async () => ({ output: "host", stopReason: "done" as const }),
      }),
    });
    const hostCollideSpec = baseSpec({
      imports: [{ providers: "./provider-plugin.mjs" }],
      providers: {
        custom: { kind: "plugin", plugin: "acme/custom-llm", options: { tag: "x" } },
      },
      nodes: [{ id: "a", type: "agent", provider: "custom", with: { prompt: "hi" } }],
      edges: [
        { from: "START", to: "a" },
        { from: "a", to: "END" },
      ],
    });
    await expect(
      compileGraph(hostCollideSpec, { cwd: fixtureDir, providerPlugins: [hostPlugin] }),
    ).rejects.toMatchObject({
      code: "PLUGIN_PROVIDER_COLLISION",
      message: expect.stringContaining("built-in or host"),
    });
  });

  it("rejects unnamespaced plugin node types with PLUGIN_TYPE_INVALID", async () => {
    const spec = baseSpec({
      imports: [{ nodes: "./plugin-unnamespaced.mjs" }],
      nodes: [{ id: "n", type: "plain-type" }],
    });
    await expect(compileGraph(spec, { cwd: fixtureDir })).rejects.toMatchObject({
      code: "PLUGIN_TYPE_INVALID",
    });
  });

  it("rejects a plugin colliding with another plugin with PLUGIN_TYPE_COLLISION", async () => {
    const spec = baseSpec({
      imports: [{ nodes: "./plugin-a.mjs" }, { nodes: "./plugin-b.mjs" }],
    });
    await expect(compileGraph(spec, { cwd: fixtureDir })).rejects.toMatchObject({
      code: "PLUGIN_TYPE_COLLISION",
    });
  });

  it("rejects a plugin colliding with a built-in node type with PLUGIN_TYPE_COLLISION", async () => {
    const spec = baseSpec({
      imports: [{ nodes: "./plugin-builtin-collide.mjs" }],
      nodes: [{ id: "n", type: "shell", with: { command: "echo" } }],
    });
    await expect(compileGraph(spec, { cwd: fixtureDir })).rejects.toMatchObject({
      code: "PLUGIN_TYPE_COLLISION",
      message: expect.stringContaining("built-in or host"),
    });
  });

  it("recognizes a plugin node's terminal capability during compile-time topology validation", async () => {
    const spec = baseSpec({
      imports: [{ nodes: "./plugin-terminal.mjs" }],
      nodes: [{ id: "stop", type: "acme/stop" }],
      edges: [{ from: "START", to: "stop" }],
    });
    const compiled = await compileGraph(spec, { cwd: fixtureDir });
    const res = await compiled.run();
    expect(res.status).toBe("completed");
    expect(res.state["out"]).toBe("stopped-cleanly");
  });

  it("collects map results into an imported custom reducer for both run results and getState", async () => {
    const spec = baseSpec({
      imports: [{ nodes: "./plugin-map-worker.mjs" }, { reducers: "./reducer-1.mjs" }],
      runtime: { checkpoint: { enabled: true, backend: "memory" } },
      state: {
        channels: {
          items: { type: "array", default: ["ok", "pause"] },
          tags: { type: "array", reducer: "custom:mergeTags", default: ["seed"] },
        },
      },
      nodes: [
        {
          id: "fan",
          type: "map",
          with: {
            over: "{{ state.items }}",
            as: "entry",
            node: {
              type: "acme/map-item",
              input: { value: "{{ entry }}" },
            },
            collect: { to: "tags" },
          },
        },
      ],
      edges: [
        { from: "START", to: "fan" },
        { from: "fan", to: "END" },
      ],
    });

    const compiled = await compileGraph(spec, { cwd: fixtureDir });
    expect(registry.getReducer("mergeTags")).toBeUndefined();

    const threadId = "map-imported-reducer";
    const parked = await compiled.run({ threadId, onInterrupt: "fail" });
    expect(parked.error).toBeUndefined();
    expect(parked.status).toBe("interrupted");
    expect(parked.state["tags"]).toEqual(["seed", "done:ok"]);

    const parkedSnap = await compiled.getState(threadId);
    expect(parkedSnap?.values["tags"]).toEqual(["seed", "done:ok"]);

    const completed = await compiled.resume({ threadId, resume: "done:resumed", onInterrupt: "fail" });
    expect(completed.status).toBe("completed");
    expect(completed.state["tags"]).toEqual(["seed", "done:ok", "done:resumed"]);

    const finalSnap = await compiled.getState(threadId);
    expect(finalSnap?.values["tags"]).toEqual(["seed", "done:ok", "done:resumed"]);
  });

  it("rejects colliding reducer names with PLUGIN_REDUCER_COLLISION and names the existing source", async () => {
    const spec = baseSpec({
      imports: [{ reducers: "./reducer-1.mjs" }, { reducers: "./reducer-2.mjs" }],
      state: { channels: { tags: { type: "array", reducer: "custom:mergeTags" } } },
      nodes: [],
      edges: [{ from: "START", to: "END" }],
    });
    await expect(compileGraph(spec, { cwd: fixtureDir })).rejects.toMatchObject({
      code: "PLUGIN_REDUCER_COLLISION",
      message: expect.stringContaining("./reducer-1.mjs"),
    });

    // Child subgraph colliding with a parent-imported reducer names the parent's import
    const childCollideSpec = baseSpec({
      imports: [{ reducers: "./reducer-1.mjs" }],
      state: { channels: { tags: { type: "array", reducer: "custom:mergeTags" } } },
      nodes: [
        {
          id: "sub",
          type: "subgraph",
          uses: "./child-other-reducer.graph.yaml",
        },
      ],
      edges: [
        { from: "START", to: "sub" },
        { from: "sub", to: "END" },
      ],
    });
    const childRes = await (await compileGraph(childCollideSpec, { cwd: fixtureDir })).run();
    expect(childRes.status).toBe("error");
    expect((childRes.error as Error & { code?: string })?.code).toBe("PLUGIN_REDUCER_COLLISION");
    expect(childRes.error?.message).toContain("./reducer-1.mjs");
    expect(childRes.error?.message).not.toContain("built-in or host");

    // Imported reducer colliding with a host-registered reducer says "built-in or host"
    const hostReg = registry.fork();
    hostReg.registerReducer("mergeTags", (a, b) => b ?? a);
    const hostSpec = baseSpec({
      imports: [{ reducers: "./reducer-1.mjs" }],
      state: { channels: { tags: { type: "array", reducer: "custom:mergeTags" } } },
      nodes: [],
      edges: [{ from: "START", to: "END" }],
    });
    await expect(compileGraph(hostSpec, { cwd: fixtureDir, registry: hostReg })).rejects.toMatchObject({
      code: "PLUGIN_REDUCER_COLLISION",
      message: expect.stringContaining("built-in or host"),
    });
  });

  it("evaluates isUntrustedSafe and requireSafeNodeTypes against per-compile forked registries", async () => {
    const forked = registry.fork();
    expect(forked.isUntrustedSafe("agent")).toBe(true);
    expect(forked.isUntrustedSafe("shell")).toBe(false);

    const safeFactory = {
      type: "acme/safe-echo",
      configSchema: z.object({}).passthrough(),
      capabilities: { hostAccess: false },
      build() {
        return {
          contract: {},
          capabilities: { hostAccess: false },
          async run() {
            return { update: { out: "safe-ok" } };
          },
        };
      },
    };
    const unsafeFactory = {
      type: "acme/unsafe-echo",
      configSchema: z.object({}).passthrough(),
      capabilities: {},
      build() {
        return {
          contract: {},
          capabilities: {},
          async run() {
            return { update: { out: "unsafe" } };
          },
        };
      },
    };

    const safeSpec = baseSpec({ nodes: [{ id: "n", type: "acme/safe-echo" }] });
    const compiledSafe = await compileGraph(safeSpec, {
      extraFactories: [safeFactory],
      nodePolicy: { requireSafeNodeTypes: true },
    });
    expect(registry.isUntrustedSafe("acme/safe-echo")).toBe(false);
    const safeRes = await compiledSafe.run();
    expect(safeRes.status).toBe("completed");
    expect(safeRes.state["out"]).toBe("safe-ok");

    const unsafeSpec = baseSpec({ nodes: [{ id: "n", type: "acme/unsafe-echo" }] });
    await expect(
      compileGraph(unsafeSpec, {
        extraFactories: [unsafeFactory],
        nodePolicy: { requireSafeNodeTypes: true },
      }),
    ).rejects.toMatchObject({ code: "NODE_TYPE_BLOCKED" });
  });

  it("runs a kind: plugin provider with adapter-validated options scoped to the compile", async () => {
    const spec = baseSpec({
      imports: [{ providers: "./provider-plugin.mjs" }],
      providers: {
        custom: {
          kind: "plugin",
          plugin: "acme/custom-llm",
          options: { tag: "v1" },
        },
      },
      nodes: [
        {
          id: "a",
          type: "agent",
          provider: "custom",
          with: { prompt: "hi", output: { to: "out" } },
        },
      ],
      edges: [
        { from: "START", to: "a" },
        { from: "a", to: "END" },
      ],
    });

    const compiled = await compileGraph(spec, { cwd: fixtureDir });
    expect(getProvider("custom")).toBeUndefined();
    const res = await compiled.run();
    expect(res.status).toBe("completed");
    expect(res.state["out"]).toBe("v1:hi");
  });

  it("rejects invalid kind: plugin provider options with PROVIDER_OPTIONS_INVALID", async () => {
    const spec = baseSpec({
      imports: [{ providers: "./provider-plugin.mjs" }],
      providers: {
        custom: {
          kind: "plugin",
          plugin: "acme/custom-llm",
          options: { tag: 123 },
        },
      },
      nodes: [
        {
          id: "a",
          type: "agent",
          provider: "custom",
          with: { prompt: "hi", output: { to: "out" } },
        },
      ],
      edges: [
        { from: "START", to: "a" },
        { from: "a", to: "END" },
      ],
    });

    await expect(compileGraph(spec, { cwd: fixtureDir })).rejects.toMatchObject({
      code: "PROVIDER_OPTIONS_INVALID",
    });
  });

  it("rejects unknown kind: plugin provider with PROVIDER_PLUGIN_NOT_FOUND", async () => {
    const spec = baseSpec({
      providers: {
        missing: {
          kind: "plugin",
          plugin: "acme/does-not-exist",
          options: {},
        },
      },
      nodes: [
        {
          id: "a",
          type: "agent",
          provider: "missing",
          with: { prompt: "hi", output: { to: "out" } },
        },
      ],
      edges: [
        { from: "START", to: "a" },
        { from: "a", to: "END" },
      ],
    });

    await expect(compileGraph(spec, { cwd: fixtureDir })).rejects.toMatchObject({
      code: "PROVIDER_PLUGIN_NOT_FOUND",
    });
  });

  it("validates registered provider plugin options offline in validateSpec", () => {
    const plugin = defineProviderPlugin({
      name: "acme/offline-checked",
      optionsSchema: z.object({ endpoint: z.string().url() }).strict(),
      create: (opts, ctx) => ({
        name: ctx.name,
        capabilities: { streaming: false, toolCalling: false, structuredOutput: false },
        run: async () => ({ output: opts.endpoint, stopReason: "done" as const }),
      }),
    });
    registerProviderPlugin(plugin);
    try {
      const bad = baseSpec({
        providers: {
          p: { kind: "plugin", plugin: "acme/offline-checked", options: { endpoint: "not-a-url" } },
        },
        nodes: [{ id: "a", type: "agent", provider: "p", with: { prompt: "hi", output: { to: "out" } } }],
        edges: [
          { from: "START", to: "a" },
          { from: "a", to: "END" },
        ],
      });
      const diags = validateSpec(bad);
      expect(diags).toContainEqual(
        expect.objectContaining({
          code: "PROVIDER_OPTIONS_INVALID",
          severity: "error",
        }),
      );
    } finally {
      unregisterProviderPlugin("acme/offline-checked");
    }
  });

  it("isProviderPlugin rejects adapters, blank names, arrays, and invalid option validators", () => {
    const valid = defineProviderPlugin({
      name: "acme/valid",
      optionsSchema: z.object({}),
      validateOptions: () => [],
      create: (_opts, ctx) => ({
        name: ctx.name,
        capabilities: { streaming: false, toolCalling: false, structuredOutput: false },
        run: async () => ({ output: "ok", stopReason: "done" as const }),
      }),
    });
    const adapter = defineProvider({
      name: "acme/adapter",
      capabilities: { streaming: false, toolCalling: false, structuredOutput: false },
      run: async () => ({ output: "ok", stopReason: "done" as const }),
    });

    expect(isProviderPlugin(valid)).toBe(true);
    expect(isProviderPlugin(adapter)).toBe(false);
    expect(isProviderPlugin({ ...adapter, create: () => adapter })).toBe(false);
    expect(isProviderPlugin({ name: "   ", create: () => adapter })).toBe(false);
    expect(isProviderPlugin([])).toBe(false);
    expect(isProviderPlugin({ name: "acme/bad-schema", optionsSchema: {}, create: () => adapter })).toBe(false);
    expect(
      isProviderPlugin({ name: "acme/bad-validator", validateOptions: "nope", create: () => adapter }),
    ).toBe(false);
  });
});
