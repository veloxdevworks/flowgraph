import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as url from "node:url";
import { loadGraph, compileForTest, eventsOfType } from "@veloxdevworks/flowgraph-testing";
import "./register.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const graphPath = path.join(__dirname, "software-factory.graph.yaml");

const feature = {
  title: "Spike dark-mode toggle",
  description: "Quick prototype for settings UI",
  owner: "alex",
  ticket: "SF-100",
};

const prodFeature = {
  title: "Checkout redesign",
  description: "GA-ready checkout flow",
  owner: "sam",
  ticket: "SF-200",
};

async function compiled() {
  const { spec } = await loadGraph(graphPath, { cwd: __dirname });
  if (!spec) throw new Error("failed to load software-factory graph");
  return compileForTest(spec);
}

/** Run until choose-track, then pick a track. */
async function chooseTrack(
  graph: Awaited<ReturnType<typeof compiled>>["compiled"],
  threadId: string,
  inputFeature: typeof feature,
  track: "prototype" | "production",
) {
  const first = await graph.run({
    threadId,
    input: { feature: inputFeature },
    onInterrupt: "fail",
  });
  expect(first.status).toBe("interrupted");
  expect(first.interrupts?.[0]?.reason).toMatch(/prototype|production/i);
  return graph.resume({ threadId, resume: { choice: track } });
}

describe("software-factory example", () => {
  it("interrupts at choose-track before routing", async () => {
    const { compiled: graph } = await compiled();
    const result = await graph.run({
      threadId: "sf-choose",
      input: { feature },
      onInterrupt: "fail",
    });
    expect(result.status).toBe("interrupted");
    expect(result.interrupts?.[0]?.reason).toMatch(/prototype|production/i);
    expect((result.state["jira"] as { status: string }).status).toBe("In Progress");
    expect(result.state["track"]).toBeFalsy();
  });

  it("prototype track: promote gate — decline stays on staging and finishes", async () => {
    const { compiled: graph } = await compiled();
    const afterTrack = await chooseTrack(graph, "sf-proto", feature, "prototype");
    expect(afterTrack.status).toBe("interrupted");
    expect(afterTrack.interrupts?.[0]?.reason).toMatch(/Promote to production/i);
    expect((afterTrack.state["deploy"] as { environment: string }).environment).toBe("staging");

    const result = await graph.resume({
      threadId: "sf-proto",
      resume: { approved: false },
    });

    expect(result.status).toBe("completed");
    expect(result.state["track"]).toBe("prototype");
    expect(Object.keys((result.state["checks"] as object) ?? {})).toHaveLength(0);
    expect((result.state["deploy"] as { environment: string }).environment).toBe("staging");
    expect((result.state["jira"] as { status: string }).status).toBe("Done");
    const notes = result.state["notifications"] as { kind: string }[];
    expect(notes.some((n) => n.kind === "shipped")).toBe(true);
    expect(notes.some((n) => n.kind === "design-review")).toBe(false);
    expect((result.state["outcome"] as { status: string }).status).toBe("completed");
  });

  it("prototype track: promote gate — approve joins production flow", async () => {
    const { compiled: graph } = await compiled();
    await chooseTrack(graph, "sf-promote", feature, "prototype");

    const afterPromote = await graph.resume({
      threadId: "sf-promote",
      resume: { approved: true },
    });
    expect(afterPromote.status).toBe("interrupted");
    expect(afterPromote.state["track"]).toBe("production");
    expect(afterPromote.interrupts?.[0]?.reason).toMatch(/Design review/i);

    await graph.resume({ threadId: "sf-promote", resume: { approved: true } });
    const done = await graph.resume({
      threadId: "sf-promote",
      resume: { approved: true },
    });
    expect(done.status).toBe("completed");
    expect((done.state["deploy"] as { environment: string }).environment).toBe("production");
    expect((done.state["checks"] as { e2e?: { passed: boolean } }).e2e?.passed).toBe(true);
    expect(
      (done.state["feature"] as { promotedFromPrototype?: boolean }).promotedFromPrototype,
    ).toBe(true);
  });

  it("production track: interrupts at design review then release gate", async () => {
    const { compiled: graph, events } = await compiled();

    const afterTrack = await chooseTrack(graph, "sf-prod", prodFeature, "production");
    expect(afterTrack.status).toBe("interrupted");
    expect(afterTrack.interrupts?.[0]?.reason).toMatch(/Design review/i);
    expect(afterTrack.state["track"]).toBe("production");

    const afterDesign = await graph.resume({
      threadId: "sf-prod",
      resume: { approved: true },
    });
    expect(afterDesign.status).toBe("interrupted");
    expect(afterDesign.interrupts?.[0]?.reason).toMatch(/Release gate/i);
    const reviews = afterDesign.state["reviews"] as { kind: string }[];
    expect(reviews.map((r) => r.kind).sort()).toEqual(["design", "performance", "security"]);
    expect((afterDesign.state["synthesis"] as { reviewCount: number }).reviewCount).toBe(3);
    expect((afterDesign.state["plan"] as { actions: unknown[] }).actions.length).toBeGreaterThan(0);
    expect((afterDesign.state["checks"] as { i18n?: { passed: boolean } }).i18n?.passed).toBe(true);
    expect((afterDesign.state["checks"] as { a11y?: { passed: boolean } }).a11y?.passed).toBe(true);
    expect((afterDesign.state["checks"] as { unit?: { passed: boolean } }).unit?.passed).toBe(true);
    expect((afterDesign.state["checks"] as { e2e?: { passed: boolean } }).e2e?.passed).toBe(true);
    expect((afterDesign.state["checks"] as { o11y?: { passed: boolean } }).o11y?.passed).toBe(true);

    const done = await graph.resume({
      threadId: "sf-prod",
      resume: { approved: true },
    });
    expect(done.status).toBe("completed");
    expect((done.state["deploy"] as { environment: string }).environment).toBe("production");
    expect((done.state["jira"] as { status: string }).status).toBe("Done");
    const notes = done.state["notifications"] as { kind: string }[];
    expect(notes.map((n) => n.kind)).toEqual(
      expect.arrayContaining(["design-review", "release-review", "shipped"]),
    );
    expect(eventsOfType(events, "interrupt.raised").length).toBeGreaterThanOrEqual(3);
  });

  it("production: design reject loops then continues", async () => {
    const { compiled: graph } = await compiled();
    await chooseTrack(graph, "sf-design-loop", prodFeature, "production");

    const rejected = await graph.resume({
      threadId: "sf-design-loop",
      resume: { approved: false },
    });
    expect(rejected.status).toBe("interrupted");
    expect((rejected.state["design"] as { revision: number }).revision).toBe(1);
    expect(rejected.interrupts?.[0]?.reason).toMatch(/Design review/i);

    const afterApprove = await graph.resume({
      threadId: "sf-design-loop",
      resume: { approved: true },
    });
    expect(afterApprove.status).toBe("interrupted");
    expect(afterApprove.interrupts?.[0]?.reason).toMatch(/Release gate/i);

    const done = await graph.resume({
      threadId: "sf-design-loop",
      resume: { approved: true },
    });
    expect(done.status).toBe("completed");
  });

  it("production: release reject loops back through e2e", async () => {
    const { compiled: graph } = await compiled();
    await chooseTrack(graph, "sf-release-loop", prodFeature, "production");
    await graph.resume({ threadId: "sf-release-loop", resume: { approved: true } });

    const rejected = await graph.resume({
      threadId: "sf-release-loop",
      resume: { approved: false },
    });
    expect(rejected.status).toBe("interrupted");
    expect(rejected.state["fixAttempt"]).toBe(1);
    expect(rejected.interrupts?.[0]?.reason).toMatch(/Release gate/i);

    const done = await graph.resume({
      threadId: "sf-release-loop",
      resume: { approved: true },
    });
    expect(done.status).toBe("completed");
    expect((done.state["checks"] as { e2e?: { fixAttempt: number } }).e2e?.fixAttempt).toBe(1);
  });
});
