/**
 * Property-based tests for the Graph spec schema using a small seeded PRNG.
 * Generated well-formed specs must always validate; deliberately malformed
 * variants must always be rejected.
 */

import { describe, it, expect } from "vitest";
import { GraphSpecSchema } from "./schema.js";

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

const RUNS = 200;
const LETTERS = "abcdefghijklmnopqrstuvwxyz";

function kebab(rand: () => number): string {
  const len = 3 + Math.floor(rand() * 8);
  let s = LETTERS[Math.floor(rand() * 26)]!;
  for (let i = 1; i < len; i++) {
    s += rand() < 0.2 ? "-" : LETTERS[Math.floor(rand() * 26)]!;
  }
  return s.replace(/-+$/g, "") || "g";
}

function genValidSpec(rand: () => number): Record<string, unknown> {
  const nNodes = 1 + Math.floor(rand() * 4);
  const ids: string[] = [];
  const nodes: Record<string, unknown>[] = [];
  for (let i = 0; i < nNodes; i++) {
    const id = `n${i}_${kebab(rand)}`;
    ids.push(id);
    nodes.push({ id, type: "function", with: { fn: kebab(rand) } });
  }
  const edges: Record<string, unknown>[] = [{ from: "START", to: ids[0] }];
  for (let i = 0; i < ids.length - 1; i++) edges.push({ from: ids[i], to: ids[i + 1] });
  edges.push({ from: ids[ids.length - 1], to: "END" });

  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: kebab(rand) },
    nodes,
    edges,
  };
}

describe("spec property — well-formed specs validate", () => {
  it("accepts generated valid graph specs", () => {
    const rand = rng(424242);
    for (let i = 0; i < RUNS; i++) {
      const spec = genValidSpec(rand);
      const result = GraphSpecSchema.safeParse(spec);
      if (!result.success) {
        throw new Error(`Expected valid spec to parse: ${JSON.stringify(result.error.issues)}\nspec=${JSON.stringify(spec)}`);
      }
      expect(result.success).toBe(true);
    }
  });
});

describe("spec property — malformed specs are rejected", () => {
  it("rejects wrong apiVersion", () => {
    const rand = rng(7);
    for (let i = 0; i < RUNS; i++) {
      const spec = genValidSpec(rand);
      spec["apiVersion"] = `bad/${Math.floor(rand() * 99)}`;
      expect(GraphSpecSchema.safeParse(spec).success).toBe(false);
    }
  });

  it("rejects non-kebab metadata.name", () => {
    const rand = rng(8);
    for (let i = 0; i < RUNS; i++) {
      const spec = genValidSpec(rand);
      (spec["metadata"] as Record<string, unknown>)["name"] = `Bad_Name_${Math.floor(rand() * 99)}`;
      expect(GraphSpecSchema.safeParse(spec).success).toBe(false);
    }
  });

  it("rejects missing nodes", () => {
    const rand = rng(9);
    for (let i = 0; i < RUNS; i++) {
      const spec = genValidSpec(rand);
      delete spec["nodes"];
      expect(GraphSpecSchema.safeParse(spec).success).toBe(false);
    }
  });
});
