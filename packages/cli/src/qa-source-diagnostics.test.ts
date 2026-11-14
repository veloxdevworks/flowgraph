import { afterEach, expect, it, vi } from "vitest";
import { printDiagnostics } from "./ui.js";
afterEach(() => vi.restoreAllMocks());
it("prints the declaring agent file instead of blaming the graph", () => {
  const output = vi.spyOn(console, "error").mockImplementation(() => {});
  printDiagnostics(
    [
      {
        severity: "error",
        code: "AGENT_SCHEMA_ERROR",
        message: "name: Expected string",
        file: "/defs/reviewer/AGENT.md",
        path: "name",
      },
    ],
    "/graphs/main.yaml",
  );
  expect(output.mock.calls[0]?.[0]).toContain("/defs/reviewer/AGENT.md:name");
  expect(output.mock.calls[0]?.[0]).not.toContain("/graphs/main.yaml");
});
it("keeps graph locations for diagnostics without an external source", () => {
  const output = vi.spyOn(console, "error").mockImplementation(() => {});
  printDiagnostics(
    [{ severity: "error", code: "NODE_CONFIG_ERROR", message: "bad", path: "nodes.a.with" }],
    "/graphs/main.yaml",
  );
  expect(output.mock.calls[0]?.[0]).toContain("/graphs/main.yaml:nodes.a.with");
});
