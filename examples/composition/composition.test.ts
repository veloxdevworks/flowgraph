import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as url from "node:url";
import { runGraphFile, eventsOfType } from "@veloxdevworks/flowgraph-testing";
import "./register.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const graphPath = path.join(__dirname, "sum-of-squares.graph.yaml");

describe("composition example (map + subgraph)", () => {
  it("squares each number via a subgraph and sums them", async () => {
    const result = await runGraphFile(graphPath, {
      cwd: __dirname,
      input: { numbers: [1, 2, 3, 4] },
    });

    expect(result.status).toBe("completed");
    expect(result.state.squares).toEqual([1, 4, 9, 16]);
    expect(result.state.total).toBe(30);
  });

  it("handles an empty collection", async () => {
    const result = await runGraphFile(graphPath, { cwd: __dirname, input: { numbers: [] } });
    expect(result.status).toBe("completed");
    expect(result.state.squares).toEqual([]);
    expect(result.state.total).toBe(0);
  });

  it("emits a node.output event describing the fan-out", async () => {
    const result = await runGraphFile(graphPath, { cwd: __dirname, input: { numbers: [5] } });
    const outputs = eventsOfType(result.events, "node.output");
    const mapEvent = outputs.find((e) => (e.data as { map?: unknown }).map);
    expect(mapEvent).toBeDefined();
    expect((mapEvent!.data as { map: { count: number } }).map.count).toBe(1);
  });
});
