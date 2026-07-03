/**
 * Property-based tests for the expression engine using a small seeded PRNG
 * (deterministic, no external dependency). Each property runs over many
 * generated inputs to catch edge cases parse/eval might miss.
 */

import { describe, it, expect } from "vitest";
import { parseExpr } from "./parser.js";
import { evalExpr } from "./evaluator.js";
import { renderTemplate, evalGuard } from "./template.js";

// --- deterministic PRNG (mulberry32) -----------------------------------------
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RUNS = 300;

// Generate a random arithmetic expression of integers and its expected value.
function genArith(rand: () => number, depth: number): { src: string; value: number } {
  if (depth <= 0 || rand() < 0.35) {
    const n = Math.floor(rand() * 100);
    return { src: String(n), value: n };
  }
  const left = genArith(rand, depth - 1);
  const right = genArith(rand, depth - 1);
  const ops = ["+", "-", "*"] as const;
  const op = ops[Math.floor(rand() * ops.length)]!;
  const value = op === "+" ? left.value + right.value : op === "-" ? left.value - right.value : left.value * right.value;
  return { src: `(${left.src} ${op} ${right.src})`, value };
}

describe("expr property — arithmetic round-trips", () => {
  it("parses and evaluates generated arithmetic to the correct value", () => {
    const rand = rng(12345);
    for (let i = 0; i < RUNS; i++) {
      const { src, value } = genArith(rand, 4);
      const result = evalExpr(parseExpr(src), {});
      expect(result).toBe(value);
    }
  });
});

describe("expr property — comparison guards are boolean", () => {
  it("evalGuard always returns a boolean for generated comparisons", () => {
    const rand = rng(67890);
    for (let i = 0; i < RUNS; i++) {
      const a = Math.floor(rand() * 50);
      const b = Math.floor(rand() * 50);
      const ops = ["==", "!=", "<", "<=", ">", ">="] as const;
      const op = ops[Math.floor(rand() * ops.length)]!;
      const out = evalGuard(`${a} ${op} ${b}`, {});
      expect(typeof out).toBe("boolean");
      // cross-check against JS semantics for these integer comparisons
      const expected =
        op === "==" ? a === b
        : op === "!=" ? a !== b
        : op === "<" ? a < b
        : op === "<=" ? a <= b
        : op === ">" ? a > b
        : a >= b;
      expect(out).toBe(expected);
    }
  });
});

describe("expr property — identifier resolution", () => {
  it("a sole {{ ident }} template returns the typed scope value", () => {
    const rand = rng(2024);
    for (let i = 0; i < RUNS; i++) {
      const key = `v${Math.floor(rand() * 1000)}`;
      const choice = rand();
      const value: unknown = choice < 0.33 ? Math.floor(rand() * 100) : choice < 0.66 ? `s${Math.floor(rand() * 100)}` : rand() < 0.5;
      const out = renderTemplate(`{{ ${key} }}`, { [key]: value });
      expect(out).toBe(value);
    }
  });

  it("never throws (non-strict) on undefined identifiers", () => {
    const rand = rng(999);
    for (let i = 0; i < RUNS; i++) {
      const key = `missing${Math.floor(rand() * 1000)}`;
      expect(() => evalExpr(parseExpr(key), {})).not.toThrow();
    }
  });
});
