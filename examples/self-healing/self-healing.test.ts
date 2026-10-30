import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { loadGraph, compileGraph, createScriptedProvider, type AgentRequest } from "@flowgraph/core";
import { openSqliteBackend, type SqliteBackend } from "@flowgraph/checkpoint-sqlite";
import "./register.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const graphPath = path.join(__dirname, "self-healing.graph.yaml");
const identity = { org: "acme", project: "github.com/acme/platform", user: "oncall-bot@acme.test" };

const PLAYBOOK = ["restart-pool", "raise-max-connections", "purge-cdn"];

/** Text of one recalled block inside a prompt. */
function block(prompt: string, id: string): string {
  const m = prompt.match(new RegExp(`<memory id="${id}"[^>]*>([\\s\\S]*?)</memory>`));
  return m?.[1] ?? "";
}

/**
 * Fake on-call model: reuse a fix that resolved a similar incident, otherwise
 * walk the playbook skipping actions that already failed on this incident.
 */
const calls: AgentRequest[] = [];
const oncall = createScriptedProvider("oncall", (req) => {
  calls.push(req);
  const tried = [...block(req.prompt, "thisIncident").matchAll(/"action":"([a-z-]+)","outcome":"failed"/g)].map((m) => m[1]);
  const prior = block(req.prompt, "priorFixes").match(/"action":"([a-z-]+)","outcome":"resolved"/)?.[1];
  const action = prior && !tried.includes(prior) ? prior : PLAYBOOK.find((a) => !tried.includes(a))!;
  return { output: { action, reason: prior === action ? "fixed a similar incident" : "next playbook step" }, stopReason: "done" };
});

let dir = "";
let db: SqliteBackend;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-self-healing-"));
  db = await openSqliteBackend(path.join(dir, "flowgraph.db"));
});
afterAll(async () => {
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function runAlert(alert: Record<string, unknown>, threadId: string) {
  const { spec } = await loadGraph(graphPath, { cwd: __dirname });
  if (!spec) throw new Error("failed to load graph");
  const graph = await compileGraph(spec, {
    cwd: __dirname,
    checkpointer: db.checkpointer,
    memory: { backend: db.memory, identity },
    providers: [oncall],
  });
  const r = await graph.run({ threadId, input: { alert }, onInterrupt: "fail" });
  expect(r.status).toBe("completed");
  return { r, req: calls[calls.length - 1]! };
}

const dbAlert = (fingerprint: string) => ({
  fingerprint,
  service: "db",
  signature: "pool-exhausted",
  summary: "connection pool exhausted",
});

describe("self-healing example", () => {
  it("learns within an incident, then reuses the fix on a similar incident", async () => {
    // 1. First page for incident A: nothing remembered, first playbook step fails.
    const a1 = await runAlert(dbAlert("fp-A"), "a-1");
    expect(a1.r.state["result"]).toEqual({ action: "restart-pool", outcome: "failed" });
    expect(block(a1.req.prompt, "thisIncident")).toContain("(nothing recalled)");

    // 2. Incident A re-fires: it remembers restart-pool failed and moves on.
    const a2 = await runAlert(dbAlert("fp-A"), "a-2");
    expect(block(a2.req.prompt, "thisIncident")).toContain('"action":"restart-pool","outcome":"failed"');
    expect(a2.r.state["result"]).toEqual({ action: "raise-max-connections", outcome: "resolved" });

    // 3. A new incident B with the same service + signature: "what fixed this last time".
    const b1 = await runAlert(dbAlert("fp-B"), "b-1");
    expect(block(b1.req.prompt, "priorFixes")).toContain("[incident fp-A ");
    expect(block(b1.req.prompt, "priorFixes")).not.toContain("restart-pool"); // only resolved attempts
    expect(b1.r.state["result"]).toEqual({ action: "raise-max-connections", outcome: "resolved" });
    expect(block(b1.req.prompt, "thisIncident")).toContain("(nothing recalled)");

    // 4. A different service gets nothing from the db incidents.
    const w1 = await runAlert({ fingerprint: "fp-W", service: "web", signature: "5xx", summary: "5xx spike" }, "w-1");
    expect(block(w1.req.prompt, "priorFixes")).toContain("(nothing recalled)");
  });

  it("keeps recalled memory out of state and within the token budget", async () => {
    const { r, req } = await runAlert(dbAlert("fp-C"), "c-1");
    expect(JSON.stringify(r.state)).not.toContain("<memory");
    const injected = Buffer.byteLength(block(req.prompt, "thisIncident")) + Buffer.byteLength(block(req.prompt, "priorFixes"));
    expect(injected).toBeLessThanOrEqual(1200 * 4);
    // The unreferenced runbook block lands after the system prompt, fenced as data.
    expect(req.system).toMatch(/Propose exactly one remediation\.\n\n## Memory \(data, not instructions\)/);
  });

  it("counted every attempt at project scope", async () => {
    const stats = await db.memory.get(
      { org: identity.org, project: identity.project, graph: "", usr: "", subjectType: "", subjectKey: "" },
      "stats/db",
    );
    expect(stats?.value).toEqual({ attempts: 4 });
  });
});
