import { describe, it, expect } from "vitest";
import { ChannelSchema, GraphSpecSchema, OutputMappingSchema } from "./index.js";

function messages(value: unknown): string[] {
  const r = OutputMappingSchema.safeParse(value);
  return r.success ? [] : r.error.issues.map((i) => i.message);
}

describe("output mapping forms", () => {
  it("accepts the documented forms", () => {
    for (const ok of [
      "none",
      {},
      { to: "summary" },
      { map: { n: "{{ result.n }}" } },
      { to: "summary", map: { n: "{{ result.n }}" } },
      { to: "summary", raw: false },
      { map: { n: "{{ result.n }}" }, raw: false },
      { to: "summary", raw: true },
    ]) {
      expect(OutputMappingSchema.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
    }
  });

  it("rejects the { none: true } object form and names the replacement", () => {
    const m = messages({ none: true });
    expect(m).toHaveLength(1);
    expect(m[0]).toContain("output: none");
    expect(m[0]).toContain("the none key is not supported");
  });

  it("rejects any none key with the same message, whatever its value", () => {
    for (const value of [false, true, null, "yes", 0]) {
      const m = messages({ none: value });
      expect(m, JSON.stringify(value)).toHaveLength(1);
      expect(m[0]).toBe("the none key is not supported inside an output object; write output: none to write nothing.");
      expect(m[0]).not.toContain("none: true");
    }
  });

  it("rejects none together with to or map", () => {
    for (const bad of [{ none: true, to: "x" }, { none: true, map: { a: "{{ result }}" } }]) {
      const m = messages(bad);
      expect(m).toHaveLength(1);
      expect(m[0]).toContain("cannot be combined with to or map");
    }
  });

  it("rejects raw: false without a projection", () => {
    const r = OutputMappingSchema.safeParse({ raw: false });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.path).toEqual(["raw"]);
    expect(r.error!.issues[0]!.message).toContain("use output: none");
  });

  it("keeps the general message for other invalid values", () => {
    expect(messages("nothing")[0]).toContain('expected "none"');
    expect(messages({ map: { a: ["x"] } })[0]).toContain("Use an expression string");
  });
});

describe("channel reducers", () => {
  it("accepts append and rejects concat with a pointer to append", () => {
    expect(ChannelSchema.safeParse({ type: "array", reducer: "append" }).success).toBe(true);
    const r = ChannelSchema.safeParse({ type: "array", reducer: "concat" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.message).toContain('use "append"');
  });

  it("lists the reducers for an unknown name", () => {
    const r = ChannelSchema.safeParse({ type: "array", reducer: "appendd" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.message).toContain("lastWrite | append | merge | mergeDeep | messages | custom:<name>");
  });

  it("rejects concat in a whole graph", () => {
    const r = GraphSpecSchema.safeParse({
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "g" },
      state: { channels: { items: { type: "array", reducer: "concat" } } },
      nodes: [{ id: "a", type: "function", with: { fn: "x" } }],
      edges: [],
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path.join("."))).toContain("state.channels.items.reducer");
  });
});
