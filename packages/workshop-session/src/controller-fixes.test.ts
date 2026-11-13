import { describe, expect, it } from "vitest";
import { WorkshopController } from "./controller.js";
import { unsetPath } from "./draft.js";
import type { WorkshopContract } from "@flowgraph/spec";

const contract: WorkshopContract = {
  mode: "workshop",
  agenda: [],
  fallback: "form",
  schema: {
    type: "object",
    required: ["title"],
    properties: { title: { type: ["string", "null"] }, notes: { type: "string" } },
  },
};

describe("controller agrees with the engine on missing fields", () => {
  it("treats null as present, like validateJsonSchema", () => {
    const c = new WorkshopController(contract);
    c.setField("title", null);
    const check = c.check();
    expect(check.missing).toEqual([]);
    expect(check.complete).toBe(true);
  });

  it("reports an absent required field as missing", () => {
    const c = new WorkshopController(contract);
    expect(c.check().missing).toEqual(["title"]);
  });
});

describe("unsetField", () => {
  it("removes an optional field and is a no-op when absent", () => {
    const c = new WorkshopController(contract);
    c.setField("notes", "x");
    c.unsetField("notes");
    expect(c.state.draft).toEqual({});
    c.unsetField("notes");
    expect(c.state.draft).toEqual({});
  });

  it("removes nested values and array items without mutating the input", () => {
    const draft = { a: { b: 1, c: 2 }, list: ["x", "y", "z"] };
    expect(unsetPath(draft, "a.b")).toEqual({ a: { c: 2 }, list: ["x", "y", "z"] });
    expect(unsetPath(draft, "list.1")).toEqual({ a: { b: 1, c: 2 }, list: ["x", "z"] });
    expect(draft).toEqual({ a: { b: 1, c: 2 }, list: ["x", "y", "z"] });
  });

  it("refuses prototype keys", () => {
    expect(() => unsetPath({}, "__proto__")).toThrow();
  });
});
