import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { openSqliteBackend } from "@flowgraph/checkpoint-sqlite";
import type { UsageCheckpointStore } from "@flowgraph/core";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe("durable CLI usage and JSONL", () => {
  it("keeps budget spend across three processes, emits pure JSONL and reports failed-run totals", () => {
    const dir = mkdtempSync(join(tmpdir(), "fg-usage-cli-")); dirs.push(dir);
    writeFileSync(join(dir, "provider.mjs"), `
      import { appendFileSync } from 'node:fs';
      export default [{ name: 'usage-qa', capabilities: { toolCalling: true, structuredOutput: false, streaming: false }, async run(req, ctx) {
        ctx.node.logger.debug('metered provider debug');
        appendFileSync(${JSON.stringify(join(dir, "calls"))}, 'paid\\n');
        const usage = { totalTokens: 7, costUSD: 0.002 };
        ctx.emit('usage', usage);
        return { output: 'done', usage, stopReason: 'done' };
      } }];
    `);
    writeFileSync(join(dir, "flow.yaml"), JSON.stringify({ apiVersion: "flowgraph/v1", kind: "Graph", metadata: { name: "usage-cli" }, imports: [{ providers: "./provider.mjs" }], nodes: [{ id: "a", type: "agent", provider: "usage-qa", with: { prompt: "answer" } }, { id: "gate", type: "hitl", with: { mode: "approve", message: "yes?" } }, { id: "b", type: "agent", provider: "usage-qa", with: { prompt: "answer" } }], edges: [{ from: "START", to: "a" }, { from: "a", to: "gate" }, { from: "gate", to: "b" }, { from: "b", to: "END" }], runtime: { checkpoint: { backend: "sqlite", path: "cp.db" }, budget: { maxUSD: 0.003, onExceed: "fail" } } }));
    const run = (mode: string) => spawnSync(process.execPath, [resolve(import.meta.dirname, "../dist/bin.js"), mode, "flow.yaml", "--thread", "usage-thread", "--json", ...(mode === "resume" ? ["--resume", "true"] : [])], { cwd: dir, encoding: "utf8", timeout: 25_000, env: { ...process.env, FLOWGRAPH_LOG_LEVEL: "debug" } });
    const first = run("run"), second = run("resume"), third = run("resume");
    expect(first.status, first.stdout + first.stderr).toBe(3);
    expect(second.status, second.stdout + second.stderr).toBe(1);
    expect(third.status, third.stdout + third.stderr).toBe(1);
    for (const result of [first, second, third]) expect(() => result.stdout.trim().split("\n").map(line => JSON.parse(line))).not.toThrow();
    const events = second.stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(events.filter(event => event.type === "agent.usage")).toHaveLength(1);
    expect(events.find(event => event.type === "run.error")?.data.usage).toMatchObject({ totalTokens: 14, costUSD: 0.004 });
    expect(second.stderr).toContain("Thread: usage-thread"); expect(second.stderr).toContain("usd=0.004");
    expect(first.stderr).toContain("metered provider debug");
    expect(readFileSync(join(dir, "calls"), "utf8")).toBe("paid\npaid\n");
  }, 85_000);
});


it("retains completed usage and an unresolved receipt when a paid-call process is killed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fg-usage-crash-")); dirs.push(dir);
  const ready = join(dir, "ready");
  writeFileSync(join(dir, "provider.mjs"), `
    import { writeFileSync } from 'node:fs';
    export default [{ name: 'usage-qa', capabilities: { toolCalling: true, structuredOutput: false, streaming: false, callAccounting: true }, async run(req, ctx) {
      await ctx.meterCall(async () => ({ totalTokens: 7, costUSD: 0.002 }), { usage: value => value });
      await ctx.meterCall(async () => {
        writeFileSync(${JSON.stringify(ready)}, 'in-flight');
        await new Promise((_, reject) => setTimeout(() => reject(new Error('fixture timeout')), 30000));
        return {};
      }, { usage: () => undefined });
      return { output: 'done', stopReason: 'done' };
    } }];
  `);
  writeFileSync(join(dir, "flow.yaml"), JSON.stringify({ apiVersion: "flowgraph/v1", kind: "Graph", metadata: { name: "usage-crash" }, imports: [{ providers: "./provider.mjs" }], nodes: [{ id: "a", type: "agent", provider: "usage-qa", with: { prompt: "answer" } }], edges: [{ from: "START", to: "a" }, { from: "a", to: "END" }], runtime: { checkpoint: { backend: "sqlite", path: "cp.db" } } }));
  const child = spawn(process.execPath, [resolve(import.meta.dirname, "../dist/bin.js"), "run", "flow.yaml", "--thread", "crash", "--json"], { cwd: dir, stdio: "ignore" });
  const exited = new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
  try {
    const until = Date.now() + 20_000;
    while (!existsSync(ready) && Date.now() < until) await new Promise(r => setTimeout(r, 20));
    expect(existsSync(ready)).toBe(true);
  } finally { child.kill("SIGKILL"); await exited; }
  const backend = await openSqliteBackend(join(dir, "cp.db"));
  try {
    const record = await (backend.checkpointer as unknown as UsageCheckpointStore).readThreadUsage("crash");
    expect(record?.totals).toMatchObject({ calls: 1, totalTokens: 7, costUSD: 0.002 });
    expect(Object.keys(record?.pending ?? {})).toHaveLength(1);
    expect(backend.db.prepare("SELECT COUNT(*) AS n FROM fg_thread_run_claims WHERE thread_id='crash'").get()).toEqual({ n: 1 });
  } finally { backend.close(); }
  const cli = (...args: string[]) => spawnSync(process.execPath, [resolve(import.meta.dirname, "../dist/bin.js"), ...args], { cwd: dir, encoding: "utf8", timeout: 25_000 });
  const inspected = JSON.parse(cli("thread", "inspect", "flow.yaml", "--thread", "crash").stdout).claim;
  expect(cli("thread", "release", "flow.yaml", "--thread", "crash", "--token", inspected.token, "--owner-stopped").status).toBe(0);
  const usage = JSON.parse(cli("usage", "inspect", "flow.yaml", "--thread", "crash").stdout).usage;
  const receipt = Object.keys(usage.pending)[0]!;
  const resolved = cli("usage", "resolve", "flow.yaml", "--thread", "crash", "--receipt", receipt, "--not-billed", "--owner-stopped");
  expect(resolved.status, resolved.stderr).toBe(0);
  expect(JSON.parse(resolved.stdout).usage.totals).toMatchObject({ calls: 2, totalTokens: 7, costUSD: 0.002, unknownCalls: 0 });
  expect(JSON.parse(resolved.stdout).usage.pending).toEqual({});

}, 30_000);

it("reconciles an ambiguous receipt through the CLI and resumes under the original hard cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "fg-usage-resolve-")); dirs.push(dir);
  writeFileSync(join(dir, "provider.mjs"), `
    import { existsSync, writeFileSync } from 'node:fs';
    export default [{ name:'usage-qa', capabilities:{toolCalling:true,structuredOutput:false,streaming:false,callAccounting:true}, async run(req,ctx) {
      const usage = await ctx.meterCall(async () => {
        if (!existsSync('attempted')) { writeFileSync('attempted','yes'); throw Object.assign(new Error('connection reset'),{code:'ECONNRESET'}); }
        return {totalTokens:7,costUSD:0.002};
      }, {usage:value=>value});
      return {output:'done',usage,stopReason:'done'};
    }}];
  `);
  writeFileSync(join(dir, "flow.yaml"), JSON.stringify({ apiVersion:"flowgraph/v1",kind:"Graph",metadata:{name:"usage-resolve"},imports:[{providers:"./provider.mjs"}],nodes:[{id:"a",type:"agent",provider:"usage-qa",with:{prompt:"answer"}}],edges:[{from:"START",to:"a"},{from:"a",to:"END"}],runtime:{checkpoint:{backend:"sqlite",path:"cp.db"},budget:{maxTokens:10,onExceed:"fail"}} }));
  const cli = (...args: string[]) => spawnSync(process.execPath, [resolve(import.meta.dirname, "../dist/bin.js"), ...args], {cwd:dir,encoding:"utf8",timeout:25_000});
  expect(cli("run","flow.yaml","--thread","resolve","--json").status).toBe(1);
  const blocked = cli("resume","flow.yaml","--thread","resolve","--resume","true","--json");
  expect(blocked.status).toBe(1); expect(blocked.stdout+blocked.stderr).toContain("USAGE_UNRESOLVED");
  const inspected = cli("usage","inspect","--backend","sqlite","--path",join(dir,"cp.db"),"--thread","resolve");
  expect(inspected.status,inspected.stderr).toBe(0);
  const receipt = Object.keys(JSON.parse(inspected.stdout).usage.unresolved)[0]!;
  const args = ["usage","resolve","flow.yaml","--thread","resolve","--receipt",receipt,"--tokens","3","--cost-usd","0.002"];
  expect(cli(...args).status).toBe(1);
  const resolved = cli(...args,"--owner-stopped"); expect(resolved.status,resolved.stderr).toBe(0);
  expect(JSON.parse(resolved.stdout).usage.totals).toMatchObject({totalTokens:3,costUSD:0.002,unknownCalls:0});
  expect(cli(...args,"--owner-stopped").status).toBe(1);
  const resumed = cli("resume","flow.yaml","--thread","resolve","--resume","true","--json");
  expect(resumed.status,resumed.stdout+resumed.stderr).toBe(0);
  const end = resumed.stdout.trim().split("\n").map(line=>JSON.parse(line)).find(event=>event.type==="run.end");
  expect(end.data.usage).toMatchObject({totalTokens:10,costUSD:0.004,calls:2,unknownCalls:0,pendingCalls:0});
},85_000);
