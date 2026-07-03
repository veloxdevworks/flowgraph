import { describe, it, expect, beforeAll } from "vitest";
import * as path from "node:path";
import * as url from "node:url";
import { loadGraph, compileForTest, eventsOfType } from "@veloxdevworks/flowgraph-testing";
import "./register.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const graphPath = path.join(__dirname, "release-notes.graph.yaml");

async function compiled() {
  const { spec } = await loadGraph(graphPath, { cwd: __dirname });
  if (!spec) throw new Error("failed to load release-notes graph");
  return compileForTest(spec);
}

describe("release-notes HITL example", () => {
  it("interrupts at the approval gate", async () => {
    const { compiled: graph } = await compiled();
    const result = await graph.run({ threadId: "rel-1", input: { version: "1.4.0" }, onInterrupt: "fail" });

    expect(result.status).toBe("interrupted");
    expect(result.interrupts?.[0]?.reason).toContain("Approve release notes");
    expect((result.interrupts?.[0]?.payload as { data?: { draft?: string } }).data?.draft)
      .toContain("Release 1.4.0");
    expect(result.state["published"]).toBeFalsy();
  });

  it("publishes after the operator approves on resume", async () => {
    const { compiled: graph, events } = await compiled();
    const first = await graph.run({ threadId: "rel-2", input: { version: "2.0.0" }, onInterrupt: "fail" });
    expect(first.status).toBe("interrupted");

    const resumed = await graph.resume({ threadId: "rel-2", resume: { approved: true, notes: "Curated notes" } });
    expect(resumed.status).toBe("completed");

    const published = resumed.state["published"] as { url: string; notes: string };
    expect(published.url).toContain("2.0.0");
    expect(published.notes).toBe("Curated notes");

    expect(eventsOfType(events, "interrupt.raised").length).toBeGreaterThan(0);
    expect(eventsOfType(events, "interrupt.resumed").length).toBeGreaterThan(0);
  });

  it("skips publishing when the operator rejects", async () => {
    const { compiled: graph } = await compiled();
    await graph.run({ threadId: "rel-3", input: { version: "3.0.0" }, onInterrupt: "fail" });
    const resumed = await graph.resume({ threadId: "rel-3", resume: { approved: false } });

    expect(resumed.status).toBe("completed");
    expect(resumed.state["published"]).toBeFalsy();
  });

  it("resolves the interrupt inline with a custom resolver", async () => {
    const { compiled: graph } = await compiled();
    const result = await graph.run({
      threadId: "rel-4",
      input: { version: "4.0.0" },
      onInterrupt: "prompt",
      resolveInterrupt: () => ({ approved: true, notes: "Resolver notes" }),
    });

    expect(result.status).toBe("completed");
    expect((result.state["published"] as { notes: string }).notes).toBe("Resolver notes");
  });
});
