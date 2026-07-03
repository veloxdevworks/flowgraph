import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as url from "node:url";
import { loadGraph, compileGraph, createScriptedProvider } from "@veloxdevworks/flowgraph-core";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const graphPath = path.join(__dirname, "hitl-demo.graph.yaml");

const mainProvider = createScriptedProvider("main", async (req, ctx) => {
  if (req.tools.some((t) => t.name === "ask_human") && req.prompt.includes("quarterly")) {
    await ctx.invokeTool("ask_human", { question: "What aspect should I focus on?" });
    return {
      output: { text: "Clarified focus area." },
      stopReason: "done",
      usage: { totalTokens: 5 },
    };
  }
  return {
    output: { text: "One-sentence summary with revenue focus." },
    stopReason: "done",
    usage: { totalTokens: 3 },
  };
});

describe("hitl-demo example", () => {
  it("interrupts at approval then at ask_human then completes", async () => {
    const { spec } = await loadGraph(graphPath, { cwd: __dirname });
    if (!spec) throw new Error("no spec");

    const { compileGraph } = await import("@veloxdevworks/flowgraph-core");
    const graph = await compileGraph(spec, {
      cwd: __dirname,
      checkpointer: "memory",
      providers: [mainProvider],
    });

    const first = await graph.run({ threadId: "hitl-ex-1", onInterrupt: "fail" });
    expect(first.status).toBe("interrupted");
    expect(first.interrupts?.[0]?.reason).toContain("Proceed with task");

    const second = await graph.resume({
      threadId: "hitl-ex-1",
      resume: { approved: true },
    });
    expect(second.status).toBe("interrupted");
    expect(second.interrupts?.[0]?.kind).toBe("question");

    const done = await graph.resume({
      threadId: "hitl-ex-1",
      resume: { answer: "Revenue growth" },
    });
    expect(done.status).toBe("completed");
    expect(done.state["result"]).toBeTruthy();
  });
});
