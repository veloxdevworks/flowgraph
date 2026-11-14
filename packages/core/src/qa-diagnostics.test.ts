import { afterEach, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphSpecSchema } from "@flowgraph/spec";
import { MemorySaver } from "@langchain/langgraph";
import { compileGraph } from "./compiler.js";
import { createScriptedProvider } from "./providers/index.js";
import { channelReducerAndDefault } from "./runtime/state-annotation.js";
import { registry } from "./registry.js";
import { loadAgentDef } from "./agents/loader.js";
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const graph = (nodes: unknown[]) =>
  GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "diagnostics" },
    nodes,
    edges: [
      { from: "START", to: (nodes[0] as { id: string }).id },
      { from: (nodes[0] as { id: string }).id, to: "END" },
    ],
  });
it("names a failing shell node and retains stderr's useful tail", async () => {
  const g = await compileGraph(
    graph([
      {
        id: "verify-build",
        type: "shell",
        with: {
          command: process.execPath,
          args: [
            "-e",
            "process.stderr.write('x'.repeat(700)+'USEFUL_FAILURE_TAIL');process.exit(2)",
          ],
        },
      },
    ]),
  );
  const result = await g.run();
  expect(result.error?.message).toContain("verify-build");
  expect(result.error?.message).toContain("USEFUL_FAILURE_TAIL");
});
it("attributes custom reducer errors to their channel", () => {
  registry.registerReducer("explode-diagnostics", () => {
    throw new Error("invalid transition");
  });
  const { reducer } = channelReducerAndDefault("orders", {
    type: "object",
    reducer: "custom:explode-diagnostics",
  });
  expect(() => reducer({}, {})).toThrow(/orders.*invalid transition/);
});
it.each(["---\nname: 42\n---\nbody", "---\nname: [broken\n---\nbody"])(
  "attributes malformed agent front matter to AGENT.md",
  async (raw) => {
    const dir = await mkdtemp(join(tmpdir(), "fg-agent-diag-"));
    dirs.push(dir);
    const file = join(dir, "AGENT.md");
    await writeFile(file, raw);
    const loaded = await loadAgentDef(dir);
    expect(loaded.agent).toBeNull();
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ file }));
  },
);
it("public interrupt events/results omit replay state while durable resume still works", async () => {
  const provider = createScriptedProvider("diag", async (_req, ctx) => {
    await ctx.replay?.set("llm:0", { privateReplayMarker: "hidden" });
    return {
      output: ctx.node.interrupt({ reason: "question", kind: "question" }),
      stopReason: "done",
    };
  });
  const g = await compileGraph(
    graph([{ id: "agent", type: "agent", provider: "diag", with: { prompt: "ask" } }]),
    { providers: [provider], checkpointer: new MemorySaver() },
  );
  const events: unknown[] = [];
  g.events.subscribe((e) => {
    if (e.type === "interrupt.raised") events.push(e.data);
  });
  const first = await g.run({ threadId: "public" });
  expect(first.status).toBe("interrupted");
  expect(JSON.stringify(events)).not.toContain("__agentReplay");
  expect(JSON.stringify(first.interrupts)).not.toContain("__agentReplay");
  expect((await g.resume({ threadId: "public", resume: "answer" })).status).toBe("completed");
});
