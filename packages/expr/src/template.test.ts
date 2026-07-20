import { describe, expect, it } from "vitest";
import { renderTemplate } from "./template.js";

describe("renderTemplate", () => {
  it("returns the typed value for a sole expression (no surrounding text)", () => {
    expect(renderTemplate("{{ state.brief }}", { state: { brief: { a: 1 } } })).toEqual({ a: 1 });
    expect(renderTemplate("{{ state.n }}", { state: { n: 5 } })).toBe(5);
  });

  it("interpolates strings and primitives unchanged inside surrounding text", () => {
    expect(renderTemplate("Hello {{ name }}!", { name: "World" })).toBe("Hello World!");
    expect(renderTemplate("Count: {{ n }}", { n: 5 })).toBe("Count: 5");
    expect(renderTemplate("Done: {{ ok }}", { ok: true })).toBe("Done: true");
  });

  it("renders null/undefined as empty string inside surrounding text", () => {
    expect(renderTemplate("Brief: {{ missing }}", {})).toBe("Brief: ");
  });

  it("serializes objects as JSON instead of '[object Object]' when mixed with text", () => {
    const scope = { state: { weeklyBrief: { answer: "Solo creator, tech niche" } } };
    expect(renderTemplate("Brief: {{ state.weeklyBrief }}", scope)).toBe(
      'Brief: {"answer":"Solo creator, tech niche"}',
    );
  });

  it("serializes arrays as JSON instead of a lossy comma join when mixed with text", () => {
    const scope = { state: { topics: ["a", "b", "c"] } };
    expect(renderTemplate("Topics: {{ state.topics }}", scope)).toBe('Topics: ["a","b","c"]');
  });

  it("resolves kebab-case node ids in dotted member access (state.outputs.<id>)", () => {
    // Node ids conventionally use kebab-case (e.g. "generate-topics"). Without
    // special handling, the lexer reads `generate-topics` as `generate MINUS
    // topics`, silently evaluating to 0 instead of looking up the output.
    const scope = { state: { outputs: { "generate-topics": "5 ranked topic ideas..." } } };
    expect(renderTemplate("{{ state.outputs.generate-topics }}", scope)).toBe(
      "5 ranked topic ideas...",
    );
    expect(renderTemplate("Context: {{ state.outputs.generate-topics }} end", scope)).toBe(
      "Context: 5 ranked topic ideas... end",
    );
  });

  it("still treats spaced-out subtraction of member access as subtraction, not property glue", () => {
    expect(renderTemplate("{{ state.n - other }}", { state: { n: 10 }, other: 3 })).toBe(7);
    expect(renderTemplate("{{ 5 - 3 }}", {})).toBe(2);
  });
});
