import { expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const bin = resolve(import.meta.dirname, "../dist/bin.js");
function fixture(name: string) {
  const dir = mkdtempSync(join(tmpdir(), name));
  return {
    dir,
    cli: (...args: string[]) =>
      spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: "utf8", timeout: 25000 }),
  };
}
async function killWhenReady(dir: string) {
  const child = spawn(process.execPath, [bin, "run", "flow.yaml", "--thread", "kill", "--json"], {
    cwd: dir,
    stdio: "ignore",
  });
  const closed = new Promise<void>((done, fail) => {
    child.once("close", () => done());
    child.once("error", fail);
  });
  try {
    const until = Date.now() + 15000;
    while (!existsSync(join(dir, "ready")) && Date.now() < until)
      await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(join(dir, "ready"))).toBe(true);
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
}
function graph(nodes: unknown[], edges: unknown[], imports: unknown[] = []) {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "crash" },
    imports,
    nodes,
    edges,
    runtime: { checkpoint: { backend: "sqlite", path: "cp.db" } },
  };
}
it("SIGKILL preserves completed model/tool steps and their charges across CLI processes", async () => {
  const { dir, cli } = fixture("fg-agent-kill-");
  try {
    const core = pathToFileURL(resolve(import.meta.dirname, "../../core/dist/index.js")).href;
    writeFileSync(
      join(dir, "provider.mjs"),
      `import {registerTool} from ${JSON.stringify(core)};import {appendFileSync,writeFileSync,existsSync} from 'node:fs';registerTool({name:'effect',handler:({i})=>{appendFileSync('effects',String(i)+'\\n');return 'done';}});export default [{name:'test',capabilities:{toolCalling:true,streaming:false,structuredOutput:false,callAccounting:true},async run(req,ctx){for(let i=0;i<3;i++){if(ctx.replay.get('llm:'+i)===undefined){const result=await ctx.meterCall(async()=>{appendFileSync('models','call\\n');if(i===2&&!existsSync('finish')){writeFileSync('ready','yes');await new Promise(()=>{});}return {totalTokens:3,costUSD:0.001};},{usage:v=>v});await ctx.replay.set('llm:'+i,result);}if(i<2)await ctx.invokeTool('effect',{i});}return {output:'done',stopReason:'done'};}}];`,
    );
    writeFileSync(
      join(dir, "flow.yaml"),
      JSON.stringify(
        graph(
          [
            {
              id: "a",
              type: "agent",
              provider: "test",
              with: { prompt: "test", tools: [{ function: "effect" }] },
            },
          ],
          [
            { from: "START", to: "a" },
            { from: "a", to: "END" },
          ],
          [{ providers: "./provider.mjs" }],
        ),
      ),
    );
    await killWhenReady(dir);
    const claim = JSON.parse(
      cli("thread", "inspect", "flow.yaml", "--thread", "kill").stdout,
    ).claim;
    expect(
      cli(
        "thread",
        "release",
        "flow.yaml",
        "--thread",
        "kill",
        "--token",
        claim.token,
        "--owner-stopped",
      ).status,
    ).toBe(0);
    const usage = JSON.parse(cli("usage", "inspect", "flow.yaml", "--thread", "kill").stdout).usage;
    expect(usage.totals).toMatchObject({ calls: 2, totalTokens: 6, costUSD: 0.002 });
    expect(
      cli(
        "usage",
        "resolve",
        "flow.yaml",
        "--thread",
        "kill",
        "--receipt",
        Object.keys(usage.pending)[0]!,
        "--not-billed",
        "--owner-stopped",
      ).status,
    ).toBe(0);
    writeFileSync(join(dir, "finish"), "yes");
    const resumed = cli("resume", "flow.yaml", "--thread", "kill", "--resume", "true", "--json");
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
    expect(readFileSync(join(dir, "effects"), "utf8")).toBe("0\n1\n");
    expect(readFileSync(join(dir, "models"), "utf8")).toBe("call\ncall\ncall\ncall\n");
    const end = resumed.stdout
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x))
      .find((x) => x.type === "run.end");
    expect(end.data.usage).toMatchObject({ totalTokens: 9, costUSD: 0.003 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
// Startup (15s) plus five CLI commands (25s each), with cleanup headroom.
}, 150_000);
it("SIGKILL orphan shell work cannot race a resumed invocation", async () => {
  const { dir, cli } = fixture("fg-shell-kill-");
  let orphan: number | undefined;
  try {
    const code =
      "require('fs').writeFileSync('orphan.pid',String(process.pid));require('fs').writeFileSync('ready','yes');setTimeout(()=>require('fs').appendFileSync('effects','effect\\n'),30000);";
    writeFileSync(
      join(dir, "flow.yaml"),
      JSON.stringify(
        graph(
          [{ id: "s", type: "shell", with: { command: process.execPath, args: ["-e", code] } }],
          [
            { from: "START", to: "s" },
            { from: "s", to: "END" },
          ],
        ),
      ),
    );
    await killWhenReady(dir);
    orphan = Number(readFileSync(join(dir, "orphan.pid"), "utf8"));
    const claim = JSON.parse(
      cli("thread", "inspect", "flow.yaml", "--thread", "kill").stdout,
    ).claim;
    expect(
      cli(
        "thread",
        "release",
        "flow.yaml",
        "--thread",
        "kill",
        "--token",
        claim.token,
        "--owner-stopped",
      ).status,
    ).toBe(0);
    const blocked = cli("resume", "flow.yaml", "--thread", "kill", "--resume", "true", "--json");
    expect(blocked.status).toBe(1);
    expect(blocked.stdout + blocked.stderr).toContain("uncertain outcome");
    expect(existsSync(join(dir, "effects"))).toBe(false);
    try {
      process.kill(-orphan, "SIGKILL");
    } catch {}
    try {
      process.kill(orphan, "SIGKILL");
    } catch {}
    orphan = undefined;
    const rows = JSON.parse(cli("replay", "inspect", "flow.yaml", "--thread", "kill").stdout),
      row = rows.find((r: { entries: Record<string, unknown> }) =>
        Object.keys(r.entries).some((k) => k.startsWith("shell:")),
      ),
      slot = Object.keys(row.entries).find((k) => k.startsWith("shell:"))!;
    const args = [
      "replay",
      "resolve",
      "flow.yaml",
      "--thread",
      "kill",
      "--task",
      row.task,
      "--slot",
      slot,
      "--receipt",
      row.entries[slot].id,
      "--result",
      JSON.stringify({ stdout: "recovered", stderr: "", exitCode: 0 }),
    ];
    expect(cli(...args).status).toBe(1);
    expect(cli(...args, "--owner-stopped").status).toBe(0);
    expect(cli(...args, "--owner-stopped").status).toBe(1);
    const result = cli("resume", "flow.yaml", "--thread", "kill", "--resume", "true", "--json");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(existsSync(join(dir, "effects"))).toBe(false);
  } finally {
    if (orphan) {
      try {
        process.kill(-orphan, "SIGKILL");
      } catch {}
      try {
        process.kill(orphan, "SIGKILL");
      } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  }
// Startup (15s) plus eight CLI commands (25s each), with cleanup headroom.
}, 230_000);
