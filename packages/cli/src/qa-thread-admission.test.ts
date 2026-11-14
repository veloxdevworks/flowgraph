import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync as requireSpawnSync, type ChildProcess } from "node:child_process";
import { openSqliteBackend } from "@flowgraph/checkpoint-sqlite";

const dirs: string[] = [], children = new Set<ChildProcess>();
afterEach(() => { for (const child of children) child.kill(); children.clear(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(gate = false) {
  const dir = mkdtempSync(join(tmpdir(), "fg-qa-admission-")); dirs.push(dir);
  const effect = join(dir, "effects"), ready = join(dir, "ready"), release = join(dir, "release");
  const core = pathToFileURL(resolve(import.meta.dirname, "../../core/dist/index.js")).href;
  writeFileSync(join(dir, "register.mjs"), `
    import { registerFunction } from ${JSON.stringify(core)};
    import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
    registerFunction('qaThreadWork', async () => {
      if (!existsSync(${JSON.stringify(ready)})) {
        writeFileSync(${JSON.stringify(ready)}, 'ready');
        const until = Date.now() + 30000;
        while (!existsSync(${JSON.stringify(release)})) {
          if (Date.now() > until) throw new Error('fixture release timed out');
          await new Promise(r => setTimeout(r, 20));
        }
      }
      appendFileSync(${JSON.stringify(effect)}, 'ran\\n');
      return 'done';
    }); export default [];
  `);
  writeFileSync(join(dir, "flow.yaml"), JSON.stringify({
    apiVersion: "flowgraph/v1", kind: "Graph", metadata: { name: "admission" }, imports: [{ nodes: "./register.mjs" }],
    nodes: [...(gate ? [{ id: "gate", type: "hitl", with: { mode: "approve", message: "approve?" } }] : []), { id: "work", type: "function", with: { fn: "qaThreadWork" } }],
    edges: [{ from: "START", to: gate ? "gate" : "work" }, ...(gate ? [{ from: "gate", to: "work" }] : []), { from: "work", to: "END" }],
    runtime: { checkpoint: { backend: "sqlite", path: "checkpoints.sqlite" } },
  }));
  const launch = (mode: string) => {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, "../dist/bin.js"), mode, "flow.yaml", "--thread", "same", ...(mode === "resume" ? ["--resume", "true"] : []), "--json"], { cwd: dir });
    children.add(child); let output = "";
    child.stdout!.on("data", data => { output += data; }); child.stderr!.on("data", data => { output += data; });
    const timer = setTimeout(() => child.kill(), 40_000);
    const done = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      child.once("error", reject); child.once("close", code => { clearTimeout(timer); children.delete(child); resolve({ code, output }); });
    });
    return { child, done };
  };
  const run = (mode: string) => launch(mode).done;
  return { effect, ready, release, run, launch, dir, db: join(dir, "checkpoints.sqlite") };
}

describe("thread admission across CLI processes", () => {
  it.each([false, true])("excludes six competing processes (resume=%s)", async gate => {
    const f = fixture(gate);
    if (gate) { const paused = await f.run("run"); expect(paused.code, paused.output).toBe(3); }
    const owner = f.run(gate ? "resume" : "run");
    try {
      const until = Date.now() + 25_000;
      while (!existsSync(f.ready) && Date.now() < until) await new Promise(r => setTimeout(r, 20));
      expect(existsSync(f.ready)).toBe(true);
      const competitors = await Promise.all(Array.from({ length: 6 }, () => f.run(gate ? "resume" : "run")));
      for (const result of competitors) { expect(result.code, result.output).toBe(1); expect(result.output).toContain("THREAD_BUSY"); }
    } finally { writeFileSync(f.release, "go"); }
    const result = await owner; expect(result.code, result.output).toBe(0);
    const duplicate = await f.run("resume"); expect(duplicate.code).toBe(1); expect(duplicate.output).toContain("THREAD_NOT_WAITING");
    expect(readFileSync(f.effect, "utf8")).toBe("ran\n");
    const backend = await openSqliteBackend(f.db);
    try {
      expect(backend.db.prepare("SELECT status, deletable FROM fg_checkpoint_threads WHERE thread_id='same'").get()).toEqual({ status: "finished", deletable: 0 });
    } finally { backend.close(); }
  }, 90_000);
  it("refuses an unknown resume without creating a checkpoint or calling a node", async () => {
    const f = fixture(); const result = await f.run("resume");
    expect(result.code, result.output).toBe(1); expect(result.output).toContain("THREAD_NOT_FOUND");
    expect(existsSync(f.effect)).toBe(false);
    const backend = await openSqliteBackend(f.db);
    try {
      expect(backend.db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get()).toEqual({ n: 0 });
      expect(backend.db.prepare("SELECT COUNT(*) AS n FROM fg_checkpoint_threads").get()).toEqual({ n: 0 });
    } finally { backend.close(); }
  }, 30_000);
});


it("inspects and explicitly recovers a killed owner without releasing a live or mismatched owner", async () => {
  const f = fixture(); const owner = f.launch("run");
  const admin = (...args: string[]) => {
    const result = requireSpawnSync(process.execPath, [resolve(import.meta.dirname, "../dist/bin.js"), "thread", ...args, "flow.yaml", "--thread", "same"], { cwd: f.dir, encoding: "utf8", timeout: 25_000 });
    return result;
  };
  let token = "";
  try {
    const until = Date.now() + 20_000;
    while (!existsSync(f.ready) && Date.now() < until) await new Promise(r => setTimeout(r, 20));
    expect(existsSync(f.ready)).toBe(true);
    const inspected = admin("inspect"); expect(inspected.status, inspected.stderr).toBe(0);
    const info = JSON.parse(inspected.stdout).claim;
    expect(info.owner).toMatchObject({ pid: owner.child.pid, host: expect.any(String), invocationId: expect.any(String) });
    token = info.token;
    expect(admin("release", "--token", token, "--owner-stopped").stderr).toContain("still alive");
  } finally { owner.child.kill("SIGKILL"); await owner.done; }
  expect(admin("release", "--token", "wrong", "--owner-stopped").status).toBe(1);
  expect(admin("release", "--token", token).status).toBe(1);
  const released = admin("release", "--token", token, "--owner-stopped");
  expect(released.status, released.stderr).toBe(0);
  writeFileSync(f.release, "go");
  const resumed = await f.run("resume"); expect(resumed.code, resumed.output).toBe(0);
  expect(readFileSync(f.effect, "utf8")).toBe("ran\n");
}, 90_000);
