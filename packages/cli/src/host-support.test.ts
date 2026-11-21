import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const bin = resolve(import.meta.dirname, "../dist/bin.js");
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "fg-cli-host-"));
  dirs.push(dir);
  return dir;
}
const graph = {
  apiVersion: "flowgraph/v1",
  kind: "Graph",
  metadata: { name: "hosted" },
  triggers: [{ id: "nightly", type: "cron", schedule: "0 2 * * *" }],
  nodes: [{ id: "step", type: "router", with: { routes: { done: { default: true, to: "END" } } } }],
  edges: [
    { from: "START", to: "step" },
    { from: "step", to: "END" },
  ],
};
function cli(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: "utf8",
    timeout: 20_000,
  });
}

describe("CLI host-support warning", () => {
  it("validate prints a warning and still exits 0", () => {
    const dir = fixture();
    writeFileSync(join(dir, "g.yaml"), JSON.stringify(graph));
    const result = cli(dir, "validate", "g.yaml");
    const out = result.stdout + result.stderr;
    expect(result.status, out).toBe(0);
    expect(out).toMatch(/TRIGGERS_HOST_UNSUPPORTED|does not start runs from triggers/);
    expect(out).toContain("flowgraph CLI");
    expect(out).not.toMatch(/phase/i);
  });
});
