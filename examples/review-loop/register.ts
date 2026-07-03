import { registerFunction } from "@veloxdevworks/flowgraph-core";

registerFunction("draftContent", (input) => {
  const { topic = "Untitled", revision = 0 } = input as { topic?: string; revision?: number };
  const suffix = revision > 0 ? ` (revision ${revision})` : "";
  return `Draft${suffix}: ${topic} — clear, concise, ready for review.`;
});

registerFunction("reviseContent", (input) => {
  const { draft = "" } = input as { draft?: string };
  return `${draft}\n\n[Revised for clarity and tone.]`;
});

registerFunction("finalizeContent", (input) => {
  const { draft = "" } = input as { draft?: string };
  return `FINAL: ${draft}`;
});

export {};
