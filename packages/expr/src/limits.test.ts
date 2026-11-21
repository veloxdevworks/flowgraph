import { describe, expect, it } from "vitest";
import { renderTemplate } from "./template.js";
const MAX_EVAL_STEPS = 1_000_000;
const MAX_RANGE_LENGTH = 10_000, MAX_REPLACE_LENGTH = 16 * 1024 * 1024;

const render = (template: string, scope: Record<string, unknown> = {}) => renderTemplate(template, scope);

describe("range()", () => {
  it("counts from 0 with one argument", () => {
    expect(render("{{ range(5) }}")).toEqual([0, 1, 2, 3, 4]);
    expect(render("{{ range(0) }}")).toEqual([]);
  });

  it("keeps start, end and step", () => {
    expect(render("{{ range(2, 5) }}")).toEqual([2, 3, 4]);
    expect(render("{{ range(5, 0, -2) }}")).toEqual([5, 3, 1]);
    expect(render("{{ range(0, 5, 0) }}")).toEqual([]);
    expect(render("{{ range(5, 2) }}")).toEqual([]);
  });

  it(`refuses more than ${MAX_RANGE_LENGTH} items without building them`, () => {
    expect(render(`{{ len(range(${MAX_RANGE_LENGTH})) }}`)).toBe(MAX_RANGE_LENGTH);
    expect(() => render(`{{ range(${MAX_RANGE_LENGTH + 1}) }}`)).toThrow(/range: at most 10000 items/);
    expect(() => render("{{ len(range(0, 1000000000)) }}")).toThrow(/range: at most/);
    expect(() => render("{{ range(0, state.n) }}", { state: { n: Infinity } })).toThrow(/unbounded/);
  });
});

describe("pipe callbacks", () => {
  it("map, filter and find take a quoted callback after |>", () => {
    expect(render("{{ [1, 2, 3] |> map('item * 2') }}")).toEqual([2, 4, 6]);
    expect(render("{{ [1, 2, 3] |> filter('item > 1') }}")).toEqual([2, 3]);
    expect(render("{{ state.xs |> find('item.id == 2') }}", { state: { xs: [{ id: 1 }, { id: 2 }] } })).toEqual({ id: 2 });
    expect(render("{{ ['a', 'b'] |> map('index') }}")).toEqual([0, 1]);
  });

  it("rejects a callback that is not a quoted string", () => {
    expect(() => render("{{ [1] |> map(state.f) }}", { state: { f: "item" } })).toThrow(/callback must be a quoted expression string/);
  });
});

describe("evaluation budget", () => {
  it("stops nested work that would build a hundred million items", () => {
    expect(() => render("{{ len(map(range(0, 10000), 'range(0, 10000)')) }}")).toThrow(
      new RegExp(`exceeds ${MAX_EVAL_STEPS} evaluation steps`),
    );
  });

  it("counts string sizes, so callbacks cannot pile up copies of large text", () => {
    const big = "x".repeat(1_000_000);
    expect(() => render("{{ len(map(range(0, 10000), 'state.big + state.big')) }}", { state: { big } })).toThrow(
      /evaluation steps/,
    );
  });

  it("charges linear scans inside callbacks", () => {
    const list = Array.from({ length: 200_000 }, (_, i) => i);
    expect(() => render("{{ len(filter(range(0, 10000), 'includes(state.list, -1)')) }}", { state: { list } })).toThrow(
      /evaluation steps/,
    );
  });

  it("allows ordinary work over thousands of items", () => {
    expect(render("{{ len(map(range(0, 10000), 'item * 2')) }}")).toBe(10000);
    const items = Array.from({ length: 2000 }, (_, i) => ({ name: `n${i}` }));
    expect(render("{{ join(map(state.items, 'item.name'), ',') }}", { state: { items } })).toHaveLength(
      items.map((i) => i.name).join(",").length,
    );
  });

  it("gives every top-level evaluation its own budget", () => {
    const template = "{{ len(map(range(0, 10000), 'range(0, 40)')) }}";
    for (let i = 0; i < 3; i++) expect(render(template)).toBe(10000);
  });
});

describe("replace()", () => {
  it("refuses a result that would grow past the limit before building it", () => {
    const s = "y".repeat(100_000);
    expect(() => render("{{ len(replace(state.s, '', state.s)) }}", { state: { s } })).toThrow(
      new RegExp(`longer than ${MAX_REPLACE_LENGTH} characters`),
    );
    expect(render("{{ replace('a-b-c', '-', '+') }}")).toBe("a+b+c");
  });
});
