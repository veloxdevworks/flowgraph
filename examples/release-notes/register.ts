/**
 * Registers the functions referenced by release-notes.graph.yaml.
 * Import this module before compiling/running the graph.
 */
import { registerFunction } from "@veloxdevworks/flowgraph-core";

registerFunction("draftNotes", (input) => {
  const { version = "0.0.0" } = input as { version?: string };
  return `# Release ${version}\n\n- Fixes and improvements\n- See commit log for details`;
});

// Requests human approval via a durable interrupt. The resume value supplied by
// the operator (e.g. { approved: true, notes: "..." }) becomes the return value.
registerFunction("requestApproval", (input, ctx) => {
  const { draft } = input as { draft?: string };
  const decision = ctx.interrupt<{ approved?: boolean; notes?: string }>({
    reason: "Approve release notes before publishing?",
    data: { draft },
  });
  return {
    approved: decision?.approved === true,
    notes: decision?.notes ?? draft ?? "",
  };
});

// Publishes exactly once per thread, even if the node replays on resume.
registerFunction("publishNotes", async (input, ctx) => {
  const { notes = "", version = "0.0.0" } = input as { notes?: string; version?: string };
  return ctx.once("publish", () => ({
    url: `https://example.com/releases/${version}`,
    publishedAt: new Date().toISOString(),
    notes,
  }));
});

export {};
