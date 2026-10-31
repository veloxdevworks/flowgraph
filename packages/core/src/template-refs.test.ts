import { describe, expect, it } from "vitest";
import { reservedInputRefs, reservedTemplateRefs, templateRefs } from "./index.js";
import { referencedRecallIds } from "./memory/recall.js";

const TWO_MB = 2 * 1024 * 1024;
const fill = (unit: string) => unit.repeat(Math.ceil(TWO_MB / unit.length));

/**
 * The fastest of three runs, in ms. A shared CI runner can stall one run on
 * GC or a busy neighbour; quadratic work stays slow on every run.
 */
function timed(fn: () => void): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
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

describe("constant indexes", () => {
  const reads = (expr: string) => templateRefs(`{{ ${expr} }}`).reserved;

  it("follows the string functions a constant index may call", () => {
    expect(reads("state[('_' |> trim) + '_x']")).toBe(true);
    expect(reads("state[upper('_') + '_x']")).toBe(true);
    expect(reads("state[coalesce(null, '__x')]")).toBe(true);
    expect(reads("state['x__y' |> slice(1)]")).toBe(true);
    expect(reads("state['a' |> upper]")).toBe(false);
    // Functions that can grow a string are not evaluated.
    expect(reads("state['a' |> replace('a', '_' + '_')]")).toBe(false);
  });

  it("finds a constant index at any nesting depth", () => {
    let expr = "state['_' + '_x']";
    for (let i = 0; i < 200; i++) expr = `a[${expr}]`;
    expect(reads(expr)).toBe(true);
    let key = "'_x'";
    for (let i = 0; i < 200; i++) key = `('' + ${key})`;
    expect(reads(`state['_' + ${key}]`)).toBe(true);
  });
});

describe("reservedInputRefs", () => {
  it("checks templates in input values like with fields", () => {
    const input = {
      a: "{{ state['\\u005f\\u005fx'] }}",
      b: "{{ state['_' + '_x'] }}",
      c: ["{{ state[('_' |> trim) + '_x'] }}"],
      d: "__x",
      e: "{{ state.x }}",
    };
    expect(reservedInputRefs({ input })).toEqual(["input.a", "input.b", "input.c", "input.d"]);
  });
});
