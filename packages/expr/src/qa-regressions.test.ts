import { describe, expect, it } from "vitest";
import { evalExpr, parseExpr, renderTemplate } from "./index.js";

describe("PLAT-294: complete expressions and templates", () => {
  it("renders every block and keeps extra closing braces", () => {
    expect(
      renderTemplate("{{ state.first }} {{ state.last }}", {
        state: { first: "Ada", last: "Lovelace" },
      }),
    ).toBe("Ada Lovelace");
    expect(renderTemplate("{{ state.first }}}", { state: { first: "Ada" } })).toBe("Ada}");
  });

  it.each(["2-1", "(2-1)", "state.n-1"])("evaluates subtraction in %s", (expr) => {
    expect(evalExpr(parseExpr(expr), { state: { n: 2 } })).toBe(1);
  });

  it("keeps numeric suffixes on kebab-case names while allowing numeric subtraction", () => {
    expect(
      renderTemplate("{{ state.outputs.generate-topics-2 }}", {
        state: { outputs: { "generate-topics-2": "ok" } },
      }),
    ).toBe("ok");
    expect(evalExpr(parseExpr("[1-1, -2, 3*-2]"), {})).toEqual([0, -2, -6]);
  });

  it("scans quoted delimiters, escapes and object literals", () => {
    expect(renderTemplate('x {{ "}}" }} y', {})).toBe("x }} y");
    expect(renderTemplate('{{ {a: "}}", b: {c: 1}}}}', {})).toEqual({ a: "}}", b: { c: 1 } });
    expect(renderTemplate('{{ "a\\\"}}b" }}', {})).toBe('a"}}b');
  });

  it.each(["1 2", "state.n junk", "1)", "true false"])("rejects trailing input: %s", (expr) => {
    expect(() => parseExpr(expr)).toThrow(/parse error/i);
  });

  it("agrees on spaced and unspaced arithmetic across positive and negative operands", () => {
    for (let a = -10; a <= 10; a++) {
      for (let b = -10; b <= 10; b++) {
        expect(evalExpr(parseExpr(`${a}-${b}`), {})).toBe(a - b);
        expect(evalExpr(parseExpr(`(${a})-(${b})`), {})).toBe(a - b);
      }
    }
  });
});

describe("PLAT-327: own properties and builtin functions only", () => {
  const scope = { state: { obj: { value: 1 }, items: [{ x: 1 }] } };

  it.each([
    "state.obj.constructor",
    "state.obj['constructor']",
    "state.obj.__proto__",
    "get(state.obj, 'constructor')",
    "pick(state.obj, 'constructor').constructor",
  ])("does not expose prototypes through %s", (expr) => {
    expect(evalExpr(parseExpr(expr), scope)).toBeNull();
  });

  it.each(["constructor()", "toString()", "1 |> constructor"])(
    "rejects inherited builtin %s",
    (expr) => {
      expect(() => evalExpr(parseExpr(expr), scope)).toThrow(/unknown.*function/i);
    },
  );

  it("cannot mutate state through a prototype function passed as a callback", () => {
    const obj = { x: 1 };
    expect(() =>
      evalExpr(parseExpr("map(state.items, state.cfg.constructor.assign)"), {
        state: { items: [obj], cfg: {} },
      }),
    ).toThrow();
    expect(obj).toEqual({ x: 1 });
  });

  it("keeps own JSON keys and array indexing available", () => {
    const value = JSON.parse('{"constructor":"data","__proto__":{"safe":true}}');
    expect(evalExpr(parseExpr("state.value.constructor"), { state: { value } })).toBe("data");
    expect(evalExpr(parseExpr("state.value['__proto__'].safe"), { state: { value } })).toBe(true);
    expect(evalExpr(parseExpr("state.items[-1].x"), scope)).toBe(1);
    expect(evalExpr(parseExpr("has(state.obj, 'constructor')"), scope)).toBe(false);
  });
});
