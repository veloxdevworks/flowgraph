/**
 * Registers deterministic functions and runs the triage-issue example.
 * The ticket is now created via the mock-create-ticket SKILL.
 */
import * as path from "node:path";
import * as url from "node:url";
import { loadGraph, validateSpec, compileGraph, registerFunction, consoleSink } from "@veloxdevworks/flowgraph-core";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// The classify step is still a code node (pure function, no side effects)
registerFunction("classifyIssue", (input) => {
  const { title = "", body = "" } = input;
  const text = `${title} ${body}`.toLowerCase();
  if (/\b(bug|error|fail|crash|broken|fix)\b/.test(text)) return "bug";
  if (/\b(feature|request|add|enhancement|improve)\b/.test(text)) return "feature";
  return "question";
});

const graphFile = path.join(__dirname, "triage.graph.yaml");
const { spec, diagnostics } = await loadGraph(graphFile);

if (!spec) {
  console.error("Failed to load graph:", diagnostics);
  process.exit(2);
}

const lintDiags = validateSpec(spec);
if (lintDiags.some((d) => d.severity === "error")) {
  console.error("Graph errors:", lintDiags.filter((d) => d.severity === "error"));
  process.exit(2);
}

const compiled = await compileGraph(spec, {
  cwd: __dirname,
  sinks: [consoleSink({ format: "pretty" })],
});

const result = await compiled.run({
  input: {
    issue: {
      title: "Fix: auth token not refreshing on 401",
      body: "When the auth token expires, the client gets a 401 error...",
    },
  },
});

console.log("\n--- Result ---");
console.log("Status:  ", result.status);
console.log("Label:   ", result.state.label);
console.log("Ticket:  ", result.state.ticket);
console.log("Duration:", `${result.durationMs}ms`);
