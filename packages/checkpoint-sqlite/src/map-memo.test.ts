import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileGraph, registerFunction, type GraphSpec } from "@flowgraph/core";
import { openSqliteBackend } from "./index.js";

it("reuses completed map items after closing and reopening SQLite at a loop gate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fg-map-memo-"));
  let backend = await openSqliteBackend({ path: join(dir, "state.db") });
  let calls = 0;
  registerFunction("durableMemo", (i) => {
    calls++;
    return (i as { n: number }).n * 2;
  });
  const spec = {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "durable-memo" },
    state: {
      channels: {
        items: { type: "array" },
        results: { type: "array" },
        answer: { type: "object" },
      },
    },
    nodes: [
      {
        id: "fan",
        type: "map",
        with: {
          memoize: true,
          over: "{{ state.items }}",
          as: "n",
          node: { type: "function", with: { fn: "durableMemo" }, input: { n: "{{ n }}" } },
          collect: { to: "results" },
        },
      },
      {
        id: "gate",
        type: "hitl",
        with: { mode: "approve", message: "Again?", output: { to: "answer" } },
      },
      {
        id: "route",
        type: "router",
        with: {
          routes: [ { name: "again", when: "{{ state.answer.approved }}", to: "fan" }, { name: "done", default: true, to: "END" } ],
        },
      },
    ],
    edges: [
      { from: "START", to: "fan" },
      { from: "fan", to: "gate" },
      { from: "gate", to: "route" },
    ],
  } as unknown as GraphSpec;
  try {
    expect(
      (
        await (
          await compileGraph(spec, { checkpointer: backend.checkpointer })
        ).run({ threadId: "memo", input: { items: [1, 2] }, onInterrupt: "fail" })
      ).status,
    ).toBe("interrupted");
    expect(calls).toBe(2);
    backend.close();
    backend = await openSqliteBackend({ path: join(dir, "state.db") });
    const graph = await compileGraph(spec, { checkpointer: backend.checkpointer });
    expect(
      (await graph.resume({ threadId: "memo", resume: true, onInterrupt: "fail" })).status,
    ).toBe("interrupted");
    expect(calls).toBe(2);
    const result = await graph.resume({ threadId: "memo", resume: false, onInterrupt: "fail" });
    expect(result.status).toBe("completed");
    expect(result.state.results).toEqual([2, 4]);
    expect(result.state).not.toHaveProperty("__mapMemo");
  } finally {
    backend.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
