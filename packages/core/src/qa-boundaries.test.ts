import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";

const stubDirs: string[] = [];

function stubHomeAndTmpdir(): { home: string; tmp: string } {
  const home = mkdtempSync(join(tmpdir(), "fgqa-home-"));
  const tmp = mkdtempSync(join(tmpdir(), "fgqa-tmp-"));
  stubDirs.push(home, tmp);
  vi.stubEnv("HOME", home);
  vi.stubEnv("TMPDIR", tmp);
  return { home, tmp };
}

function graph(type: string, config: Record<string, unknown>): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "qa-boundaries" },
    config: { vars: { marker: "configured" } },
    nodes: [{ id: "execute", type, with: { ...config, output: { to: "answer" } } }],
    edges: [
      { from: "START", to: "execute" },
      { from: "execute", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (stubDirs.length > 0) {
    const dir = stubDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("PLAT-297 / PLAT-326: explicit child credentials", () => {
  it("does not pass undeclared host variables into a shell child", async () => {
    vi.stubEnv("FGQA_DECOY", "decoy-only");
    const compiled = await compileGraph(
      graph("shell", {
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.env.FGQA_DECOY ?? 'absent')"],
      }),
    );
    const result = await compiled.run();
    expect(result.status).toBe("completed");
    expect(result.state.answer).toMatchObject({ stdout: "absent" });
  });

  it("passes HOME and TMPDIR into a shell child and keeps a decoy secret absent", async () => {
    const { home, tmp } = stubHomeAndTmpdir();
    vi.stubEnv("FGQA_DECOY", "decoy-only");
    const compiled = await compileGraph(
      graph("shell", {
        command: process.execPath,
        args: [
          "-e",
          "const e = process.env; process.stdout.write(JSON.stringify({ home: e.HOME === process.argv[1], tmpdir: e.TMPDIR === process.argv[2], path: typeof e.PATH === 'string' && e.PATH.length > 0, decoy: e.FGQA_DECOY ?? 'absent' }));",
          home,
          tmp,
        ],
      }),
    );
    const result = await compiled.run();
    expect(result.status).toBe("completed");
    expect(result.state.answer).toMatchObject({
      json: { home: true, tmpdir: true, path: true, decoy: "absent" },
    });
  });

  it("passes HOME and TMPDIR into a script child and keeps a decoy secret absent", async () => {
    const { home, tmp } = stubHomeAndTmpdir();
    vi.stubEnv("FGQA_DECOY", "decoy-only");
    const compiled = await compileGraph(
      graph("script", {
        // Compare against values passed through with.input so the assertion
        // does not hard-code host paths in the script source.
        code: "export default async (input) => ({ home: process.env.HOME === input.home, tmpdir: process.env.TMPDIR === input.tmp, path: typeof process.env.PATH === 'string' && process.env.PATH.length > 0, decoy: process.env.FGQA_DECOY ?? 'absent' });",
        input: { home, tmp },
      }),
    );
    const result = await compiled.run();
    expect(result.status).toBe("completed");
    expect(result.state.answer).toMatchObject({
      home: true,
      tmpdir: true,
      path: true,
      decoy: "absent",
    });
  });

  it("supports explicit inherited variable names and env overrides", async () => {
    vi.stubEnv("FGQA_DECOY", "decoy-only");
    const compiled = await compileGraph(
      graph("shell", {
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.env.FGQA_DECOY + '|' + process.env.EXPLICIT)"],
        inheritEnv: ["FGQA_DECOY"],
        env: { EXPLICIT: "{{ secret.FGQA_DECOY }}" },
      }),
    );
    const result = await compiled.run();
    expect(result.status).toBe("completed");
    expect(result.state.answer).toMatchObject({ stdout: "decoy-only|decoy-only" });
  });

  it("resolves secret templates in the script sandbox", async () => {
    vi.stubEnv("FGQA_DECOY", "decoy-only");
    const compiled = await compileGraph(
      graph("script", {
        code: "export default async () => ({ value: process.env.EXPLICIT, hidden: process.env.FGQA_DECOY ?? null });",
        env: { EXPLICIT: "{{ secret.FGQA_DECOY }}" },
      }),
    );
    const result = await compiled.run();
    expect(result.status).toBe("completed");
    expect(result.state.answer).toMatchObject({ value: "decoy-only", hidden: null });
  });

  it("enforces secret policy for shell nodes", async () => {
    vi.stubEnv("FGQA_DECOY", "decoy-only");
    const compiled = await compileGraph(
      graph("shell", {
        command: "echo",
        args: ["{{ secret.FGQA_DECOY }}"],
      }),
      { nodePolicy: { blockSecrets: true } },
    );
    const result = await compiled.run();
    expect(result.status).toBe("error");
    expect(result.error?.message).toMatch(/secret.*blocked|not allowed/i);
  });
});
