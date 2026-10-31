import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph, hydrateDurableRuntime, maybeTerminateServices } from "./compiler.js";
import { NODE_POLICY, NodePolicyError, assertNodeSpecAllowed, registeredToolNamesOf, type NodePolicy } from "./node-policy.js";
import { getTool, registerTool } from "./providers/registry.js";
import { normalizeTools } from "./providers/tools.js";
import { registerFunction } from "./nodes/function.js";
import { resetServiceManager, statusService } from "./runtime/service-manager.js";
import { hitlNode } from "./nodes/hitl.js";
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
    registerTool({ name: "fg_policy_test_tool", handler: () => ++calls });
    registerTool({ name: "fs_bash", handler: () => ++calls });
    const { normalized } = normalizeTools([{ function: "fg_policy_test_tool" }, { builtin: ["Bash"] }]);
    const policy: NodePolicy = { allowedTools: ["ask_human"] };
    expect(await codeOf(normalized.executors.get("fg_policy_test_tool")!({}, ctxWith(policy)))).toBe("TOOL_BLOCKED");
    expect(await codeOf(normalized.executors.get("Bash")!({}, ctxWith(policy)))).toBe("TOOL_BLOCKED");
    expect(calls).toBe(0);
    // Without a policy (local CLI) the same tools run.
    await normalized.executors.get("fg_policy_test_tool")!({}, ctxWith(undefined));
    expect(calls).toBe(1);
  });

  it("refuses function nodes outside allowedFunctions at compile and at run", async () => {
    let ran = 0;
    registerFunction("fg_policy_test_fn", () => ++ran);
    const fnNode = { id: "f", type: "function", with: { fn: "fg_policy_test_fn", output: { to: "out" } } };
    await expect(codeOf(compileGraph(graph([fnNode]), { checkpointer: "none", nodePolicy: UNTRUSTED }))).resolves.toBe("FUNCTION_BLOCKED");
    // A map inner function node is checked when map builds it at run time too.
    expect(await codeOf(() => assertNodeSpecAllowed(UNTRUSTED, fnNode, "inner"))).toBe("FUNCTION_BLOCKED");
    const ok = await compileGraph(graph([fnNode]), { checkpointer: "none", nodePolicy: { ...UNTRUSTED, allowedFunctions: ["fg_policy_test_fn"] } });
    expect((await ok.run({ threadId: "fn-ok" })).status).toBe("completed");
    expect(ran).toBe(1);
  });

  it("refuses a workshop git diff under blockHostExec but allows before/after diffs", async () => {
    const ws = (diff: unknown) => ({ id: "w", type: "workshop", with: { agenda: ["ok?"], diff, output: { to: "out" } } });
    await expect(codeOf(compileGraph(graph([ws({ cwd: "/" })]), { checkpointer: "none", nodePolicy: UNTRUSTED }))).resolves.toBe("HOST_EXEC_BLOCKED");
    await expect(compileGraph(graph([ws({ before: "a", after: "b" })]), { checkpointer: "none", nodePolicy: UNTRUSTED })).resolves.toBeDefined();
  });

  it("refuses reserved state channels in run input, with or without a policy", async () => {
    const gate = { id: "g", type: "hitl", with: { mode: "approve", message: "ok?", output: { to: "out" } } };
    for (const nodePolicy of [UNTRUSTED, undefined]) {
      const g = await compileGraph(graph([gate]), { checkpointer: "memory", ...(nodePolicy ? { nodePolicy } : {}) });
      for (const key of ["__services", "__worktrees", "__agentReplay", "__once", "__interrupt__"]) {
        await expect(codeOf(g.run({ threadId: `rsv-${key}`, input: { [key]: {} } }))).resolves.toBe("RESERVED_CHANNEL_BLOCKED");
      }
    }
  });

  it("refuses graphs that declare or write reserved channels under a policy", async () => {
    const setNode = { id: "g", type: "hitl", with: { mode: "approve", message: "ok?", output: { to: "__services" } } };
    await expect(codeOf(compileGraph(graph([setNode]), { checkpointer: "memory", nodePolicy: UNTRUSTED }))).resolves.toBe("RESERVED_CHANNEL_BLOCKED");
    const declared = { ...graph([{ id: "g", type: "hitl", with: { mode: "approve", message: "ok?" } }]), state: { channels: { __worktrees: { type: "array" } } } } as unknown as GraphSpec;
    await expect(codeOf(compileGraph(declared, { checkpointer: "memory", nodePolicy: UNTRUSTED }))).resolves.toBe("RESERVED_CHANNEL_BLOCKED");
  });

  it("refuses runtime settings that start programs from saved state", async () => {
    const gate = { id: "g", type: "hitl", with: { mode: "approve", message: "ok?", output: { to: "out" } } };
    const withRuntime = (runtime: unknown) => ({ ...graph([gate]), runtime }) as GraphSpec;
    await expect(codeOf(compileGraph(withRuntime({ services: { rehydrateOnResume: true } }), { checkpointer: "memory", nodePolicy: UNTRUSTED }))).resolves.toBe("HOST_EXEC_BLOCKED");
    await expect(codeOf(compileGraph(withRuntime({ worktrees: { cleanupOnEnd: true } }), { checkpointer: "memory", nodePolicy: UNTRUSTED }))).resolves.toBe("HOST_EXEC_BLOCKED");
    // Blocking only the node type is enough.
    await expect(codeOf(compileGraph(withRuntime({ services: { rehydrateOnResume: true } }), { checkpointer: "memory", nodePolicy: { blockedTypes: ["service"] } }))).resolves.toBe("HOST_EXEC_BLOCKED");
    await expect(compileGraph(withRuntime({ services: { rehydrateOnResume: true } }), { checkpointer: "memory" })).resolves.toBeDefined();
  });

  it("does not restart services recorded in state under a policy that blocks them", async () => {
    const spec = { ...graph([{ id: "g", type: "hitl", with: { mode: "approve", message: "ok?" } }]), runtime: { services: { rehydrateOnResume: true } } } as GraphSpec;
    const intents = { pwn: { name: "pwn", command: "sh", args: ["-c", `id > ${marker}`], keepAlive: true } };
    const snap = { values: { __services: intents } };
    const executeInvoke = async () => {
      throw new Error("not used");
    };
    await hydrateDurableRuntime(snap, "hydrate-blocked", spec, { executeInvoke, nodePolicy: UNTRUSTED, rehydrateWebhooks: false });
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.existsSync(marker)).toBe(false);
    expect(statusService("hydrate-blocked", "pwn").status).toBe("not_found");
    expect(intents.pwn).toMatchObject({ needsRestart: true, rehydrateError: expect.stringMatching(/not allowed here/) });
  });

  it("skips worktree cleanup from state under a policy that blocks worktrees", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fg-wt-policy-"));
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const wt = path.join(repo, "..", `${path.basename(repo)}-wt`);
    git("worktree", "add", "-q", "--detach", wt);
    const spec = { ...graph([{ id: "g", type: "hitl", with: { mode: "approve", message: "ok?" } }]), runtime: { worktrees: { cleanupOnEnd: true } } } as GraphSpec;
    const state = { __worktrees: [{ path: wt, repo }] };
    try {
      await maybeTerminateServices(spec, "wt-blocked", state, UNTRUSTED);
      expect(fs.existsSync(wt)).toBe(true);
      await maybeTerminateServices(spec, "wt-allowed", state);
      expect(fs.existsSync(wt)).toBe(false);
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a review-mode hitl git diff under blockHostExec, and skips the workspace diff for a plain review", async () => {
    const review = (diff?: unknown) => ({ id: "r", type: "hitl", with: { mode: "review", message: "look", ...(diff ? { diff } : {}), output: { to: "out" } } });
    await expect(codeOf(compileGraph(graph([review({ cwd: "/", base: "HEAD" })]), { checkpointer: "memory", nodePolicy: UNTRUSTED }))).resolves.toBe("HOST_EXEC_BLOCKED");
    expect(await codeOf(() => assertNodeSpecAllowed(UNTRUSTED, review({ paths: ["x"] }), "inner"))).toBe("HOST_EXEC_BLOCKED");
    await expect(compileGraph(graph([review({ before: "a", after: "b" })]), { checkpointer: "memory", nodePolicy: UNTRUSTED })).resolves.toBeDefined();
    // At run time too, when the node is reached without the compile check.
    const node = hitlNode.build({} as never, review({ cwd: "/" }), (review({ cwd: "/" }) as unknown as { with: never }).with);
    await expect(codeOf(node.run({}, ctxWith(UNTRUSTED)))).resolves.toBe("HOST_EXEC_BLOCKED");
    // A review without `diff` still interrupts, with no git diff collected.
    const plain = await compileGraph(graph([review()]), { checkpointer: "memory", nodePolicy: UNTRUSTED });
    const r = await plain.run({ threadId: "review-plain" });
    expect(r.status).toBe("interrupted");
    expect(JSON.stringify(r.interrupts)).not.toMatch(/diffStat|patch/);
  });

  it("lists the registered tools an agent tool list refers to", () => {
    expect(registeredToolNamesOf([{ function: "a" }, { builtin: ["Read", "WebSearch"] }, { skill: "s" }, { node: "n" }])).toEqual(["a", "fs_read"]);
  });
});
