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
  defineProviderPlugin,
  getProvider,
  registerProviderPlugin,
  unregisterProviderPlugin,
} from "../providers/index.js";

let fixtureDir = "";

beforeAll(async () => {
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "flowgraph-ext2-"));

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

  // Plugin colliding with built-in node type (must fail with PLUGIN_TYPE_COLLISION or PLUGIN_TYPE_INVALID)
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

  // Provider plugin module
  await fs.writeFile(
    path.join(fixtureDir, "provider-plugin.mjs"),
    `export default {
  __flowgraphProviderPlugin: true,
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
});

afterAll(async () => {
  if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
});

function baseSpec(overrides: Record<string, unknown>): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "ext2-test" },
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

describe("EXT-2: namespaced plugins, collision errors, per-compile registry and plugin providers", () => {
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
    });
  });

  it("rejects colliding reducer names with PLUGIN_REDUCER_COLLISION", async () => {
    const spec = baseSpec({
      imports: [{ reducers: "./reducer-1.mjs" }, { reducers: "./reducer-2.mjs" }],
      state: { channels: { tags: { type: "array", reducer: "custom:mergeTags" } } },
      nodes: [],
      edges: [{ from: "START", to: "END" }],
    });
    await expect(compileGraph(spec, { cwd: fixtureDir })).rejects.toMatchObject({
      code: "PLUGIN_REDUCER_COLLISION",
    });
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
});
