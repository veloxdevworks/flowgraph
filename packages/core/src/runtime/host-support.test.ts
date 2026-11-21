import { describe, expect, it } from "vitest";
import { GraphSpecSchema, type GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "../compiler.js";
import { hostSupportDiagnostics } from "./host-support.js";
import { registerFunction } from "../nodes/function.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function graph(over: Record<string, unknown> = {}): GraphSpec {
  return GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "host-support" },
    nodes: [{ id: "a", type: "function", with: { fn: "hostSupportOk" } }],
    edges: [
      { from: "START", to: "a" },
      { from: "a", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
    ...over,
  });
}

describe("hostSupportDiagnostics", () => {
  it("is silent when the graph has no triggers", () => {
    expect(hostSupportDiagnostics(graph(), { hostName: "flowgraph CLI" })).toEqual([]);
  });

  it("warns that this host ignores triggers", () => {
    const spec = graph({
      triggers: [{ id: "nightly", type: "cron", schedule: "0 2 * * *" }],
    });
    const d = hostSupportDiagnostics(spec, { hostName: "flowgraph CLI" });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      severity: "warning",
      code: "TRIGGERS_HOST_UNSUPPORTED",
      path: "triggers",
    });
    expect(d[0]!.message).toContain("flowgraph CLI");
    expect(d[0]!.message).toContain("ignored");
    expect(d[0]!.message).toContain("Desktop");
    expect(d[0]!.message).not.toMatch(/phase/i);
  });

  it("is silent when the host interprets triggers", () => {
    const spec = graph({
      triggers: [{ id: "nightly", type: "cron", schedule: "0 2 * * *" }],
    });
    expect(
      hostSupportDiagnostics(spec, { hostName: "Flowgraph Desktop", interpretsTriggers: true }),
    ).toEqual([]);
  });
});

describe("compiled.run() host warning", () => {
  it("emits run.issue when the graph has triggers, and not when interpretsTriggers is set", async () => {
    registerFunction("hostSupportOk", () => ({ ok: true }));
    const spec = graph({
      triggers: [{ id: "boot", type: "startup" }],
    });
    const issues: Array<{ type: string; data: unknown }> = [];
    const compiled = await compileGraph(spec, {
      sinks: [
        (e) => {
          if (e.type === "run.issue") issues.push({ type: e.type, data: e.data });
        },
      ],
    });
    const r = await compiled.run();
    expect(r.status).toBe("completed");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.data).toMatchObject({
      code: "TRIGGERS_HOST_UNSUPPORTED",
      severity: "warning",
    });
    expect(String((issues[0]!.data as { message: string }).message)).toContain("compiled.run()");
    expect(String((issues[0]!.data as { message: string }).message)).not.toMatch(/phase/i);

    const quiet: unknown[] = [];
    const desktop = await compileGraph(spec, {
      interpretsTriggers: true,
      sinks: [
        (e) => {
          if (e.type === "run.issue") quiet.push(e.data);
        },
      ],
    });
    const r2 = await desktop.run();
    expect(r2.status).toBe("completed");
    expect(quiet).toEqual([]);
  });
});

describe("the host warning is a run issue", () => {
  it("lands in RunResult.issues with the host's name, and not when the host interprets triggers", async () => {
    registerFunction("hostSupportOk", () => ({ ok: true }));
    const spec = graph({ triggers: [{ id: "nightly", type: "cron", schedule: "0 2 * * *" }] });
    const ws = mkdtempSync(join(tmpdir(), "fg-host-issue-"));
    try {
      const r = await (await compileGraph(spec, { workspace: ws, hostName: "flowgraph CLI" })).run();
      expect(r.status).toBe("completed");
      expect(r.issues).toHaveLength(1);
      expect(r.issues![0]).toMatchObject({ code: "TRIGGERS_HOST_UNSUPPORTED", severity: "warning", detail: { path: "triggers" } });
      expect(r.issues![0]!.message).toContain("flowgraph CLI");
      expect(r.issues![0]!.raisedAt).toEqual(expect.any(String));

      const quiet = await (await compileGraph(spec, { workspace: ws, interpretsTriggers: true })).run();
      expect(quiet.issues ?? []).toEqual([]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
