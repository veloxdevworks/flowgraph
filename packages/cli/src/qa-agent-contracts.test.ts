import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function run(body: string, retry?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "fg-agent-contract-")); dirs.push(dir);
  writeFileSync(join(dir, "provider.mjs"), `export default [{name:'qa-contract',capabilities:{toolCalling:true,structuredOutput:true,streaming:false},async run(){${body}}}];`);
  writeFileSync(join(dir, "flow.yaml"), JSON.stringify({ apiVersion: "flowgraph/v1", kind: "Graph", metadata: { name: "agent-contract" }, imports: [{ providers: "./provider.mjs" }], nodes: [{ id: "ask", type: "agent", provider: "qa-contract", with: { prompt: "answer" }, ...(retry ? { retry } : {}) }], edges: [{ from: "START", to: "ask" }, { from: "ask", to: "END" }] }));
  return spawnSync(process.execPath, [resolve(import.meta.dirname, "../dist/bin.js"), "run", "flow.yaml", "--json"], { cwd: dir, encoding: "utf8", timeout: 25_000 });
}
describe("real CLI agent contracts", { timeout: 30_000 }, () => {
  it("exits nonzero and names step exhaustion", () => {
    const r = run("return {output:{partial:true},stopReason:'maxSteps'};");
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout + r.stderr).toContain("maxSteps");
  });
  it("emits each bounded engine retry", () => {
    const r = run("throw Object.assign(new Error('status 429'),{status:429});", { maxAttempts: 3, baseMs: 1, jitter: false });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    const events = r.stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(events.filter(e => e.type === "node.retry")).toHaveLength(2);
  });
});
