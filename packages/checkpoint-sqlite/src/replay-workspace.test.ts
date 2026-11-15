import { expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileGraph, type GraphSpec } from "@flowgraph/core";
import { openSqliteBackend } from "./index.js";
it("PLAT-360: keeps the replay workspace after SQLite is closed and reopened", async () => {
  const source = await mkdtemp(join(tmpdir(), "fg-fork-durable-")),
    fork = join(source, "fork");
  let backend = await openSqliteBackend({ path: join(source, "state.db"), retention: false });
  const spec = {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "durable-fork" },
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
  } as unknown as GraphSpec;
  try {
    let graph = await compileGraph(spec, { cwd: source, checkpointer: backend.checkpointer });
    await graph.run({ threadId: "fork" });
    await graph.resume({ threadId: "fork", resume: false });
    const checkpointId = (await graph.getStateHistory("fork")).find((s) =>
      s.next.includes("prep"),
    )!.checkpointId!;
    expect(
      (
        await graph.resumeFrom({
          threadId: "fork",
          checkpointId,
          replayWorkspace: fork,
          resume: true,
        })
      ).status,
    ).toBe("interrupted");
    backend.close();
    backend = await openSqliteBackend({ path: join(source, "state.db"), retention: false });
    graph = await compileGraph(spec, { cwd: source, checkpointer: backend.checkpointer });
    expect((await graph.resume({ threadId: "fork", resume: true })).status).toBe("completed");
    expect(await readFile(join(source, "effects.txt"), "utf8")).toBe("prep\nfalse\n");
    expect(await readFile(join(fork, "effects.txt"), "utf8")).toBe("prep\ntrue\n");
  } finally {
    backend.close();
    await rm(source, { recursive: true, force: true });
  }
});
