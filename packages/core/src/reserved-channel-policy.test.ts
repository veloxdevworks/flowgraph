/**
 * Reserved channel names (any `__` prefix), engine-owned writes, and the
 * policy switches for host-loaded agents, imports and inbound webhooks.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { MemorySaver } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { createLangChainProvider } from "./index.js";
import { NodePolicyError, assertNoReservedInput, isReservedChannel, reservedStateMapRefs, reservedTemplateRefs, type NodePolicy } from "./node-policy.js";
import { registerFunction } from "./nodes/function.js";
import { unwrapUpdate } from "./nodes/map.js";
import { registerProvider } from "./providers/registry.js";
import "./nodes/index.js";

const POLICY: NodePolicy = {
  blockedTypes: ["shell", "script", "service", "worktree", "skill", "demo", "mcp"],
  blockHostExec: true,
  blockAgentRefs: true,
  blockImports: true,
  blockInboundWebhooks: true,
  allowedFunctions: [],
  reason: "test policy",
};

function graph(nodes: unknown[], extra: Record<string, unknown> = {}): GraphSpec {
  const ids = (nodes as Array<{ id: string }>).map((n) => n.id);
  const edges = [{ from: "START", to: ids[0]! }];
  for (let i = 1; i < ids.length; i++) edges.push({ from: ids[i - 1]!, to: ids[i]! });
  edges.push({ from: ids[ids.length - 1]!, to: "END" });
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "reserved-graph" },
    state: { channels: { out: { type: "object" }, blob: { type: "object" } } },
    nodes,
    edges,
    ...extra,
  } as unknown as GraphSpec;
}

const waitChild = {
  apiVersion: "flowgraph/v1",
  kind: "Graph",
  metadata: { name: "child" },
  nodes: [{ id: "w", type: "wait", with: { duration: "1ms" } }],
  edges: [
    { from: "START", to: "w" },
    { from: "w", to: "END" },
  ],
};

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    expect(e).toBeInstanceOf(NodePolicyError);
    return (e as NodePolicyError).code;
  }
}

const cleanup: string[] = [];
afterEach(() => {
  for (const p of cleanup.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

describe("reserved reads in templated node fields", () => {
  it("finds {{ }} reads of __ channels in any with field, not plain text", () => {
    const node = (w: Record<string, unknown>) => ({ id: "a", type: "agent", with: w }) as never;
    expect(reservedTemplateRefs(node({ prompt: "{{ state.__services }}" }))).toEqual(["with.prompt"]);
    expect(reservedTemplateRefs(node({ tools: [{ args: { q: "{{ state['\uFF3F\uFF3Fx'] }}" } }] })).length).toBe(1);
    expect(reservedTemplateRefs(node({ prompt: "fix __init__.py using {{ state.out }}" }))).toEqual([]);
  });

  it("finds reads spelled with escapes or built from constant pieces", () => {
    const refs = (prompt: string) => reservedTemplateRefs({ with: { prompt } });
    for (const t of [
      "{{ state['_' + '_x'] }}",
      '{{ state["_" + "_x"] |> upper }}',
      "{{ state['\\_\\_x'] }}",
      "{{ state['\\u005f\\u005fx'] }}",
      "{{ state['\u005f\u005fx'] }}",
      "{{ len(state[true ? '__x' : 'y']) }}",
    ]) {
      expect(refs(t), t).toEqual(["with.prompt"]);
    }
    for (const t of ["{{ state['_' + 'x'] }}", "{{ state[input.k] }}", "{{ '_' + '_x' }}", "{{ state['a'] }}"]) expect(refs(t), t).toEqual([]);
  });

  it("refuses them under the policy, and an unrefused read still sees no engine channel", async () => {
    const hitl = (message: string) => graph([{ id: "a", type: "hitl", with: { mode: "approve", message } }]);
    expect(await codeOf(compileGraph(hitl("{{ state.__services }}"), { nodePolicy: POLICY }))).toBe("RESERVED_CHANNEL_BLOCKED");
    expect(await codeOf(compileGraph(hitl("{{ state['\u200B__services'] }}"), { nodePolicy: POLICY }))).toBe("RESERVED_CHANNEL_BLOCKED");
    expect(await codeOf(compileGraph(hitl("{{ state['_' + '_services'] }}"), { nodePolicy: POLICY }))).toBe("RESERVED_CHANNEL_BLOCKED");
    expect(await codeOf(compileGraph(hitl("{{ state[lower('_') + '_services'] }}"), { nodePolicy: POLICY }))).toBe("RESERVED_CHANNEL_BLOCKED");
    // An index that calls a function the check does not evaluate is not followed; the render hides `__` keys instead.
    const g = await compileGraph(hitl("[{{ state[('a' |> replace('a', '_')) + '_agentReplay'] }}|{{ keys(state) }}]"), { nodePolicy: POLICY, checkpointer: new MemorySaver() });
    const res = await g.run({ input: {}, threadId: `rt-${randomUUID()}` });
    const shown = JSON.stringify(res.interrupts ?? []);
    expect(shown).toContain("[|");
    expect(shown).not.toMatch(/"__(services|agentReplay|worktrees)"/);
  });
});

describe("reserved channel names", () => {
  it("every __ name is reserved, known or not", () => {
    for (const n of ["__services", "__agentReplay", "__interrupt__", "__future", "__"]) expect(isReservedChannel(n)).toBe(true);
    for (const n of ["services", "_x", "a__b"]) expect(isReservedChannel(n)).toBe(false);
    for (const n of ["\uFF3F\uFF3Fservices", "\u200B__services", "\uFEFF__x", " __x"]) expect(isReservedChannel(n), JSON.stringify(n)).toBe(true);
    expect(() => assertNoReservedInput({ ok: 1, __future: 1 }, "run input")).toThrow(/__future/);
    expect(() => assertNoReservedInput({ ok: 1 }, "run input")).not.toThrow();
  });

  it("refuses run input with an unknown __ name, with or without a policy", async () => {
    const g = await compileGraph(graph([{ id: "w", type: "wait", with: { duration: "1ms" } }]));
    await expect(g.run({ input: { __future: 1 } })).rejects.toMatchObject({ code: "RESERVED_CHANNEL_BLOCKED" });
  });

  it("refuses declaring or writing an unknown __ channel under a policy", async () => {
    const declared = graph([{ id: "w", type: "wait", with: { duration: "1ms" } }]);
    (declared.state!.channels as Record<string, unknown>).__future = { type: "object" };
    expect(await codeOf(compileGraph(declared, { nodePolicy: POLICY }))).toBe("RESERVED_CHANNEL_BLOCKED");
    const written = graph([{ id: "w", type: "wait", with: { duration: "1ms", output: { to: "__future" } } }]);
    (written.state!.channels as Record<string, unknown>).__future = { type: "object" };
    expect(await codeOf(compileGraph(written, { nodePolicy: POLICY }))).toBe("RESERVED_CHANNEL_BLOCKED");
  });

  it("finds reserved names in stateMap keys and values", () => {
    expect(reservedStateMapRefs({ with: { stateMap: { in: { __agentReplay: "blob", x: "{{ state.__services }}", y: "__worktrees", ok: "blob" } } } })).toEqual([
      "stateMap.in.__agentReplay",
      "stateMap.in.x",
      "stateMap.in.y",
    ]);
    expect(reservedStateMapRefs({ with: { stateMap: { out: { __services: "x", z: "{{ state['__once'] }}", ok: "{{ state.a__b }}" } } } })).toEqual([
      "stateMap.out.__services",
      "stateMap.out.z",
    ]);
  });

  it("refuses reserved stateMap entries under a policy, nested subgraphs included", async () => {
    const sg = (stateMap: unknown) => ({ id: "sg", type: "subgraph", spec: waitChild, with: { stateMap } });
    for (const stateMap of [
      { in: { __agentReplay: "blob" } },
      { in: { x: "__services" } },
      { in: { x: "{{ state.__agentReplay }}" } },
      { out: { __services: "x" } },
      { out: { blob: "__worktrees" } },
    ]) {
      expect(await codeOf(compileGraph(graph([sg(stateMap)]), { nodePolicy: POLICY })), JSON.stringify(stateMap)).toBe("RESERVED_CHANNEL_BLOCKED");
    }
    const nested = { ...waitChild, nodes: [sg({ in: { __services: "blob" } })], edges: [{ from: "START", to: "sg" }, { from: "sg", to: "END" }] };
    const outer = { id: "outer", type: "subgraph", spec: nested, with: {} };
    expect(await codeOf(compileGraph(graph([outer]), { nodePolicy: POLICY }))).toBe("RESERVED_CHANNEL_BLOCKED");
  });

  it("drops engine channels a node type does not own, even without a policy", async () => {
    const fn = `fg_reserved_test_${randomUUID().slice(0, 8)}`;
    registerFunction(fn, () => ({ __services: { pwn: { command: "sh", args: ["-c", "id"] } }, __issues: [{ code: "FAKE" }], ok: 1 }));
    const spec = graph([
      { id: "f", type: "function", with: { fn, output: { to: "out", map: { __services: "{{ result.__services }}", __issues: "{{ result.__issues }}" } } } },
    ]);
    const checkpointer = new MemorySaver();
    const g = await compileGraph(spec, { checkpointer });
    const thread = `t-${randomUUID()}`;
    const res = await g.run({ input: {}, threadId: thread });
    expect(res.status).toBe("completed");
    const tuple = await checkpointer.getTuple({ configurable: { thread_id: thread } });
    const values = (tuple?.checkpoint.channel_values ?? {}) as Record<string, unknown>;
    expect(Object.keys((values.__services as object | undefined) ?? {})).toEqual([]);
    expect(((values.__issues as unknown[] | undefined) ?? []).length).toBe(0);
  });
});

describe("map results", () => {
  it("leave out every __ key from a collected inner result", () => {
    expect(unwrapUpdate({ update: { value: 1, __agentReplay: {}, __future: "x" } })).toBe(1);
    expect(unwrapUpdate({ update: { a: 1, b: 2, __services: {} } })).toEqual({ a: 1, b: 2 });
  });
});

describe("host-loaded definitions under a policy", () => {
  it("refuses with.agent (AGENT_REF_BLOCKED), map inners included", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-agentref-"));
    cleanup.push(dir);
    fs.writeFileSync(path.join(dir, "AGENT.md"), "---\nname: x\n---\nhi\n");
    const agent = { id: "a", type: "agent", with: { agent: dir, prompt: "hi" } };
    expect(await codeOf(compileGraph(graph([agent]), { nodePolicy: POLICY }))).toBe("AGENT_REF_BLOCKED");
    const named = { id: "a", type: "agent", with: { agent: "some-installed-agent", prompt: "hi" } };
    expect(await codeOf(compileGraph(graph([named]), { nodePolicy: POLICY }))).toBe("AGENT_REF_BLOCKED");
    // A map inner agent is checked too.
    const map = { id: "m", type: "map", with: { over: "{{ state.blob }}", node: { ...agent, id: "in" } } };
    expect(await codeOf(compileGraph(graph([map]), { nodePolicy: POLICY }))).toBe("AGENT_REF_BLOCKED");
  });

  it("refuses imports in an inline subgraph before loading them (IMPORTS_BLOCKED)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-imports-"));
    cleanup.push(dir);
    const marker = path.join(dir, "MARKER");
    const mod = path.join(dir, "mod.mjs");
    fs.writeFileSync(mod, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "loaded");\nexport default [];\n`);
    const child = { ...waitChild, imports: [{ providers: mod }] };
    const spec = graph([{ id: "sg", type: "subgraph", spec: child, with: {} }]);
    expect(await codeOf(compileGraph(spec, { nodePolicy: POLICY }))).toBe("IMPORTS_BLOCKED");
    const inMap = graph([{ id: "m", type: "map", with: { over: "{{ state.blob }}", node: { id: "in", type: "subgraph", spec: child, with: {} } } }]);
    expect(await codeOf(compileGraph(inMap, { nodePolicy: POLICY }))).toBe("IMPORTS_BLOCKED");
    expect(await codeOf(compileGraph({ ...spec, imports: [{ providers: mod }] } as GraphSpec, { nodePolicy: POLICY }))).toBe("IMPORTS_BLOCKED");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("refuses inbound webhooks (INBOUND_WEBHOOK_BLOCKED)", async () => {
    const wait = graph([{ id: "w", type: "wait", with: { webhook: true } }]);
    expect(await codeOf(compileGraph(wait, { nodePolicy: POLICY }))).toBe("INBOUND_WEBHOOK_BLOCKED");
    const server = graph([{ id: "w", type: "wait", with: { duration: "1ms" } }], { runtime: { webhookServer: { host: "0.0.0.0", port: 1 } } });
    expect(await codeOf(compileGraph(server, { nodePolicy: POLICY }))).toBe("INBOUND_WEBHOOK_BLOCKED");
  });
});

describe("providers stay with their graph", () => {
  const providerAnswering = (name: string, text: string) =>
    createLangChainProvider(
      {
        invoke: async () => new AIMessage({ content: text }),
        bindTools() {
          return this;
        },
      } as never,
      { name },
    );
  const agentGraph = (name: string) => graph([{ id: "a", type: "agent", provider: name, with: { prompt: "hi", output: { to: "out" } } }]);

  it("a later compile or registration with the same name does not change an earlier graph's provider", async () => {
    const name = `llm-${randomUUID().slice(0, 8)}`;
    const first = await compileGraph(agentGraph(name), { providers: [providerAnswering(name, "first")] });
    await compileGraph(agentGraph(name), { providers: [providerAnswering(name, "second")], nodePolicy: POLICY });
    await compileGraph(agentGraph(name), { providers: [providerAnswering(name, "third")] });
    registerProvider(providerAnswering(name, "global"));
    const res = await first.run({ input: {} });
    expect(JSON.stringify(res.state.out)).toContain("first");
  });

  it("a graph under a policy cannot use a provider it was not compiled with", async () => {
    const name = `llm-${randomUUID().slice(0, 8)}`;
    registerProvider(providerAnswering(name, "operator"));
    const g = await compileGraph(agentGraph(name), { providers: [], nodePolicy: POLICY });
    const res = await g.run({ input: {} });
    expect(res.status).toBe("error");
    expect(res.error?.message).toMatch(/not registered/);
  });

  it("an inline subgraph under a policy answers with the parent's providers", async () => {
    const name = `llm-${randomUUID().slice(0, 8)}`;
    registerProvider(providerAnswering(name, "operator"));
    const inner = { ...waitChild, state: { channels: { out: { type: "object" } } }, nodes: [{ id: "a", type: "agent", provider: name, with: { prompt: "hi", output: { to: "out" } } }], edges: [{ from: "START", to: "a" }, { from: "a", to: "END" }] };
    const g = await compileGraph(graph([{ id: "sg", type: "subgraph", spec: inner, with: { stateMap: { out: { out: "out" } } } }]), {
      providers: [providerAnswering(name, "parent")],
      nodePolicy: POLICY,
    });
    const res = await g.run({ input: {} });
    expect(res.status, res.error?.message).toBe("completed");
    expect(JSON.stringify(res.state.out)).toContain("parent");
  });
});
