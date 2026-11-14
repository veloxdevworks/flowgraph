import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { compileGraph, createScriptedProvider, type GraphSpec, type UsageCheckpointStore } from "@flowgraph/core";
import { openPostgresBackend, type PostgresBackend } from "./index.js";

const DB = process.env["FLOWGRAPH_TEST_POSTGRES_URL"];
const opened: PostgresBackend[] = [], schemas: string[] = [];
afterEach(async () => {
  for (const backend of opened.splice(0)) await backend.close();
  if (DB) { const pool = new pg.Pool({ connectionString: DB }); try { for (const schema of schemas.splice(0)) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await pool.end(); } }
});
describe.skipIf(!DB)("durable PostgreSQL usage", () => {
  it("retains cost across hosts and prevents another paid retry after the full-run cap", async () => {
    const schema = `fg_usage_${randomUUID().replaceAll("-", "")}`; schemas.push(schema);
    const open = async () => { const backend = await openPostgresBackend({ connectionString: DB!, schema, poolConfig: { max: 1 }, retention: false }); opened.push(backend); return backend; };
    let calls = 0;
    const provider = createScriptedProvider("usage-qa", () => { calls++; return { output: "done", stopReason: "done", usage: { totalTokens: 7, costUSD: 0.002 } }; });
    const spec = { metadata: { name: "usage" }, nodes: [{ id: "a", type: "agent", provider: "usage-qa", with: { prompt: "answer" } }, { id: "gate", type: "hitl", with: { mode: "approve", message: "yes?" } }, { id: "b", type: "agent", provider: "usage-qa", with: { prompt: "answer" } }], edges: [{ from: "START", to: "a" }, { from: "a", to: "gate" }, { from: "gate", to: "b" }, { from: "b", to: "END" }], runtime: { budget: { maxUSD: 0.003, onExceed: "fail" } } } as unknown as GraphSpec;
    const first = await open();
    expect((await (await compileGraph(spec, { checkpointer: first.checkpointer, providers: [provider] })).run({ threadId: "t" })).status).toBe("interrupted");
    await first.close();
    const second = await open();
    expect(await (await compileGraph(spec, { checkpointer: second.checkpointer, providers: [provider] })).resume({ threadId: "t", resume: true })).toMatchObject({ status: "error", usage: { totalTokens: 14, costUSD: 0.004 } });
    const third = await open();
    expect((await (await compileGraph(spec, { checkpointer: third.checkpointer, providers: [provider] })).resume({ threadId: "t", resume: true })).status).toBe("error");
    expect(calls).toBe(2);
    expect((await (third.checkpointer as unknown as UsageCheckpointStore).readThreadUsage("t"))?.totals).toMatchObject({ totalTokens: 14, costUSD: 0.004 });
  });
});
