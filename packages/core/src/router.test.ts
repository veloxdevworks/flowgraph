import { describe, it, expect } from "vitest";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import type { GraphSpec } from "@flowgraph/spec";
import { defineProvider } from "./providers/types.js";

/**
 * Router drives exclusive routing via Command{ goto } alone — no duplicate
 * `branch` edge on `spec.edges` (the historical workaround).
 */
function routerOnlySpec(_flag: string): GraphSpec {
  return {
    metadata: { name: "router-goto" },
    state: {
      channels: {
        flag: { type: "string" },
        path: { type: "string" },
      },
    },
    nodes: [
      {
        id: "route",
        type: "router",
        with: {
          mode: "rules",
          routes: {
            yes: { when: "{{ state.flag == 'yes' }}", to: "take-yes" },
            no: { when: "{{ state.flag == 'no' }}", to: "take-no" },
            default: { default: true, to: "take-no" },
          },
        },
      },
      {
        id: "take-yes",
        type: "function",
        with: { fn: "emitYes", output: { to: "path" } },
      },
      {
        id: "take-no",
        type: "function",
        with: { fn: "emitNo", output: { to: "path" } },
      },
    ],
    edges: [
      { from: "START", to: "route" },
      // No outgoing edges from `route` — Command.goto + ends must drive flow.
      { from: "take-yes", to: "END" },
      { from: "take-no", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

describe("router Command.goto", () => {
  it("offers the default route and its description to the model", async () => {
    const spec = routerOnlySpec("maybe");
    spec.nodes[0]!.provider = "classifier";
    spec.nodes[0]!.with = {
      mode: "model",
      input: "What a lovely sunny day, thanks for the flowers!",
      routes: {
        bills: { to: "take-yes", description: "Payments and invoices" },
        repairs: { to: "take-yes" },
        other: { to: "take-no", default: true, description: "None of the household tasks above" },
      },
    };
    const provider = defineProvider({
      name: "classifier", capabilities: { toolCalling: false, structuredOutput: true, streaming: false },
      async run(req) {
        expect(req.schema).toMatchObject({ properties: { route: { enum: ["bills", "repairs", "other"] } } });
        expect(req.prompt).toContain("None of the household tasks above");
        expect(req.prompt).toContain("default: choose when no other route fits");
        return { output: { route: "other" }, stopReason: "done" };
      },
    });
    const compiled = await compileGraph(spec, { providers: [provider] });
    const result = await compiled.run();
    expect(result.status).toBe("completed");
    expect(result.state.path).toBe("no");
  });

  it("sends the model only its rendered input, not the whole state", async () => {
    const spec = routerOnlySpec("maybe");
    spec.state!.channels!["note"] = { type: "string" };
    spec.nodes[0]!.provider = "classifier";
    spec.nodes[0]!.with = {
      mode: "model",
      input: "Request: {{ state.flag }}",
      routes: { yes: { to: "take-yes" }, other: { to: "take-no", default: true } },
    };
    const prompts: string[] = [];
    const provider = defineProvider({
      name: "classifier", capabilities: { toolCalling: false, structuredOutput: true, streaming: false },
      async run(req) {
        prompts.push(req.prompt);
        return { output: { route: "yes" }, stopReason: "done" };
      },
    });
    const compiled = await compileGraph(spec, { providers: [provider] });
    const result = await compiled.run({ input: { flag: "maybe", note: "unrelated-state-value" } });
    expect(result.status).toBe("completed");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Request: maybe");
    expect(prompts[0]).not.toContain("unrelated-state-value");
  });

  it("refuses a model router without input at compile time", async () => {
    const spec = routerOnlySpec("maybe");
    spec.nodes[0]!.provider = "classifier";
    spec.nodes[0]!.with = { mode: "model", routes: { yes: { to: "take-yes" }, other: { to: "take-no", default: true } } };
    await expect(compileGraph(spec, {})).rejects.toThrow(/router mode: model requires input/);
  });

  registerFunction("emitYes", () => "yes");
  registerFunction("emitNo", () => "no");

  it("routes to the matched branch without a duplicate branch edge", async () => {
    const compiled = await compileGraph(routerOnlySpec("yes"), {});
    const started: string[] = [];
    compiled.events.subscribe((e) => {
      if (e.type === "node.start" && typeof (e.data as { nodeId?: string }).nodeId === "string") {
        started.push((e.data as { nodeId: string }).nodeId);
      }
    });

    const r = await compiled.run({ input: { flag: "yes" } });
    expect(r.status).toBe("completed");
    expect(r.state["path"]).toBe("yes");
    expect(started).toContain("take-yes");
    expect(started).not.toContain("take-no");
  });

  it("falls through to the default route", async () => {
    const compiled = await compileGraph(routerOnlySpec("maybe"), {});
    const started: string[] = [];
    compiled.events.subscribe((e) => {
      if (e.type === "node.start" && typeof (e.data as { nodeId?: string }).nodeId === "string") {
        started.push((e.data as { nodeId: string }).nodeId);
      }
    });

    const r = await compiled.run({ input: { flag: "maybe" } });
    expect(r.status).toBe("completed");
    expect(r.state["path"]).toBe("no");
    expect(started).toContain("take-no");
    expect(started).not.toContain("take-yes");
  });

  it("overrides an unconditional fan-out edge from the router", async () => {
    const spec = routerOnlySpec("yes");
    // Simulate the UI bug: parallel fan-out from the router to both targets.
    spec.edges = [
      { from: "START", to: "route" },
      { from: "route", to: ["take-yes", "take-no"] },
      { from: "take-yes", to: "END" },
      { from: "take-no", to: "END" },
    ];

    const compiled = await compileGraph(spec, {});
    const started: string[] = [];
    compiled.events.subscribe((e) => {
      if (e.type === "node.start" && typeof (e.data as { nodeId?: string }).nodeId === "string") {
        started.push((e.data as { nodeId: string }).nodeId);
      }
    });

    const r = await compiled.run({ input: { flag: "yes" } });
    expect(r.status).toBe("completed");
    expect(r.state["path"]).toBe("yes");
    expect(started).toContain("take-yes");
    expect(started).not.toContain("take-no");
  });
});
