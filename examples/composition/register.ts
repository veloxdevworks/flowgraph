import { registerFunction } from "@veloxdevworks/flowgraph-core";

registerFunction("square", (input) => {
  const n = (input as { n?: number }).n ?? 0;
  return n * n;
});

registerFunction("sumList", (input) => {
  const values = (input as { values?: number[] }).values ?? [];
  return values.reduce((a, b) => a + b, 0);
});

export {};
