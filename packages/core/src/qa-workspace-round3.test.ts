import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";

it("uses explicit run cwd for relative shell files while honoring runtime.workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fg-workspace-"));
  try {
    const graphDir = join(dir, "my graphs");
    await mkdir(graphDir);
    await mkdir(join(dir, "family notes"));
    await writeFile(join(dir, "family notes", "Sunday brunch.txt"), "from run folder");
    await mkdir(join(graphDir, "selected workspace", "family notes"), { recursive: true });
    await writeFile(join(graphDir, "selected workspace", "family notes", "Sunday brunch.txt"), "from runtime workspace");
    for (const [workspace, cwd] of [[undefined, dir], [undefined, relative(process.cwd(), dir)], ["./selected workspace", dir]] as const) {
      const spec = {
        metadata: { name: "workspace-round3" },
        nodes: [{ id: "read", type: "shell", with: { command: process.execPath, args: ["-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))", "family notes/Sunday brunch.txt"], output: { to: "result" } } }],
        edges: [{ from: "START", to: "read" }, { from: "read", to: "END" }],
        runtime: { checkpoint: { enabled: false }, ...(workspace ? { workspace } : {}) },
      } as unknown as GraphSpec;
      const compiled = await compileGraph(spec, { cwd, graphPath: join(graphDir, "Sunday brunch.graph.yaml") });
      const result = await compiled.run();
      expect(result.status, String(result.error)).toBe("completed");
      expect(result.state.result).toMatchObject({ stdout: workspace ? "from runtime workspace" : "from run folder" });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
