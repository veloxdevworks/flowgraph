import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as url from "node:url";
import { runGraphFile } from "@veloxdevworks/flowgraph-testing";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const graphPath = path.join(__dirname, "parallel-fanout.graph.yaml");

describe("reducers example", () => {
  it("append fan-out accumulates parallel branch tags", async () => {
    const result = await runGraphFile(graphPath, { cwd: __dirname });
    expect(result.status).toBe("completed");
    expect([...(result.state.tags as string[])].sort()).toEqual(["alpha", "beta"]);
  });

  it("custom uniqueById reducer dedupes findings by id", async () => {
    const dedupePath = path.join(__dirname, "custom-reducer.graph.yaml");
    const result = await runGraphFile(dedupePath, { cwd: __dirname });
    expect(result.status).toBe("completed");
    const findings = result.state.findings as { id: string; v: number }[];
    expect(findings).toHaveLength(2);
    expect(findings.find((f) => f.id === "a")?.v).toBe(3);
  });
});
