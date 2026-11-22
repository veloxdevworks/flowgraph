import { describe, expect, it } from "vitest";
import { checkWorkshopOutput, uncoveredAgendaItems } from "./workshop-output.js";

const schema = { type: "object", required: ["title"], properties: { title: { type: "string" } } };
const agenda = [{ id: "scope" }, { id: "risks" }];

describe("checkWorkshopOutput coverage", () => {
  it("ignores coverage unless requireCoverage is set", () => {
    expect(checkWorkshopOutput({ title: "x" }, { schema, agenda, coverage: {} })).toEqual({ complete: true });
  });

  it("rejects a completed output with uncovered agenda items", () => {
    const check = checkWorkshopOutput(
      { title: "x" },
      { schema, agenda, coverage: { scope: true }, requireCoverage: true },
    );
    expect(check.complete).toBe(false);
    expect(check.error).toMatch(/not covered: risks/);
  });

  it("accepts full coverage", () => {
    const check = checkWorkshopOutput(
      { title: "x" },
      { schema, agenda, coverage: { scope: true, risks: "notes" }, requireCoverage: true },
    );
    expect(check).toEqual({ complete: true });
  });

  it("exempts early ends when allowPartial is set", () => {
    const check = checkWorkshopOutput(
      { title: "x" },
      { schema, agenda, coverage: {}, requireCoverage: true, allowPartial: true, endedReason: "timeout" },
    );
    expect(check).toEqual({ complete: false });
  });

  it("lists uncovered ids", () => {
    expect(uncoveredAgendaItems(agenda, { scope: "", risks: true })).toEqual(["scope"]);
  });
});
