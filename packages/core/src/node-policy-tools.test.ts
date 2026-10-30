import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { NODE_POLICY, NodePolicyError, assertNodeSpecAllowed, registeredToolNamesOf, type NodePolicy } from "./node-policy.js";
import { getTool, registerTool } from "./providers/registry.js";
import { normalizeTools } from "./providers/tools.js";
import { registerFunction } from "./nodes/function.js";
import { resetServiceManager } from "./runtime/service-manager.js";
import type { NodeRunContext } from "./context.js";
import "./nodes/index.js";

const UNTRUSTED: NodePolicy = {
  blockedTypes: ["shell", "script", "service", "worktree", "skill", "demo", "mcp"],
  allowedTools: ["ask_human", "list_services", "service_status"],
  allowedFunctions: [],
  blockHostExec: true,
  reason: "test policy",
};

function graph(nodes: unknown[]): GraphSpec {
  const ids = (nodes as Array<{ id: string }>).map((n) => n.id);
  const edges = [{ from: "START", to: ids[0]! }];
  for (let i = 1; i < ids.length; i++) edges.push({ from: ids[i - 1]!, to: ids[i]! });
  edges.push({ from: ids[ids.length - 1]!, to: "END" });
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "tool-policy-graph" },
    state: { channels: { out: { type: "object" } } },
    nodes,
    edges,
  } as unknown as GraphSpec;
}

function ctxWith(policy: NodePolicy | undefined, threadId = "tool-policy"): NodeRunContext {
  const ctx = {
    nodeId: "a",
    workspace: os.tmpdir(),
    meta: { threadId, runId: "r1" },
    config: { configurable: { thread_id: threadId } },
    emit: () => undefined,
  } as unknown as NodeRunContext;
  if (policy) (ctx as unknown as Record<symbol, unknown>)[NODE_POLICY] = policy;
  return ctx;
}

async function codeOf(p: Promise<unknown> | (() => unknown)): Promise<string | undefined> {
  try {
    await (typeof p === "function" ? p() : p);
    return undefined;
  } catch (e) {
    expect(e).toBeInstanceOf(NodePolicyError);
    return (e as NodePolicyError).code;
  }
}

const agent = (tools: unknown[]) => ({ id: "a", type: "agent", with: { provider: "mock", prompt: "hi", tools } });

describe("node policy: agent tools, functions and host programs", () => {
  const marker = path.join(os.tmpdir(), `fg-svc-policy-${process.pid}`);
  afterEach(async () => {
    fs.rmSync(marker, { force: true });
    await resetServiceManager().catch(() => undefined);
  });

  it("start_service, restart_service and stop_service obey a policy that blocks service nodes", async () => {
    const args = { name: "x", command: "sh", args: ["-c", `id > ${marker}`], keepAlive: true };
    expect(await codeOf(Promise.resolve().then(() => getTool("start_service")!.handler(args, ctxWith(UNTRUSTED))))).toBe("NODE_TYPE_BLOCKED");
    expect(await codeOf(Promise.resolve().then(() => getTool("restart_service")!.handler(args, ctxWith(UNTRUSTED))))).toBe("NODE_TYPE_BLOCKED");
    expect(await codeOf(Promise.resolve().then(() => getTool("stop_service")!.handler({ name: "x" }, ctxWith(UNTRUSTED))))).toBe("NODE_TYPE_BLOCKED");
    // Even a policy that allow-lists the tool by name keeps the service-node gate.
    const listed: NodePolicy = { ...UNTRUSTED, allowedTools: ["start_service"] };
    expect(await codeOf(Promise.resolve().then(() => getTool("start_service")!.handler(args, ctxWith(listed))))).toBe("NODE_TYPE_BLOCKED");
    await new Promise((r) => setTimeout(r, 200));
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("refuses agent function tools outside allowedTools at compile, including map inner agents", async () => {
    await expect(codeOf(compileGraph(graph([agent([{ function: "start_service" }])]), { checkpointer: "none", nodePolicy: UNTRUSTED }))).resolves.toBe("TOOL_BLOCKED");
    await expect(codeOf(compileGraph(graph([agent([{ builtin: ["Bash"] }])]), { checkpointer: "none", nodePolicy: UNTRUSTED }))).resolves.toBe("TOOL_BLOCKED");
    const map = {
      id: "m",
      type: "map",
      with: { over: "{{ state.items }}", as: "x", node: { type: "agent", with: { provider: "mock", prompt: "p", tools: [{ function: "start_service" }] } }, collect: { to: "out" } },
    };
    await expect(codeOf(compileGraph(graph([map]), { checkpointer: "none", nodePolicy: UNTRUSTED }))).resolves.toBe("TOOL_BLOCKED");
    // Allowed tools still compile.
    await expect(compileGraph(graph([agent([{ function: "ask_human" }])]), { checkpointer: "none", nodePolicy: UNTRUSTED })).resolves.toBeDefined();
  });

  it("refuses a tool outside allowedTools when it is called, for function refs and mapped builtins", async () => {
    let calls = 0;
    registerTool({ name: "fg_policy_probe_tool", handler: () => ++calls });
    registerTool({ name: "fs_bash", handler: () => ++calls });
    const { normalized } = normalizeTools([{ function: "fg_policy_probe_tool" }, { builtin: ["Bash"] }]);
    const policy: NodePolicy = { allowedTools: ["ask_human"] };
    expect(await codeOf(normalized.executors.get("fg_policy_probe_tool")!({}, ctxWith(policy)))).toBe("TOOL_BLOCKED");
    expect(await codeOf(normalized.executors.get("Bash")!({}, ctxWith(policy)))).toBe("TOOL_BLOCKED");
    expect(calls).toBe(0);
    // Without a policy (local CLI) the same tools run.
    await normalized.executors.get("fg_policy_probe_tool")!({}, ctxWith(undefined));
    expect(calls).toBe(1);
  });

  it("refuses function nodes outside allowedFunctions at compile and at run", async () => {
    let ran = 0;
    registerFunction("fg_policy_probe_fn", () => ++ran);
    const fnNode = { id: "f", type: "function", with: { fn: "fg_policy_probe_fn", output: { to: "out" } } };
    await expect(codeOf(compileGraph(graph([fnNode]), { checkpointer: "none", nodePolicy: UNTRUSTED }))).resolves.toBe("FUNCTION_BLOCKED");
    // A map inner function node is checked when map builds it at run time too.
    expect(await codeOf(() => assertNodeSpecAllowed(UNTRUSTED, fnNode, "inner"))).toBe("FUNCTION_BLOCKED");
    const ok = await compileGraph(graph([fnNode]), { checkpointer: "none", nodePolicy: { ...UNTRUSTED, allowedFunctions: ["fg_policy_probe_fn"] } });
    expect((await ok.run({ threadId: "fn-ok" })).status).toBe("completed");
    expect(ran).toBe(1);
  });

  it("refuses a workshop git diff under blockHostExec but allows before/after diffs", async () => {
    const ws = (diff: unknown) => ({ id: "w", type: "workshop", with: { agenda: ["ok?"], diff, output: { to: "out" } } });
    await expect(codeOf(compileGraph(graph([ws({ cwd: "/" })]), { checkpointer: "none", nodePolicy: UNTRUSTED }))).resolves.toBe("HOST_EXEC_BLOCKED");
    await expect(compileGraph(graph([ws({ before: "a", after: "b" })]), { checkpointer: "none", nodePolicy: UNTRUSTED })).resolves.toBeDefined();
  });

  it("lists the registered tools an agent tool list refers to", () => {
    expect(registeredToolNamesOf([{ function: "a" }, { builtin: ["Read", "WebSearch"] }, { skill: "s" }, { node: "n" }])).toEqual(["a", "fs_read"]);
  });
});
