import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compileGraph, type GraphSpec } from "@flowgraph/core";
import { openSqliteBackend, type SqliteBackend } from "./index.js";

const tmpFiles: string[] = [];
const backends: SqliteBackend[] = [];
afterEach(() => {
  for (const backend of backends.splice(0)) backend.close();
  for (const file of tmpFiles.splice(0)) fs.rmSync(file, { force: true });
});

async function saver(): Promise<SqliteBackend["checkpointer"]> {
  const file = path.join(os.tmpdir(), `fg-falsy-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  tmpFiles.push(file);
  const backend = await openSqliteBackend({ path: file });
  backends.push(backend);
  return backend.checkpointer;
}

function gate(withConfig: Record<string, unknown>): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "sqlite-falsy-resume" },
    state: { channels: { answer: { type: "object" } } },
    nodes: [{ id: "gate", type: "hitl", with: { message: "?", output: { to: "answer" }, ...withConfig } }],
    edges: [
      { from: "START", to: "gate" },
      { from: "gate", to: "END" },
    ],
  } as unknown as GraphSpec;
}

describe("sqlite external resume with a falsy answer", () => {
  it("records a denied approval", async () => {
    const compiled = await compileGraph(gate({ mode: "approve" }), { checkpointer: await saver() });
    for (const [i, answer] of [false, null, 0, ""].entries()) {
      const threadId = `deny-${i}`;
      expect((await compiled.run({ threadId, onInterrupt: "fail" })).status).toBe("interrupted");
      const r = await compiled.resume({ threadId, resume: answer, onInterrupt: "fail" });
      expect(r.status).toBe("completed");
      expect(r.state["answer"]).toEqual({ approved: false });
    }
  });

  it("re-prompts a falsy choice and accepts a valid one next", async () => {
    const compiled = await compileGraph(gate({ mode: "choice", choices: ["a", "b"] }), { checkpointer: await saver() });
    for (const [i, answer] of [false, null, 0, ""].entries()) {
      const threadId = `choice-${i}`;
      await compiled.run({ threadId, onInterrupt: "fail" });
      const r1 = await compiled.resume({ threadId, resume: answer, onInterrupt: "fail" });
      expect(r1.status).toBe("interrupted");
      expect(r1.interrupts?.[0]?.validationError).toContain("Invalid choice");
      const r2 = await compiled.resume({ threadId, resume: 2, onInterrupt: "fail" });
      expect(r2.status).toBe("completed");
      expect(r2.state["answer"]).toEqual({ choice: "b" });
    }
  });
});
