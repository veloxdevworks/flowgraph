import { expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { GraphSpecSchema } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
it("PLAT-360: persists a fork's workspace across gates and recompilation", async () => {
  const source = await mkdtemp(join(tmpdir(), "fg-replay-workspace-")),
    fork = join(source, "fork");
  const saver = new MemorySaver();
  const spec = GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "workspace-fork" },
    state: { channels: { answer: { type: "object" } } },
    nodes: [
      {
        id: "prep",
        type: "shell",
        with: {
          command: process.execPath,
          args: ["-e", "require('fs').appendFileSync('effects.txt','prep\\n')"],
        },
      },
      {
        id: "gate",
        type: "hitl",
        with: { mode: "approve", message: "Approve", output: { to: "answer" } },
      },
      {
        id: "effect",
        type: "shell",
        with: {
          command: process.execPath,
          args: [
            "-e",
            "require('fs').appendFileSync('effects.txt',process.argv[1]+'\\n')",
            "{{ state.answer.approved }}",
          ],
        },
      },
    ],
    edges: [
      { from: "START", to: "prep" },
      { from: "prep", to: "gate" },
      { from: "gate", to: "effect" },
      { from: "effect", to: "END" },
    ],
  });
  try {
    let graph = await compileGraph(spec, { cwd: source, checkpointer: saver });
    await graph.run({ threadId: "fork" });
    await graph.resume({ threadId: "fork", resume: false });
    const before = await readFile(join(source, "effects.txt"), "utf8");
    const checkpointId = (await graph.getStateHistory("fork")).find((s) =>
      s.next.includes("prep"),
    )!.checkpointId!;
    const replay = await graph.resumeFrom({
      threadId: "fork",
      checkpointId,
      replayWorkspace: fork,
      resume: true,
    });
    expect(replay.status).toBe("interrupted");
    graph = await compileGraph(spec, { cwd: source, checkpointer: saver });
    expect((await graph.resume({ threadId: "fork", resume: true })).status).toBe("completed");
    expect(await readFile(join(source, "effects.txt"), "utf8")).toBe(before);
    expect(await readFile(join(fork, "effects.txt"), "utf8")).toBe("prep\ntrue\n");
    expect((await graph.getState("fork", { applyWaitTimeouts: false }))?.values).not.toHaveProperty(
      "__replayWorkspace",
    );
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});
