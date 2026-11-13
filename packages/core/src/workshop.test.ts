import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { compileGraph } from "./compiler.js";
import type { GraphSpec, WorkshopContract } from "@flowgraph/spec";
import { WORKSHOP_MAX_PATCH_BYTES, mapWorkshopResume, normalizeAgenda } from "./nodes/workshop.js";

function workshopGraph(extra: Record<string, unknown> = {}): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "workshop-graph" },
    state: { channels: { brief: { type: "object" }, topic: { type: "string", default: "" } } },
    nodes: [
      {
        id: "feature-workshop",
        type: "workshop",
        with: {
          message: "Workshop the feature",
          agenda: ["scope", "risks"],
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
          },
          context: "{{ state.topic }}",
          facilitator: "Cover the agenda; do not skip risks.",
          fallback: "form",
          output: { to: "brief" },
          ...extra,
        },
      },
    ],
    edges: [
      { from: "START", to: "feature-workshop" },
      { from: "feature-workshop", to: "END" },
    ],
    runtime: { checkpoint: { enabled: true, backend: "memory" } },
  } as unknown as GraphSpec;
}

/** The routing documented for `allowPartial`; each branch stops at a gate that names it. */
function routedOnCompleteGraph(): GraphSpec {
  const gate = (id: string) => ({ id, type: "hitl", with: { mode: "approve", message: id } });
  const spec = workshopGraph({ allowPartial: true }) as unknown as {
    nodes: unknown[];
    edges: unknown[];
  };
  spec.nodes.push(gate("post"), gate("follow-up"));
  spec.edges = [
    { from: "START", to: "feature-workshop" },
    {
      from: "feature-workshop",
      branch: [{ when: "{{ state.brief.complete }}", to: "post" }, { default: true, to: "follow-up" }],
    },
    { from: "post", to: "END" },
    { from: "follow-up", to: "END" },
  ];
  return spec as unknown as GraphSpec;
}

describe("workshop allowPartial", () => {
  it("advertises allowPartial in the contract only when set", async () => {
    const on = await compileGraph(workshopGraph({ allowPartial: true }), {});
    const onData = (await on.run({ threadId: "ap-on", onInterrupt: "fail" })).interrupts?.[0]?.payload as {
      data: WorkshopContract;
    };
    expect(onData.data.allowPartial).toBe(true);
    const off = await compileGraph(workshopGraph(), {});
    const offData = (await off.run({ threadId: "ap-off", onInterrupt: "fail" })).interrupts?.[0]?.payload as {
      data: WorkshopContract;
    };
    expect(offData.data.allowPartial).toBeUndefined();
  });

  it("routes an unfinished session on complete", async () => {
    const compiled = await compileGraph(routedOnCompleteGraph(), {});
    await compiled.run({ threadId: "ap-1", onInterrupt: "fail" });
    const r = await compiled.resume({
      threadId: "ap-1",
      resume: { output: {}, transcript: [{ role: "user", text: "out of time" }], endedReason: "timeout" },
      onInterrupt: "fail",
    });
    expect(r.interrupts?.[0]?.reason).toBe("follow-up");
    expect((r.state["brief"] as { complete: boolean }).complete).toBe(false);
  });

  it("routes a finished session on complete, even when it ended early", async () => {
    const compiled = await compileGraph(routedOnCompleteGraph(), {});
    await compiled.run({ threadId: "ap-2", onInterrupt: "fail" });
    const r = await compiled.resume({
      threadId: "ap-2",
      resume: { output: { title: "SSO" }, endedReason: "human_ended" },
      onInterrupt: "fail",
    });
    expect(r.interrupts?.[0]?.reason).toBe("post");
    expect((r.state["brief"] as { complete: boolean }).complete).toBe(true);
  });

  it("re-prompts an unfinished session when the node does not allow it", async () => {
    const compiled = await compileGraph(workshopGraph(), {});
    await compiled.run({ threadId: "ap-3", onInterrupt: "fail" });
    const r = await compiled.resume({
      threadId: "ap-3",
      resume: { output: {}, endedReason: "timeout" },
      onInterrupt: "fail",
    });
    expect(r.status).toBe("interrupted");
    expect(r.interrupts?.[0]?.validationError).toMatch(/missing required field/);
  });
});

describe("normalizeAgenda", () => {
  it("slugs string items and preserves object ids", () => {
    expect(normalizeAgenda(["Scope", { id: "risks", title: "Risks", description: "what could go wrong" }])).toEqual([
      { id: "scope", title: "Scope" },
      { id: "risks", title: "Risks", description: "what could go wrong" },
    ]);
  });
});

describe("mapWorkshopResume", () => {
  const schema = {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  };

  it("accepts a wrapped resume payload", () => {
    const result = mapWorkshopResume(
      {
        output: { title: "SSO" },
        transcript: [{ role: "user", text: "hi" }],
        coverage: { scope: true },
        endedReason: "completed",
      },
      { schema, nodeId: "w" },
    );
    expect(result.output.title).toBe("SSO");
    expect(result.transcript).toHaveLength(1);
    expect(result.coverage).toEqual({ scope: true });
    expect(result.endedReason).toBe("completed");
  });

  it("treats a bare output object as the contract (CLI convenience)", () => {
    const result = mapWorkshopResume({ title: "SSO" }, { schema, nodeId: "w" });
    expect(result.output).toEqual({ title: "SSO" });
    expect(result.endedReason).toBe("completed");
  });

  it("rejects non-object resumes instead of mapping them to {}", () => {
    expect(() => mapWorkshopResume("SSO please", { nodeId: "w" })).toThrow(/must be an object.*got string/);
    expect(() => mapWorkshopResume(null, { nodeId: "w" })).toThrow(/got null/);
    expect(() => mapWorkshopResume([{ title: "x" }], { nodeId: "w" })).toThrow(/got array/);
    expect(() => mapWorkshopResume({ output: "SSO" }, { nodeId: "w" })).toThrow(/"output" must be an object/);
  });

  it("rejects output fields mixed with meta keys instead of dropping them", () => {
    expect(() => mapWorkshopResume({ title: "SSO", transcript: [] }, { nodeId: "w" })).toThrow(
      /mixes output fields with "transcript"/,
    );
    expect(() => mapWorkshopResume({ output: { title: "SSO" }, title: "dup" }, { nodeId: "w" })).toThrow(
      /unexpected top-level key\(s\) "title"/,
    );
  });

  it("validates meta field types", () => {
    expect(() => mapWorkshopResume({ output: { title: "a" }, transcript: "hi" }, { schema, nodeId: "w" })).toThrow(
      /"transcript" must be an array/,
    );
    expect(() => mapWorkshopResume({ output: { title: "a" }, coverage: [] }, { schema, nodeId: "w" })).toThrow(
      /"coverage" must be an object/,
    );
  });

  it("allows meta-only resumes (e.g. an ended session) when the schema permits", () => {
    const r = mapWorkshopResume({ transcript: [], endedReason: "timeout" }, { nodeId: "w" });
    expect(r.output).toEqual({});
    expect(r.endedReason).toBe("timeout");
  });

  it("rejects missing required fields", () => {
    expect(() => mapWorkshopResume({ output: {} }, { schema, nodeId: "w" })).toThrow(
      /missing required field/,
    );
  });

  it("marks a whole output complete", () => {
    const r = mapWorkshopResume({ output: { title: "SSO" } }, { schema, nodeId: "w" });
    expect(r.complete).toBe(true);
  });

  it("rejects an unfinished output that ended early unless the node allows it", () => {
    for (const endedReason of ["human_ended", "timeout", "skipped"]) {
      expect(() => mapWorkshopResume({ output: {}, endedReason }, { schema, nodeId: "w" })).toThrow(
        /missing required field/,
      );
    }
  });

  it("accepts an unfinished output that ended early with allowPartial, marked incomplete", () => {
    const r = mapWorkshopResume(
      { output: {}, endedReason: "timeout" },
      { schema, nodeId: "w", allowPartial: true },
    );
    expect(r.complete).toBe(false);
    expect(r.endedReason).toBe("timeout");
  });

  it("does not let allowPartial excuse a session reported as completed", () => {
    for (const resume of [{ output: {}, endedReason: "completed" }, { output: {}, endedReason: "form" }, { output: {} }]) {
      expect(() => mapWorkshopResume(resume, { schema, nodeId: "w", allowPartial: true })).toThrow(
        /missing required field/,
      );
    }
  });

  it("still checks property types on a partial output", () => {
    expect(() =>
      mapWorkshopResume(
        { output: { title: 7 }, endedReason: "human_ended" },
        { schema, nodeId: "w", allowPartial: true },
      ),
    ).toThrow(/field "title" expected type string/);
  });
});

describe("workshop node", () => {
  it("interrupts with kind workshop and a session contract", async () => {
    const compiled = await compileGraph(workshopGraph(), {});
    const r1 = await compiled.run({
      threadId: "ws-1",
      input: { topic: "auth" },
      onInterrupt: "fail",
    });
    expect(r1.status).toBe("interrupted");
    expect(r1.interrupts?.[0]?.kind).toBe("workshop");
    expect(r1.interrupts?.[0]?.reason).toBe("Workshop the feature");
    const data = (r1.interrupts?.[0]?.payload as { data?: Record<string, unknown> })?.data;
    expect(data?.["mode"]).toBe("workshop");
    expect(data?.["agenda"]).toEqual([
      { id: "scope", title: "scope" },
      { id: "risks", title: "risks" },
    ]);
    expect(data?.["context"]).toBe("auth");
    expect(data?.["fallback"]).toBe("form");
    expect((data?.["schema"] as { required?: string[] })?.required).toContain("title");
  });

  it("emits artifactRefs and reports diff failures on diff.error, not diffStat", async () => {
    const compiled = await compileGraph(
      workshopGraph({ artifacts: ["docs/{{ state.topic }}.md"], diff: { cwd: os.tmpdir(), base: "--output=/tmp/x" } }),
      {},
    );
    const r1 = await compiled.run({ threadId: "ws-contract", input: { topic: "auth" }, onInterrupt: "fail" });
    const data = (r1.interrupts?.[0]?.payload as { data?: WorkshopContract })?.data;
    expect(data?.artifactRefs).toEqual(["docs/auth.md"]);
    expect(data?.diffStat).toBeUndefined();
    expect(data?.diff).toMatchObject({ error: expect.stringMatching(/must not start with "-"/) });
  });

  it("caps very large git patches in the checkpointed payload", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-ws-diff-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    fs.writeFileSync(path.join(dir, "big.txt"), "a\n");
    git("add", "big.txt");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    fs.writeFileSync(path.join(dir, "big.txt"), "x".repeat(100) + "\n".repeat(1) + "y\n".repeat(WORKSHOP_MAX_PATCH_BYTES));
    const compiled = await compileGraph(workshopGraph({ diff: { cwd: dir } }), {});
    const r1 = await compiled.run({ threadId: "ws-bigdiff", onInterrupt: "fail" });
    const data = (r1.interrupts?.[0]?.payload as { data?: WorkshopContract })?.data;
    const diff = data?.diff as { patch: string; truncated?: boolean };
    expect(diff.truncated).toBe(true);
    expect(Buffer.byteLength(diff.patch, "utf8")).toBeLessThanOrEqual(WORKSHOP_MAX_PATCH_BYTES);
    expect(typeof data?.diffStat).toBe("string");
  });

  it("resumes with a validated output and writes state", async () => {
    const compiled = await compileGraph(workshopGraph(), {});
    await compiled.run({ threadId: "ws-2", onInterrupt: "fail" });
    const r2 = await compiled.resume({
      threadId: "ws-2",
      resume: {
        output: { title: "SSO login" },
        transcript: [{ role: "assistant", text: "What is the scope?" }],
        coverage: { scope: true, risks: false },
        endedReason: "completed",
      },
      onInterrupt: "fail",
    });
    expect(r2.status).toBe("completed");
    const brief = r2.state["brief"] as {
      output: { title: string };
      endedReason: string;
    };
    expect(brief.output.title).toBe("SSO login");
    expect(brief.endedReason).toBe("completed");
  });

  it("accepts a bare JSON object on resume (headless / CI)", async () => {
    const compiled = await compileGraph(workshopGraph(), {});
    await compiled.run({ threadId: "ws-3", onInterrupt: "fail" });
    const r2 = await compiled.resume({
      threadId: "ws-3",
      resume: { title: "Billing credits" },
      onInterrupt: "fail",
    });
    expect(r2.status).toBe("completed");
    expect((r2.state["brief"] as { output: { title: string } }).output.title).toBe("Billing credits");
  });

  it("re-prompts with the validation error when resume output fails the schema", async () => {
    const compiled = await compileGraph(workshopGraph(), {});
    await compiled.run({ threadId: "ws-4", onInterrupt: "fail" });
    const r2 = await compiled.resume({
      threadId: "ws-4",
      resume: { output: { title: 12 } },
      onInterrupt: "fail",
    });
    expect(r2.status).toBe("interrupted");
    expect(r2.interrupts?.[0]?.kind).toBe("workshop");
    expect(r2.interrupts?.[0]?.validationError).toContain("expected type string");
    expect(r2.interrupts?.[0]).toMatchObject({ attempt: 1, maxAttempts: 3 });
    expect(r2.interrupts?.[0]?.exhausted).toBeUndefined();
  });
});
