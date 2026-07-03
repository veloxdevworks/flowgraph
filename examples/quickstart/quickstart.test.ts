import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { loadGraph, validateSpec, compileGraph } from "@veloxdevworks/flowgraph-core";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("quickstart example", () => {
  it("slugifies text and computes stats via on-disk skills", async () => {
    const { spec, diagnostics } = await loadGraph(path.join(here, "quickstart.graph.yaml"));
    expect(spec).toBeTruthy();
    expect(validateSpec(spec!).filter((d) => d.severity === "error")).toHaveLength(0);
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    const compiled = await compileGraph(spec!, { cwd: here });
    const r = await compiled.run({ input: { text: "Hello, flowgraph World! Is this real?" } });

    expect(r.status).toBe("completed");
    expect(r.state["slug"]).toBe("hello-flowgraph-world-is-this-real");
    expect(r.state["words"]).toBe(6);
    expect(r.state["sentences"]).toBe(2);
  });

  it("resolves ./skills relative to the graph file when cwd is a parent directory", async () => {
    const { spec } = await loadGraph(path.join(here, "quickstart.graph.yaml"));
    expect(spec).toBeTruthy();

    const compiled = await compileGraph(spec!, {
      cwd: path.join(here, "..", ".."),
      graphPath: path.join(here, "quickstart.graph.yaml"),
    });
    const r = await compiled.run({ input: { text: "Hello world." } });

    expect(r.status).toBe("completed");
    expect(r.state["slug"]).toBe("hello-world");
  });
});
