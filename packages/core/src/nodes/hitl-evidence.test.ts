/**
 * `hitl` `with.evidence` (ADR-0019 §7–8). The demo results are seeded into `state.outputs`,
 * since these tests pin the gate's rules, not the capture; the demo node itself runs after the
 * gate, so it is there to satisfy the compile checks and never overwrites the seed.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { Artifact, GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "../compiler.js";
import { hitlEvidenceDiagnostics } from "../runtime/validate-graph.js";
import type { GateEvidence } from "./hitl-evidence.js";

const OBJECTIVE = "A signed-in user can complete checkout";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "fg-gate-evidence-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function spec(gateWith: Record<string, unknown>, extraNodes: Array<Record<string, unknown>> = []): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "gate-evidence" },
    state: { channels: {} },
    nodes: [
      { id: "gate", type: "hitl", with: { mode: "approve", message: "Ship?", evidence: ["prove"], ...gateWith } },
      { id: "prove", type: "demo", with: { objective: OBJECTIVE, http: { url: "http://127.0.0.1:9/" } } },
      ...extraNodes,
    ],
    edges: [
      { from: "START", to: "gate" },
      { from: "gate", to: "prove" },
      { from: "prove", to: "END" },
    ],
    runtime: { checkpoint: { enabled: true, backend: "memory" } },
  } as unknown as GraphSpec;
}

/** A stored `demo` result whose file (if `file`) is really on disk. */
async function demoResult(
  status: "passed" | "failed" | "inconclusive" | "not_captured",
  opts: { file?: boolean; reason?: string } = {},
): Promise<Record<string, unknown>> {
  const rel = ".flowgraph/artifacts/t/prove/final.png";
  const abs = path.join(dir, rel);
  const file = opts.file ?? status !== "not_captured";
  if (file) {
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, "png");
  }
  const record: Artifact = { kind: "artifact", path: rel, mimeType: "image/png", sizeBytes: 3, role: "image" } as Artifact;
  return {
    ok: status === "passed" || status === "inconclusive",
    status,
    kind: "steps",
    path: file ? abs : null,
    mimeType: file ? "image/png" : null,
    sizeBytes: file ? 3 : null,
    reason: opts.reason ?? (status === "failed" ? 'text "Order placed" not visible' : status === "not_captured" ? "connection refused" : null),
    capturedAt: "2026-11-07T10:00:00.000Z",
    label: null,
    extra: null,
    pageStatus: file ? 200 : null,
    request: null,
    response: null,
    artifacts: file ? [record] : [],
    objective: OBJECTIVE,
    steps: null,
    assertions: [{ check: 'text "Order placed" is visible', positive: true, held: status === "passed" }],
    console: null,
  };
}

type Payload = { reason?: string; data: Record<string, unknown> & { evidence?: GateEvidence[]; validationError?: string } };
const payloadOf = (res: { interrupts?: Array<{ payload?: unknown }> | undefined }) => res.interrupts![0]!.payload as Payload;

async function gate(gateWith: Record<string, unknown>, prove?: Record<string, unknown>) {
  const g = await compileGraph(spec(gateWith), { cwd: dir });
  const threadId = `t-${Math.random().toString(36).slice(2)}`;
  const first = await g.run({ threadId, onInterrupt: "fail", input: prove ? { outputs: { prove } } : {} });
  expect(first.status).toBe("interrupted");
  return {
    first,
    answer: (resume: unknown) => g.resume({ threadId, resume, onInterrupt: "fail" }),
  };
}

const gateOut = (res: { state: Record<string, unknown> }) =>
  (res.state["outputs"] as Record<string, Record<string, unknown>>)["gate"]!;

describe("hitl with.evidence: what the gate shows", () => {
  it("sends one entry per id, adds the files to artifacts and the verdicts to the message", async () => {
    const { first } = await gate({}, await demoResult("passed"));
    const p = payloadOf(first);
    expect(p.data.evidence).toEqual([
      {
        nodeId: "prove",
        objective: OBJECTIVE,
        status: "passed",
        reason: null,
        capturedAt: "2026-11-07T10:00:00.000Z",
        assertions: [{ check: 'text "Order placed" is visible', positive: true, held: true }],
        artifacts: [expect.objectContaining({ path: ".flowgraph/artifacts/t/prove/final.png" })],
        needsOverride: false,
      },
    ]);
    expect((p.data["artifacts"] as Artifact[]).map((a) => a.path)).toEqual([".flowgraph/artifacts/t/prove/final.png"]);
    expect(p.data["artifactRefs"]).toEqual([".flowgraph/artifacts/t/prove/final.png"]);
    expect(p.reason).toContain("Ship?\n\nEvidence (1):\n- prove, passed: A signed-in user can complete checkout");
    expect(p.reason).not.toContain("override");
  });

  it("reports a node that never ran as not_run, so absence is visible", async () => {
    const { first } = await gate({});
    const e = payloadOf(first).data.evidence![0]!;
    expect(e).toMatchObject({ nodeId: "prove", status: "not_run", artifacts: [], needsOverride: true, capturedAt: null });
    expect(payloadOf(first).reason).toContain("- prove, not run [approving needs an override]");
  });

  it("labels inconclusive evidence as having no automated check, without asking for an override", async () => {
    const { first } = await gate({}, await demoResult("inconclusive"));
    expect(payloadOf(first).data.evidence![0]!.needsOverride).toBe(false);
    expect(payloadOf(first).reason).toContain("- prove, inconclusive (no automated check)");
  });

  it("asks for an override when a passed result's file is gone", async () => {
    const prove = await demoResult("passed");
    await rm(path.join(dir, ".flowgraph/artifacts/t/prove/final.png"));
    const { first } = await gate({}, prove);
    const e = payloadOf(first).data.evidence![0]!;
    expect(e).toMatchObject({ status: "passed", needsOverride: true, artifacts: [] });
    expect(e.reason).toBe("evidence files are gone: .flowgraph/artifacts/t/prove/final.png");
  });

  it("keeps evidence out of captureFailures when with.artifacts names the same node", async () => {
    const { first } = await gate({ artifacts: ["{{ state.outputs.prove }}"] }, await demoResult("failed"));
    const p = payloadOf(first);
    expect(p.data["captureFailures"]).toBeUndefined();
    expect(p.reason).not.toContain("Capture problems");
    expect((p.data["artifacts"] as Artifact[]).map((a) => a.path)).toEqual([".flowgraph/artifacts/t/prove/final.png"]);
    expect(p.data.evidence![0]!.status).toBe("failed");
  });
});

describe("hitl with.evidence: approving past bad evidence", () => {
  it("accepts a bare approve when the evidence passed, and writes override: null", async () => {
    const { answer } = await gate({}, await demoResult("passed"));
    const res = await answer(true);
    expect(res.status).toBe("completed");
    expect(gateOut(res)).toMatchObject({ approved: true, override: null });
    expect((res.issues ?? []).map((i) => i.code)).not.toContain("EVIDENCE_OVERRIDDEN");
  });

  for (const status of ["failed", "not_captured", "not_run"] as const) {
    it(`re-prompts a bare approve past ${status} evidence, saying how to override`, async () => {
      const { answer } = await gate({}, status === "not_run" ? undefined : await demoResult(status));
      const res = await answer({ approved: true });
      expect(res.status).toBe("interrupted");
      const err = payloadOf(res).data.validationError!;
      expect(err).toContain(`this evidence does not hold: prove (${status})`);
      expect(err).toContain(`{ "approved": true, "override": { "reason": "<why>" } }`);
    });
  }

  it("accepts approve with a reason, builds the override itself and raises EVIDENCE_OVERRIDDEN", async () => {
    const { answer } = await gate({}, await demoResult("failed"));
    const res = await answer({
      approved: true,
      override: { reason: "  copy change only, checked by hand  ", items: [{ nodeId: "other", status: "passed" }] },
    });
    expect(res.status).toBe("completed");
    expect(gateOut(res)["override"]).toEqual({
      reason: "copy change only, checked by hand",
      items: [{ nodeId: "prove", status: "failed" }],
    });
    const issue = (res.issues ?? []).find((i) => i.code === "EVIDENCE_OVERRIDDEN");
    expect(issue).toMatchObject({ severity: "warning", nodeId: "gate" });
    expect(issue!.message).toContain("prove (failed). Reason: copy change only, checked by hand");
  });

  it("rejects an override whose reason is blank", async () => {
    const { answer } = await gate({ maxResumeAttempts: 5 }, await demoResult("failed"));
    for (const override of [{ reason: "  " }, {}, "because"]) {
      const res = await answer({ approved: true, override });
      expect(res.status).toBe("interrupted");
      expect(payloadOf(res).data.validationError).toContain("given without a non-empty reason");
    }
  });

  it("never needs an override to reject, and ignores a client-sent one", async () => {
    const { answer } = await gate({}, await demoResult("failed"));
    const res = await answer({ approved: false, override: { reason: "x" } });
    expect(res.status).toBe("completed");
    expect(gateOut(res)).toMatchObject({ approved: false, override: null });
  });

  it("review: approved: true with another decision still counts as approving", async () => {
    const { answer } = await gate({ mode: "review", decision: ["approve", "reject"] }, await demoResult("failed"));
    const sneaky = await answer({ decision: "reject", approved: true });
    expect(sneaky.status).toBe("interrupted");
    expect(payloadOf(sneaky).data.validationError).toContain(`{ "decision": "approve", "override"`);
    const other = await answer({ decision: "approve", approved: false });
    expect(other.status).toBe("interrupted");
    const ok = await answer({ decision: "reject", feedback: "fix it", override: { reason: "client" } });
    expect(ok.status).toBe("completed");
    expect(gateOut(ok)).toMatchObject({ decision: "reject", approved: false, override: null });
  });

  it("choice: shows the evidence but enforces nothing", async () => {
    const { first, answer } = await gate({ mode: "choice", choices: ["ship", "hold"] }, await demoResult("failed"));
    expect(payloadOf(first).data.evidence![0]!.needsOverride).toBe(true);
    const res = await answer({ choice: "ship" });
    expect(res.status).toBe("completed");
    expect(gateOut(res)).toMatchObject({ choice: "ship", override: null });
  });

  it("fails an --on-interrupt approve run with the interrupt still pending", async () => {
    const g = await compileGraph(spec({ maxResumeAttempts: 2 }), { cwd: dir });
    const res = await g.run({ threadId: "auto", onInterrupt: "approve", input: { outputs: { prove: await demoResult("failed") } } });
    expect(res.status).toBe("error");
    expect(res.error?.name).toBe("ResumeAttemptsExhaustedError");
    expect(res.interrupts?.[0]?.exhausted).toBe(true);
    const snap = await g.getState("auto");
    expect(snap?.next).toEqual(["gate"]);
  });

  it("gates without with.evidence are unchanged: no override field", async () => {
    const { answer } = await gate({ evidence: undefined }, await demoResult("failed"));
    const res = await answer(true);
    expect(gateOut(res)).toEqual({ approved: true, round: 1 });
  });
});

describe("hitl with.evidence: a real demo run", () => {
  it("re-prompts at a gate after a demo that got HTTP 500", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      const s = spec({});
      (s.nodes[1] as { with: Record<string, unknown> }).with = { objective: "The health check answers", http: { url } };
      s.edges = [
        { from: "START", to: "prove" },
        { from: "prove", to: "gate" },
        { from: "gate", to: "END" },
      ] as GraphSpec["edges"];
      const g = await compileGraph(s, { cwd: dir });
      const first = await g.run({ threadId: "real", onInterrupt: "fail" });
      const e = payloadOf(first).data.evidence![0]!;
      expect(e).toMatchObject({ status: "failed", needsOverride: true, objective: "The health check answers" });
      expect(e.artifacts).toHaveLength(1);
      const bare = await g.resume({ threadId: "real", resume: true, onInterrupt: "fail" });
      expect(bare.status).toBe("interrupted");
      const ok = await g.resume({ threadId: "real", resume: { approved: true, override: { reason: "known outage" } }, onInterrupt: "fail" });
      expect(ok.status).toBe("completed");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("hitl with.evidence: compile checks", () => {
  const bad = (gateWith: Record<string, unknown>, prove: Record<string, unknown> | undefined) => {
    const s = spec(gateWith);
    if (prove) s.nodes[1] = prove as GraphSpec["nodes"][number];
    return hitlEvidenceDiagnostics(s).map((d) => d.code);
  };

  it("accepts a demo node with an objective", () => {
    expect(bad({}, undefined)).toEqual([]);
  });

  it("refuses unknown ids, non-demo nodes, demos without an objective, output: none, and other modes", () => {
    expect(bad({ evidence: ["nope"] }, undefined)).toEqual(["HITL_EVIDENCE_UNKNOWN_NODE"]);
    expect(bad({}, { id: "prove", type: "code", with: { fn: "x" } })).toEqual(["HITL_EVIDENCE_NOT_DEMO"]);
    expect(bad({}, { id: "prove", type: "demo", with: { http: { url: "http://x/" } } })).toEqual(["HITL_EVIDENCE_NO_OBJECTIVE"]);
    expect(
      bad({}, { id: "prove", type: "demo", with: { objective: "x", output: "none", http: { url: "http://x/" } } }),
    ).toEqual(["HITL_EVIDENCE_OUTPUT_NONE"]);
    expect(bad({ mode: "question" }, undefined)).toEqual(["HITL_EVIDENCE_MODE"]);
  });

  it("compile refuses a gate whose evidence is wrong", async () => {
    await expect(compileGraph(spec({ evidence: ["nope"] }), { cwd: dir })).rejects.toThrow(
      /with\.evidence names "nope", which is not a node/,
    );
  });
});
