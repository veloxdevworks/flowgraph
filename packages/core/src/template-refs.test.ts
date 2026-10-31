import { describe, expect, it } from "vitest";
import { reservedTemplateRefs, templateRefs } from "./index.js";
import { referencedRecallIds } from "./memory/recall.js";

const TWO_MB = 2 * 1024 * 1024;
const fill = (unit: string) => unit.repeat(Math.ceil(TWO_MB / unit.length));

function timed(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

describe("templateRefs", () => {
  it("checks 2 MB templates of unclosed, repeated and nested braces in well under a second", () => {
    const inputs = [
      fill("{{ "),
      fill("{{"),
      fill("{{ a }}"),
      `{{${fill(" {{")}}}`,
      `{{${fill("[")}}}`,
      `{{${fill("a + ")}a}}`,
      fill("{{ state.__x }}"),
    ];
    for (const text of inputs) {
      expect(timed(() => templateRefs(text)), text.slice(0, 12)).toBeLessThan(1000);
      expect(timed(() => reservedTemplateRefs({ with: { prompt: text } })), text.slice(0, 12)).toBeLessThan(1000);
    }
    expect(templateRefs(fill("{{ "))).toEqual({ reserved: false, secret: false });
    expect(templateRefs(fill("{{ state.__x }}")).reserved).toBe(true);
  });

  it("finds reserved reads in closed blocks only", () => {
    expect(templateRefs("{{ a }} {{ state.__x }}").reserved).toBe(true);
    // The first `}}` closes the block, so the inner `{{` is part of its text.
    expect(templateRefs("{{ a {{ state.__x }} }}").reserved).toBe(true);
    // An unclosed block never renders.
    expect(templateRefs("{{ a }} {{ state.__x").reserved).toBe(false);
    expect(templateRefs("see __init__.py").reserved).toBe(false);
  });

  it("finds secret reads in closed blocks and after an unclosed `{{`", () => {
    expect(templateRefs("{{ secret.KEY }}").secret).toBe(true);
    expect(templateRefs("x {{ secrets ['KEY'] }}").secret).toBe(true);
    expect(templateRefs("{{ secret.KEY").secret).toBe(true);
    expect(templateRefs("{{ a }} {{ b {{ secret.KEY").secret).toBe(true);
    expect(templateRefs("{{ a } secret.KEY }}").secret).toBe(true);
    expect(templateRefs("the secret. {{ a }}").secret).toBe(false);
    expect(templateRefs("{{ state.secretive }}").secret).toBe(false);
  });
});

describe("referencedRecallIds", () => {
  it("stays fast on 2 MB of unclosed braces", () => {
    let ids = new Set<string>();
    expect(timed(() => (ids = referencedRecallIds([fill("{{ memory.a ")])))).toBeLessThan(1000);
    expect(ids.size).toBe(0);
    expect(referencedRecallIds(["{{ memory.a }} {{ memory.b"])).toEqual(new Set(["a"]));
  });
});
