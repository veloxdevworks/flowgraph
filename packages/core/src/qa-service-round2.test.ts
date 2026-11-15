import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startService, stopService, resetServiceManager } from "./runtime/service-manager.js";
const dirs: string[] = [];
const children: number[] = [];
afterEach(async () => {
  for (const pid of children.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  await resetServiceManager();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
it("PLAT-374: reuses identical starts and refuses conflicting arguments", async () => {
  const base = {
    name: "server",
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    stopTimeout: "100ms",
  };
  const one = await startService("conflict", base);
  const two = await startService("conflict", base);
  expect(two.pid).toBe(one.pid);
  await expect(
    startService("conflict", { ...base, args: ["-e", "setInterval(()=>{},2000)"] }),
  ).rejects.toMatchObject({ code: "SERVICE_START_CONFLICT" });
});
it.skipIf(process.platform === "win32")(
  "PLAT-373: stops shell descendants and escalates an ignored signal",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "fg-service-tree-"));
    dirs.push(dir);
    const script = join(dir, "parent.cjs"),
      file = join(dir, "child.pid");
    const code =
      "require('fs').writeFileSync(process.argv[1],String(process.pid)); process.on('SIGTERM',()=>{}); console.log('child-ready'); setInterval(()=>{},1000)";
    await writeFile(
      script,
      `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(code)},${JSON.stringify(file)}],{stdio:'inherit'});setInterval(()=>{},1000);`,
    );
    const quote = (v: string) => "'" + v.replace(/'/g, "'\\''") + "'";
    const service = await startService("tree", {
      name: "tree",
      command: quote(process.execPath) + " " + quote(script),
      ready: { log: "child-ready" },
      readyInterval: "10ms",
      stopTimeout: "100ms",
    });
    const pid = Number(await readFile(file, "utf8"));
    children.push(pid);
    expect((await stopService("tree", "tree")).status).toBe("stopped");
    await vi.waitFor(
      () => {
        expect(() => process.kill(pid, 0)).toThrow();
      },
      { timeout: 2500 },
    );
    expect(service.pid).toBeTruthy();
  },
);
