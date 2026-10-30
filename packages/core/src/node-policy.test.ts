import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { NodePolicyError, type NodePolicy } from "./node-policy.js";

const POLICY: NodePolicy = {
  blockedTypes: ["shell", "script", "service", "worktree", "skill", "demo"],
  blockSubgraphFiles: true,
  blockSecrets: true,
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
    metadata: { name: "policy-graph" },
    state: { channels: { out: { type: "object" } } },
    nodes,
    edges,
  } as unknown as GraphSpec;
}

const shellNode = { id: "sh", type: "shell", with: { command: "echo hi", output: { to: "out" } } };

async function runError(p: Promise<{ status: string; error?: unknown }>): Promise<string> {
  const r = await p;
  expect(r.status).toBe("error");
  const e = r.error as { message?: string; code?: string } | undefined;
  return `${e?.code ?? ""} ${e?.message ?? String(e)}`;
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(NodePolicyError);
  expect((err as NodePolicyError).code).toBe(code);
}

describe("node policy", () => {
  it("compiles a shell node when no policy is set", async () => {
    await expect(compileGraph(graph([shellNode]), { checkpointer: "none" })).resolves.toBeDefined();
  });

  it("refuses a blocked node type at compile", async () => {
    await expectCode(compileGraph(graph([shellNode]), { checkpointer: "none", nodePolicy: POLICY }), "NODE_TYPE_BLOCKED");
  });

  it("refuses a blocked map inner node at compile", async () => {
    const map = {
      id: "m",
      type: "map",
      with: { over: "{{ state.items }}", as: "x", node: { type: "script", with: { code: "1" } }, collect: { to: "out" } },
    };
    await expectCode(compileGraph(graph([map]), { checkpointer: "none", nodePolicy: POLICY }), "NODE_TYPE_BLOCKED");
  });

  it("refuses a blocked node inside an inline subgraph when the child compiles", async () => {
    const sub = { id: "child", type: "subgraph", spec: graph([shellNode]) };
    const compiled = await compileGraph(graph([sub]), { checkpointer: "memory", nodePolicy: POLICY });
    expect(await runError(compiled.run({ threadId: "sub-inline" }))).toMatch(/node type "shell" is not allowed here \(test policy\)/);
  });

  it("refuses a file subgraph at run time", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-policy-"));
    try {
      fs.writeFileSync(
        path.join(dir, "child.graph.yaml"),
        "apiVersion: flowgraph/v1\nkind: Graph\nmetadata: { name: child }\nnodes: [{ id: a, type: router }]\nedges: [{ from: START, to: a }, { from: a, to: END }]\n",
      );
      const sub = { id: "child", type: "subgraph", uses: "./child.graph.yaml" };
      const compiled = await compileGraph(graph([sub]), { checkpointer: "memory", cwd: dir, nodePolicy: POLICY });
      expect(await runError(compiled.run({ threadId: "sub-file" }))).toMatch(/^SUBGRAPH_FILE_BLOCKED .*loads a graph file from the host/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses {{ secret.X }} in http templates", async () => {
    process.env["FG_POLICY_TEST_SECRET"] = "s3cret";
    try {
      const http = { id: "h", type: "http", with: { url: "http://127.0.0.1:9/?k={{ secret.FG_POLICY_TEST_SECRET }}", output: { to: "out" } } };
      const compiled = await compileGraph(graph([http]), { checkpointer: "memory", nodePolicy: POLICY });
      const text = await runError(compiled.run({ threadId: "secret" }));
      expect(text).toMatch(/secret\.FG_POLICY_TEST_SECRET reads the host environment/);
      expect(text).not.toContain("s3cret");
    } finally {
      delete process.env["FG_POLICY_TEST_SECRET"];
    }
  });

  it("refuses mcpServers and localTools, including in inline subgraphs", async () => {
    const policy: NodePolicy = { blockMcp: true, blockLocalTools: true };
    const router = { id: "h", type: "http", with: { url: "http://example.invalid/" } };
    const withMcp = { ...graph([router]), mcpServers: { gh: { transport: "stdio", command: "gh-mcp" } } } as GraphSpec;
    const withTools = { ...graph([router]), localTools: { fs: { workspaceRoot: "/" } } } as GraphSpec;
    await expectCode(compileGraph(withMcp, { checkpointer: "none", nodePolicy: policy }), "MCP_BLOCKED");
    await expectCode(compileGraph(withTools, { checkpointer: "none", nodePolicy: policy }), "LOCAL_TOOLS_BLOCKED");
    await expect(compileGraph(withMcp, { checkpointer: "none" })).resolves.toBeDefined();
    const compiled = await compileGraph(graph([{ id: "child", type: "subgraph", spec: withMcp }]), { checkpointer: "memory", nodePolicy: policy });
    expect(await runError(compiled.run({ threadId: "sub-mcp" }))).toMatch(/^MCP_BLOCKED /);
  });

  it("withholds the host's MCP hub when MCP is blocked", async () => {
    const calls: string[] = [];
    const hub = {
      listTools: async () => [],
      callTool: async (server: string, name: string) => {
        calls.push(`${server}.${name}`);
        return { ok: true };
      },
      readResource: async () => ({}),
      close: async () => undefined,
    };
    const node = { id: "m", type: "mcp", with: { server: "gh", tool: "whoami", output: { to: "out" } } };
    const open = await compileGraph(graph([node]), { checkpointer: "memory", mcp: hub });
    expect((await open.run({ threadId: "mcp-open" })).status).toBe("completed");
    const closed = await compileGraph(graph([node]), { checkpointer: "memory", mcp: hub, nodePolicy: { blockMcp: true } });
    expect(await runError(closed.run({ threadId: "mcp-closed" }))).toMatch(/MCP is not configured/);
    expect(calls).toEqual(["gh.whoami"]);
  });

  it("refuses requires binary checks, including on map inner nodes", async () => {
    const policy: NodePolicy = { blockHostProbes: true };
    const probe = { id: "sh", type: "shell", with: { command: "true", requires: [{ bin: "kubectl" }], onMissingTool: "skip", output: { to: "out" } } };
    await expectCode(compileGraph(graph([probe]), { checkpointer: "none", nodePolicy: policy }), "HOST_PROBE_BLOCKED");
    const map = {
      id: "m",
      type: "map",
      with: { over: "{{ state.items }}", as: "x", node: { type: "shell", with: { command: "true", requires: [{ bin: "aws" }] } }, collect: { to: "out" } },
    };
    await expectCode(compileGraph(graph([map]), { checkpointer: "none", nodePolicy: policy }), "HOST_PROBE_BLOCKED");
    await expect(compileGraph(graph([probe]), { checkpointer: "none" })).resolves.toBeDefined();
  });
});
