import { describe, it, expect } from "vitest";
import { compileGraph } from "./compiler.js";
import type { GraphSpec } from "@flowgraph/spec";
import { mapWorkshopResume, normalizeAgenda } from "./nodes/workshop.js";

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

  it("rejects missing required fields", () => {
    expect(() => mapWorkshopResume({ output: {} }, { schema, nodeId: "w" })).toThrow(
      /missing required field/,
    );
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

  it("errors when resume output fails the schema", async () => {
    const compiled = await compileGraph(workshopGraph(), {});
    await compiled.run({ threadId: "ws-4", onInterrupt: "fail" });
    const r2 = await compiled.resume({
      threadId: "ws-4",
      resume: { output: { title: 12 } },
      onInterrupt: "fail",
    });
    expect(r2.status).toBe("error");
    expect(r2.error?.message).toContain("expected type string");
  });
});
