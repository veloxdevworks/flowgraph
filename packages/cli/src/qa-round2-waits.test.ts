import { afterEach, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { compileGraph, type GraphSpec } from "@flowgraph/core";
import { openSqliteBackend } from "@flowgraph/checkpoint-sqlite";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const bin = resolve(import.meta.dirname, "../dist/bin.js");
async function fixture(withConfig: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "fg-round2-waits-"));
  dirs.push(dir);
  const spec = {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "round2-waits" },
    runtime: {
      workspace: dir,
      webhookServer: { port: 0 },
      checkpoint: { backend: "sqlite", path: join(dir, "state.db") },
    },
    nodes: [
      { id: "wait", type: "wait", with: withConfig },
      {
        id: "effect",
        type: "shell",
        with: {
          command: process.execPath,
          args: ["-e", "require('fs').writeFileSync('effect.txt','ran')"],
        },
      },
    ],
    edges: [
      { from: "START", to: "wait" },
      { from: "wait", to: "effect" },
      { from: "effect", to: "END" },
    ],
  } as unknown as GraphSpec;
  await writeFile(join(dir, "flow.json"), JSON.stringify(spec));
  return { dir, spec };
}
it("PLAT-356: --list is read-only and prints exactly one JSON document after a deadline", async () => {
  const { dir, spec } = await fixture({ signal: "ready", timeout: "1ms" });
  const backend = await openSqliteBackend(join(dir, "state.db"));
  try {
    const graph = await compileGraph(spec, {
      checkpointer: backend.checkpointer,
      scheduleTimeout: () => ({ unref() {} }),
    });
    expect((await graph.run({ threadId: "list" })).status).toBe("interrupted");
  } finally {
    backend.close();
  }
  await new Promise((r) => setTimeout(r, 20));
  const listed = spawnSync(
    process.execPath,
    [bin, "resume", "flow.json", "--thread", "list", "--list", "--json"],
    { cwd: dir, encoding: "utf8", timeout: 10000 },
  );
  expect(listed.status, listed.stderr).toBe(0);
  expect(() => JSON.parse(listed.stdout)).not.toThrow();
  expect(JSON.parse(listed.stdout).interrupts).toHaveLength(1);
  await expect(readFile(join(dir, "effect.txt"))).rejects.toMatchObject({ code: "ENOENT" });
}, 20000);
it("durable signal waits exit pending rather than blocking on a long deadline", async () => {
  const { dir } = await fixture({ signal: "ready", timeout: "30d" });
  const result = spawnSync(
    process.execPath,
    [bin, "run", "flow.json", "--thread", "timeout", "--json"],
    { cwd: dir, encoding: "utf8", timeout: 10000 },
  );
  expect(result.status, result.stdout + result.stderr).toBe(3);
  expect(result.stderr).not.toContain("TimeoutOverflowWarning");
  const events = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.some((e) => e.type === "interrupt.raised")).toBe(true);
  await expect(readFile(join(dir, "effect.txt"))).rejects.toMatchObject({ code: "ENOENT" });
}, 20000);
it("PLAT-357: the CLI exits after a webhook resumes and completes a run", async () => {
  const { dir } = await fixture({ webhook: true });
  const child = spawn(
    process.execPath,
    [bin, "run", "flow.json", "--thread", "webhook", "--json"],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  const exited = new Promise<number | null>((r) => child.once("exit", r));
  try {
    const until = Date.now() + 10000;
    let url: string | undefined;
    while (Date.now() < until) {
      for (const line of stdout.split("\n")) {
        try {
          const e = JSON.parse(line);
          if (e.type === "interrupt.raised")
            url = e.data.interrupts?.[0]?.payload?.data?.webhookUrl;
        } catch {}
      }
      if (url) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(url, stdout + stderr).toBeTruthy();
    const response = await fetch(url!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    const status = await Promise.race([
      exited,
      new Promise<string>((r) => setTimeout(() => r("still running"), 3000)),
    ]);
    expect(status, stdout + stderr).toBe(0);
    expect(() =>
      stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).not.toThrow();
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
}, 20000);

it("PLAT-370: a webhook deadline completes without confusing route cancellation with run cancellation", async () => {
  const { dir } = await fixture({ webhook: true, timeout: "50ms" });
  const result = spawnSync(
    process.execPath,
    [bin, "run", "flow.json", "--thread", "webhook-timeout", "--json"],
    { cwd: dir, encoding: "utf8", timeout: 10000 },
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(await readFile(join(dir, "effect.txt"), "utf8")).toBe("ran");
  expect(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .some((e) => e.type === "run.end"),
  ).toBe(true);
}, 20000);

it("a webhook deadline exits 0 when another process already completed the thread", async () => {
  // The waiting CLI only learns of an external resume when this deadline fires
  // and the timeout path sees THREAD_NOT_WAITING. Keep the deadline generous so
  // a slow second-process startup on CI cannot complete the thread first.
  const deadlineMs = 30_000;
  const { dir } = await fixture({ webhook: true, timeout: "30s" });
  const child = spawn(
    process.execPath,
    [bin, "run", "flow.json", "--thread", "external", "--json"],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  const exited = new Promise<number | null>((r) => child.once("exit", r));
  try {
    const until = Date.now() + 15000;
    let url: string | undefined;
    while (Date.now() < until) {
      for (const line of stdout.split("\n")) {
        try {
          const e = JSON.parse(line);
          if (e.type === "interrupt.raised")
            url = e.data.interrupts?.[0]?.payload?.data?.webhookUrl;
        } catch {}
      }
      if (url) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(url, stdout + stderr).toBeTruthy();
    const listedUntil = Date.now() + 10000;
    let listed: ReturnType<typeof spawnSync> | undefined;
    while (Date.now() < listedUntil) {
      listed = spawnSync(
        process.execPath,
        [bin, "resume", "flow.json", "--thread", "external", "--list", "--json"],
        { cwd: dir, encoding: "utf8", timeout: 10000 },
      );
      if (listed.status === 0) {
        try {
          if (JSON.parse(listed.stdout).interrupts?.length === 1) break;
        } catch {}
      }
      listed = undefined;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(listed?.status, (listed?.stdout ?? "") + (listed?.stderr ?? "")).toBe(0);
    expect(JSON.parse(listed!.stdout).interrupts).toHaveLength(1);
    const resumed = spawnSync(
      process.execPath,
      [bin, "resume", "flow.json", "--thread", "external", "--resume", "true"],
      { cwd: dir, encoding: "utf8", timeout: 15000 },
    );
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
    expect(await readFile(join(dir, "effect.txt"), "utf8")).toBe("ran");
    const status = await Promise.race([
      exited,
      new Promise<string>((r) => setTimeout(() => r("still running"), deadlineMs + 10_000)),
    ]);
    expect(status, stdout + stderr).toBe(0);
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
}, 60000);
