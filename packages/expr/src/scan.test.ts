import { describe, expect, it } from "vitest";
import { scanTemplate, soleTemplateExpr } from "./scan.js";
import { collectRefs, renderTemplate } from "./template.js";

/** The regular expressions the scanner replaces, kept here to check it matches them. */
const SPAN_RE = /\{\{([\s\S]*?)\}\}/g;
const SOLE_RE = /^\s*\{\{([\s\S]*?)\}\}\s*$/;

function randomText(seed: number, length: number): string {
  const alphabet = ["{", "}", "{{", "}}", " ", "a", "\n", "\u00a0", "\ufeff", "\t"];
  let x = seed;
  let out = "";
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out += alphabet[x % alphabet.length];
  }
  return out;
}

/** Milliseconds `fn` takes. */
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

const TWO_MB = 2 * 1024 * 1024;

describe("scanTemplate", () => {
  it("finds the spans the lazy regular expression found, on random text", () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const text = randomText(seed, 1 + (seed % 40));
      const expected = [...text.matchAll(SPAN_RE)].map((m) => ({ start: m.index, end: m.index + m[0].length, expr: m[1] }));
      expect(scanTemplate(text).spans, JSON.stringify(text)).toEqual(expected);
      expect(soleTemplateExpr(text), JSON.stringify(text)).toBe(SOLE_RE.exec(text)?.[1]);
    }
  });

  it("handles unclosed, nested and back-to-back braces", () => {
    expect(scanTemplate("a {{ b")).toEqual({ spans: [], unclosedAt: 2 });
    expect(scanTemplate("{{ a }} {{ b")).toEqual({ spans: [{ start: 0, end: 7, expr: " a " }], unclosedAt: 8 });
    expect(scanTemplate("{{ a {{ b }} c }}").spans).toEqual([{ start: 0, end: 12, expr: " a {{ b " }]);
    expect(scanTemplate("{{{a}}}").spans).toEqual([{ start: 0, end: 6, expr: "{a" }]);
    expect(scanTemplate("{{}}{{x}}").spans.map((s) => s.expr)).toEqual(["", "x"]);
    expect(scanTemplate("no braces")).toEqual({ spans: [], unclosedAt: -1 });
    expect(soleTemplateExpr("  {{ a }} {{ b }}\n")).toBe(" a }} {{ b ");
    expect(soleTemplateExpr("{{}")).toBeUndefined();
  });

  it("stays linear on 2 MB of unclosed or repeated braces", () => {
    for (const unit of ["{{ ", "{{", "{{ a }}", "{{ }} {{", "{", "}}"]) {
      const text = unit.repeat(Math.ceil(TWO_MB / unit.length));
      expect(timed(() => scanTemplate(text)), unit).toBeLessThan(500);
      expect(timed(() => soleTemplateExpr(text)), unit).toBeLessThan(500);
    }
  });
});

describe("templates on slow input", () => {
  it("render and analyse 2 MB of unclosed braces quickly, unchanged", () => {
    const text = "x {{ ".repeat(Math.ceil(TWO_MB / 5));
    let rendered: unknown;
    expect(timed(() => (rendered = renderTemplate(text, {})))).toBeLessThan(1000);
    expect(rendered).toBe(text);
    expect(timed(() => collectRefs(text))).toBeLessThan(1000);
  });

  it("renders many closed spans as before", () => {
    const text = "{{ a }}-".repeat(50_000);
    let rendered: unknown;
    expect(timed(() => (rendered = renderTemplate(text, { a: 1 })))).toBeLessThan(1000);
    expect(rendered).toBe("1-".repeat(50_000));
    expect(renderTemplate("{{ a }} {{ b", { a: 1 })).toBe("1 {{ b");
    expect(renderTemplate(" {{ a }}\n", { a: { x: 1 } })).toEqual({ x: 1 });
  });
});
