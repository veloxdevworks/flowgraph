import { describe, it, expect, beforeAll } from "vitest";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import type { GraphSpec } from "@flowgraph/spec";
import type { FlowgraphEvent } from "./events.js";

beforeAll(() => {
  registerFunction("hang", async (_input, ctx) => {
    await new Promise<void>((_resolve, reject) => {
      const fail = () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (ctx.signal?.aborted) {
        fail();
        return;
      }
      ctx.signal?.addEventListener("abort", fail, { once: true });
    });
  });
});

function hangSpec(): GraphSpec {
  return {
    metadata: { name: "abort-test" },
    state: { channels: { result: { type: "string" } } },
    nodes: [{ id: "hang", type: "function", with: { fn: "hang", output: { to: "result" } } }],
    edges: [
      { from: "START", to: "hang" },
      { from: "hang", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

describe("run abort", () => {
  it("emits run.aborted and returns status aborted instead of error", async () => {
    const events: FlowgraphEvent[] = [];
    const compiled = await compileGraph(hangSpec(), {
      sinks: [(ev) => {
        events.push(ev);
      }],
    });
    const ac = new AbortController();
    const unsub = compiled.events.subscribe((ev) => {
      if (ev.type === "node.start") ac.abort();
    });

    const result = await compiled.run({ signal: ac.signal });
    unsub();

    expect(result.status).toBe("aborted");
    expect(events.some((e) => e.type === "run.aborted")).toBe(true);
    expect(events.some((e) => e.type === "run.error")).toBe(false);
  });
});
