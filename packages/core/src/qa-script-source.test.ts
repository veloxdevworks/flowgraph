import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphSpecSchema, ScriptWithSchema } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "fg-script-source-"));
  dirs.push(dir);
  return dir;
}
function graph(withConfig: Record<string, unknown>) {
  return GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "script-source" },
    state: { channels: { value: { type: "number" }, answer: { type: "object" } } },
    nodes: [{ id: "transform", type: "script", with: { ...withConfig, output: { to: "answer" } } }],
    edges: [
      { from: "START", to: "transform" },
      { from: "transform", to: "END" },
    ],
  });
}

it("requires exactly one nonempty inline or file source", () => {
  expect(ScriptWithSchema.safeParse({ file: "./transform.mjs" }).success).toBe(true);
  for (const value of [
    {},
    { file: " " },
    { code: " " },
    { code: "export default () => 1", file: "./x.mjs" },
  ]) {
    expect(ScriptWithSchema.safeParse(value).success).toBe(false);
  }
});

it("preserves structured input values and renders nested templates", async () => {
  const compiled = await compileGraph(
    graph({
      code: "export default input => input;",
      input: {
        nested: { value: "{{ state.value }}", enabled: true },
        list: [1, null, { text: "v={{ state.value }}" }],
      },
    }),
  );
  const result = await compiled.run({ input: { value: 7 } });
  expect(result.status).toBe("completed");
  expect(result.state.answer).toEqual({
    nested: { value: 7, enabled: true },
    list: [1, null, { text: "v=7" }],
  });
});

it("loads a script relative to its declaring graph independently of the workspace", async () => {
  const dir = await directory();
  await mkdir(join(dir, "scripts"));
  await mkdir(join(dir, "workspace"));
  await writeFile(
    join(dir, "scripts/transform.mjs"),
    "export default input => ({ doubled: input.value * 2 });",
  );
  const spec = graph({ file: "./scripts/transform.mjs", input: { value: "{{ state.value }}" } });
  spec.runtime = { workspace: "./workspace" };
  const compiled = await compileGraph(spec, { graphPath: join(dir, "flow.yaml"), cwd: dir });
  const result = await compiled.run({ input: { value: 6 } });
  expect(result.status, String(result.error)).toBe("completed");
  expect(result.state.answer).toEqual({ doubled: 12 });
});

it("attributes missing file errors to the node and source path", async () => {
  const dir = await directory();
  const compiled = await compileGraph(graph({ file: "./missing.mjs" }), { cwd: dir });
  const result = await compiled.run();
  expect(result.status).toBe("error");
  expect(String(result.error)).toContain("transform");
  expect(String(result.error)).toContain(join(dir, "missing.mjs"));
});

it("does not widen the child sandbox when loading source from a file", async () => {
  const dir = await directory();
  const secret = join(dir, "private.txt");
  await writeFile(secret, "not-readable");
  await writeFile(
    join(dir, "read.mjs"),
    `import { readFileSync } from 'node:fs'; export default () => readFileSync(${JSON.stringify(secret)}, 'utf8');`,
  );
  const compiled = await compileGraph(graph({ file: "./read.mjs" }), { cwd: dir });
  const result = await compiled.run();
  expect(result.status).toBe("error");
  expect(String(result.error)).toMatch(/ERR_ACCESS_DENIED|restricted/);
});

it("enforces the host's script file policy before opening a source", async () => {
  await expect(
    compileGraph(graph({ file: "/not-read.mjs" }), {
      nodePolicy: { blockScriptFiles: true },
    }),
  ).rejects.toMatchObject({ code: "SCRIPT_FILE_BLOCKED" });
});
