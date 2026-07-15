import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compileGraph, registerFunction, type GraphSpec } from "@veloxdevworks/flowgraph-core";
import { createSqliteCheckpointer } from "./index.js";

registerFunction("publish", () => true);

const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  tmpFiles.length = 0;
});

function tmpDb(): string {
  const p = path.join(os.tmpdir(), `flowgraph-ck-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  tmpFiles.push(p);
  return p;
}

const spec = {
  metadata: { name: "approval-flow" },
  state: { channels: { approved: { type: "boolean" }, published: { type: "boolean" } } },
  nodes: [
    { id: "gate", type: "wait", with: { signal: "approval" } },
    { id: "publish", type: "function", with: { fn: "publish", output: { to: "published" } } },
  ],
  edges: [
    { from: "START", to: "gate" },
    { from: "gate", to: "publish" },
    { from: "publish", to: "END" },
  ],
} as unknown as GraphSpec;

describe("@veloxdevworks/flowgraph-checkpoint-sqlite durability", () => {
  it("persists an interrupt and resumes from a fresh compile (new process simulation)", async () => {
    const dbPath = tmpDb();
    const threadId = "release-1";

    // First "process": start and hit the interrupt.
    {
      const compiled = await compileGraph(spec, {
        checkpointer: createSqliteCheckpointer(dbPath),
      });
      const r = await compiled.run({ threadId, onInterrupt: "fail" });
      expect(r.status).toBe("interrupted");
      expect(r.interrupts?.[0]?.reason).toContain("approval");
    }

    // Second "process": brand-new compile, same db + threadId, then resume.
    {
      const compiled = await compileGraph(spec, {
        checkpointer: createSqliteCheckpointer(dbPath),
      });
      const snap = await compiled.getState(threadId);
      expect(snap?.next).toContain("gate");

      const r = await compiled.resume({ threadId, resume: { approved: true } });
      expect(r.status).toBe("completed");
      expect(r.state["published"]).toBe(true);
    }
  });
});
