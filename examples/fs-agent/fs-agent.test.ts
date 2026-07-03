import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { loadGraph, compileGraph, createScriptedProvider } from "@veloxdevworks/flowgraph-core";
import { registerFsTools } from "@veloxdevworks/flowgraph-tools-fs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const graphPath = path.join(__dirname, "fs-agent.graph.yaml");
const workspaceDir = path.join(__dirname, "workspace");
const haikuPath = path.join(workspaceDir, "haiku.md");

const mainProvider = createScriptedProvider("main", async (req, ctx) => {
  await ctx.invokeTool("fs_write", {
    path: "haiku.md",
    content: "graphs flow\nlines connect\nyaml runs",
  });
  return {
    output: { text: "Wrote haiku.md" },
    stopReason: "done",
    usage: { totalTokens: 10 },
  };
});

beforeAll(async () => {
  await fs.mkdir(workspaceDir, { recursive: true });
  try {
    await fs.unlink(haikuPath);
  } catch {
    /* fresh */
  }
  registerFsTools({ workspaceRoot: workspaceDir, operations: ["read", "list", "write"] });
});

afterAll(async () => {
  try {
    await fs.unlink(haikuPath);
  } catch {
    /* ok */
  }
});

describe("fs-agent example", () => {
  it("raises an interrupt for fs_write when policy is fail", async () => {
    const { spec } = await loadGraph(graphPath, { cwd: __dirname });
    if (!spec) throw new Error("failed to load fs-agent graph");

    const graph = await compileGraph(spec, {
      cwd: __dirname,
      checkpointer: "memory",
      providers: [mainProvider],
    });

    const blocked = await graph.run({ threadId: "fs-ex-0", onInterrupt: "fail" });
    expect(blocked.status).toBe("interrupted");
    expect(blocked.interrupts?.[0]?.reason).toContain("Approve filesystem write");
  });

  it("gates fs_write with a hook interrupt and completes on approve", async () => {
    const { spec } = await loadGraph(graphPath, { cwd: __dirname });
    if (!spec) throw new Error("failed to load fs-agent graph");

    const graph = await compileGraph(spec, {
      cwd: __dirname,
      checkpointer: "memory",
      providers: [mainProvider],
    });

    const result = await graph.run({
      threadId: "fs-ex-1",
      onInterrupt: "approve",
    });

    expect(result.status).toBe("completed");
    const content = await fs.readFile(haikuPath, "utf8");
    expect(content).toContain("graphs flow");
    expect(result.state["result"]).toBeTruthy();
  });
});
