import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { compileGraph, type GraphSpec } from "@flowgraph/core";
import { openPostgresBackend, type PostgresBackend } from "./index.js";

const DB = process.env["FLOWGRAPH_TEST_POSTGRES_URL"];

const open: PostgresBackend[] = [];
const schemas: string[] = [];
afterEach(async () => {
  const pending = schemas.splice(0);
  for (const backend of open.splice(0)) await backend.close();
  if (!DB) return;
  const pool = new pg.Pool({ connectionString: DB });
  try {
    for (const schema of pending) {
      if (/^fg_falsy_[a-z0-9]+$/.test(schema)) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  } finally {
    await pool.end();
  }
});

async function backend(): Promise<PostgresBackend> {
  const schema = `fg_falsy_${Math.random().toString(36).slice(2, 10)}`;
  schemas.push(schema);
  const b = await openPostgresBackend({ connectionString: DB!, schema });
  open.push(b);
  return b;
}

function gate(withConfig: Record<string, unknown>): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "pg-falsy-resume" },
    state: { channels: { answer: { type: "object" } } },
    nodes: [{ id: "gate", type: "hitl", with: { message: "?", output: { to: "answer" }, ...withConfig } }],
    edges: [
      { from: "START", to: "gate" },
      { from: "gate", to: "END" },
    ],
  } as unknown as GraphSpec;
}

describe.skipIf(!DB)("postgres external resume with a falsy answer", () => {
  it("records a denied approval", async () => {
    const compiled = await compileGraph(gate({ mode: "approve" }), { checkpointer: (await backend()).checkpointer });
    for (const [i, answer] of [false, null, undefined, 0, ""].entries()) {
      const threadId = `deny-${i}`;
      expect((await compiled.run({ threadId, onInterrupt: "fail" })).status).toBe("interrupted");
      const r = await compiled.resume({ threadId, resume: answer, onInterrupt: "fail" });
      expect(r.status).toBe("completed");
      expect(r.state["answer"]).toEqual({ approved: false });
    }
  });

  it("re-prompts a falsy choice and accepts a valid one next", async () => {
    const compiled = await compileGraph(gate({ mode: "choice", choices: ["a", "b"] }), {
      checkpointer: (await backend()).checkpointer,
    });
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
