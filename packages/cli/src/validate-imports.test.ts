import { existsSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const bin = resolve(import.meta.dirname, "../dist/bin.js");

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "fg-validate-imports-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "pwn.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(new URL("./import-executed.txt", import.meta.url), "executed\\n");',
      "export default {",
      '  type: "pwn-node",',
      "  configSchema: { safeParse: () => ({ success: true, data: {} }) },",
      "  build: () => async () => ({}),",
      "};",
      "",
    ].join("\n"),
  );
  return dir;
}

function validate(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, [bin, "validate", ...args], {
    cwd: dir,
    encoding: "utf8",
    timeout: 20_000,
  });
}

const shellGraph = {
  apiVersion: "flowgraph/v1",
  kind: "Graph",
  metadata: { name: "side-effect-import" },
  imports: [{ nodes: "./pwn.mjs" }],
  nodes: [{ id: "x", type: "shell", with: { command: "echo" } }],
  edges: [
    { from: "START", to: "x" },
    { from: "x", to: "END" },
  ],
};

const pluginGraph = {
  ...shellGraph,
  nodes: [{ id: "x", type: "pwn-node" }],
};

describe("flowgraph validate does not load imports", () => {
  it("does not execute a nodes module while reporting the graph valid", () => {
    const dir = fixture();
    writeFileSync(join(dir, "g.yaml"), JSON.stringify(shellGraph));
    const result = validate(dir, "g.yaml", "--preflight");
    const out = result.stdout + result.stderr;
    expect(result.status, out).toBe(0);
    expect(out).toMatch(/valid/i);
    expect(existsSync(join(dir, "import-executed.txt"))).toBe(false);
  });

  it("reports a plugin type as a warning and does not execute the module", () => {
    const dir = fixture();
    writeFileSync(join(dir, "g.yaml"), JSON.stringify(pluginGraph));
    const result = validate(dir, "g.yaml", "--format", "json", "--preflight");
    const out = result.stdout + result.stderr;
    expect(result.status, out).toBe(0);
    expect(existsSync(join(dir, "import-executed.txt"))).toBe(false);
    const diags = JSON.parse(result.stdout) as Array<{
      code?: string;
      message?: string;
      severity?: string;
    }>;
    expect(diags).toContainEqual(
      expect.objectContaining({
        code: "PLUGIN_TYPE_UNRESOLVED",
        severity: "warning",
        message: expect.stringMatching(/unresolved/),
      }),
    );
  });

  it("exits 2 for an unresolved plugin type when --strict is set", () => {
    const dir = fixture();
    writeFileSync(join(dir, "g.yaml"), JSON.stringify(pluginGraph));
    const result = validate(dir, "g.yaml", "--format", "json", "--strict");
    const out = result.stdout + result.stderr;
    expect(result.status, out).toBe(2);
    expect(existsSync(join(dir, "import-executed.txt"))).toBe(false);
  });

  it("does not execute a reducers module and warns instead of failing", () => {
    const dir = fixture();
    writeFileSync(
      join(dir, "reducers.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(new URL("./reducer-executed.txt", import.meta.url), "executed\\n");',
        "export default { uniqueById: (cur, inc) => inc ?? cur };",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "g.yaml"),
      JSON.stringify({
        apiVersion: "flowgraph/v1",
        kind: "Graph",
        metadata: { name: "reducer-import" },
        imports: [{ reducers: "./reducers.mjs" }],
        state: { channels: { items: { type: "array", reducer: "custom:uniqueById" } } },
        nodes: [{ id: "x", type: "shell", with: { command: "echo" } }],
        edges: [
          { from: "START", to: "x" },
          { from: "x", to: "END" },
        ],
      }),
    );
    const result = validate(dir, "g.yaml", "--format", "json");
    const out = result.stdout + result.stderr;
    expect(result.status, out).toBe(0);
    expect(existsSync(join(dir, "reducer-executed.txt"))).toBe(false);
    const diags = JSON.parse(result.stdout) as Array<{ code?: string; severity?: string }>;
    expect(diags).toContainEqual(
      expect.objectContaining({ code: "UNREGISTERED_REDUCER", severity: "warning" }),
    );
  });

  it("still errors on an unknown type when no nodes import is declared", () => {
    const dir = fixture();
    writeFileSync(
      join(dir, "g.yaml"),
      JSON.stringify({
        ...shellGraph,
        imports: undefined,
        nodes: [{ id: "x", type: "not-a-real-type" }],
      }),
    );
    const result = validate(dir, "g.yaml", "--format", "json");
    const out = result.stdout + result.stderr;
    expect(result.status, out).toBe(2);
    const diags = JSON.parse(result.stdout) as Array<{ code?: string; severity?: string }>;
    expect(diags).toContainEqual(
      expect.objectContaining({ code: "UNKNOWN_NODE_TYPE", severity: "error" }),
    );
  });
});
