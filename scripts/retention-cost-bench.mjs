/** Build first, then run: node scripts/retention-cost-bench.mjs [steps=800]. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileGraph, registerFunction } from "../packages/core/dist/index.js";
import { createSqliteCheckpointer } from "../packages/checkpoint-sqlite/dist/index.js";

const steps = Number(process.argv[2] ?? 800);
if (!Number.isInteger(steps) || steps < 1) throw new Error("steps must be a positive integer");
registerFunction("retentionBench", ({ n, log }) => ({ n: n + 1, log: log + "x".repeat(1024) }));
for (const [mode, retention] of [["off", false], ["default", undefined], ["400", { maxCheckpoints: 400 }]]) {
  const dir = mkdtempSync(join(tmpdir(), "fg-retention-bench-"));
  const saver = createSqliteCheckpointer({ path: join(dir, "cp.db"), ...(retention === undefined ? {} : { retention }) });
  try {
    const graph = await compileGraph({
      metadata: { name: "retention-bench" },
      runtime: { recursionLimit: steps + 10 },
      state: { channels: { n: { type: "number", default: 0 }, log: { type: "string", default: "" } } },
      nodes: [{ id: "bump", type: "function", with: {
        fn: "retentionBench", input: { n: "{{ state.n }}", log: "{{ state.log }}" },
        output: { map: { n: "{{ result.n }}", log: "{{ result.log }}" } },
      } }],
      edges: [{ from: "START", to: "bump" }, { from: "bump", branch: [
        { when: `{{ state.n < ${steps} }}`, to: "bump" }, { default: true, to: "END" },
      ] }],
    }, { checkpointer: saver });
    const started = performance.now();
    const result = await graph.run({ threadId: mode });
    if (result.status !== "completed" || result.state.n !== steps) throw result.error ?? new Error("benchmark did not finish");
    console.log(JSON.stringify({ mode, steps, seconds: (performance.now() - started) / 1000 }));
  } finally {
    saver.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
