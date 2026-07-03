import { describe, it, expect, beforeAll } from "vitest";
import * as path from "node:path";
import * as url from "node:url";
import { registerFunction } from "@veloxdevworks/flowgraph-core";
import { runGraphFile, eventsOfType } from "@veloxdevworks/flowgraph-testing";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

beforeAll(() => {
  registerFunction("classifyIssue", (input) => {
    const { title = "", body = "" } = input as { title?: string; body?: string };
    const text = `${title} ${body}`.toLowerCase();
    if (/\b(bug|error|fail|crash|broken|fix)\b/.test(text)) return "bug";
    if (/\b(feature|request|add|enhancement)\b/.test(text)) return "feature";
    return "question";
  });
});

const graphPath = path.join(__dirname, "triage.graph.yaml");
const cwd = __dirname;

describe("triage-issue example", () => {
  it("classifies a bug and creates a ticket via skill (mock mode)", async () => {
    const result = await runGraphFile(graphPath, {
      cwd,
      input: {
        issue: {
          title: "Fix: null pointer crash on login",
          body: "The app crashes with a fatal error on login.",
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(result.state.label).toBe("bug");

    const ticket = result.state.ticket as { type: string; key: string; url: string };
    expect(ticket.type).toBe("bug");
    expect(ticket.key).toMatch(/^DEMO-/);
    expect(ticket.url).toContain(ticket.key);
  });

  it("classifies a feature request and routes to skill", async () => {
    const result = await runGraphFile(graphPath, {
      cwd,
      input: {
        issue: {
          title: "Add dark mode support",
          body: "Please add a dark mode enhancement to the UI.",
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(result.state.label).toBe("feature");

    const ticket = result.state.ticket as { type: string };
    expect(ticket.type).toBe("feature");
  });

  it("emits skill.start and skill.end events", async () => {
    const result = await runGraphFile(graphPath, {
      cwd,
      input: { issue: { title: "Fix the bug", body: "Something is broken." } },
    });

    const starts = eventsOfType(result.events, "skill.start");
    expect(starts.length).toBeGreaterThan(0);
    expect((starts[0]?.data as { skill: string }).skill).toBe("mock-create-ticket");

    const ends = eventsOfType(result.events, "skill.end");
    expect(ends.length).toBeGreaterThan(0);
  });

  it("emits node.start events for classify, route, and create-ticket", async () => {
    const result = await runGraphFile(graphPath, {
      cwd,
      input: { issue: { title: "Fix the crash", body: "Error thrown on startup." } },
    });

    const nodeIds = eventsOfType(result.events, "node.start")
      .map((e) => (e.data as { nodeId: string }).nodeId);

    expect(nodeIds).toContain("classify");
    expect(nodeIds).toContain("route");
    expect(nodeIds).toContain("create-ticket");
  });
});
