import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "../compiler.js";

let fixtureDir = "";

beforeAll(async () => {
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "flowgraph-skill-env-"));
  const skillDir = path.join(fixtureDir, "skills", "env-dump");
  await fs.mkdir(skillDir, { recursive: true });
  const command = [process.execPath, "-e", "process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))"];
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
apiVersion: flowgraph/v1
kind: Skill
name: env-dump
version: 0.1.0
kindOf: command
command: ${JSON.stringify(command)}
env:
  vars:
    - name: FGQA_SKILL_PLAIN
    - name: FGQA_SKILL_SECRET
      secret: true
    - name: FGQA_SKILL_OPTIONAL
      secret: true
      optional: true
---
`,
  );
});

afterAll(async () => {
  if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
});

function graph(secrets: string[]): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "skill-env" },
    secrets,
    nodes: [{ id: "dump", type: "skill", uses: "./skills/env-dump", with: { output: { to: "keys" } } }],
    edges: [
      { from: "START", to: "dump" },
      { from: "dump", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

describe("command skill environment", () => {
  beforeEach(() => {
    vi.stubEnv("FGQA_SKILL_PLAIN", "plain");
    vi.stubEnv("FGQA_SKILL_SECRET", "secret");
    vi.stubEnv("FGQA_SKILL_OPTIONAL", "optional");
    vi.stubEnv("FGQA_SKILL_STRAY", "stray");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("passes the default allowlist, the skill's declared vars and FLOWGRAPH_INPUT only", async () => {
    const result = await (await compileGraph(graph(["FGQA_SKILL_SECRET"]), { cwd: fixtureDir })).run();
    expect(result.status).toBe("completed");
    const keys = result.state["keys"] as string[];
    expect(keys).toEqual(expect.arrayContaining(["FLOWGRAPH_INPUT", "FGQA_SKILL_PLAIN", "FGQA_SKILL_SECRET", "PATH"]));
    expect(keys).not.toContain("FGQA_SKILL_STRAY");
    expect(keys).not.toContain("FGQA_SKILL_OPTIONAL");
  });

  it("passes an optional secret var once the graph declares it", async () => {
    const result = await (
      await compileGraph(graph(["FGQA_SKILL_SECRET", "FGQA_SKILL_OPTIONAL"]), { cwd: fixtureDir })
    ).run();
    expect(result.status).toBe("completed");
    expect(result.state["keys"]).toContain("FGQA_SKILL_OPTIONAL");
  });

  it("fails when a required secret var is not declared by the graph", async () => {
    const result = await (await compileGraph(graph([]), { cwd: fixtureDir })).run();
    expect(result.status).toBe("error");
    expect(result.error?.message).toContain(
      'skill "env-dump" reads secret "FGQA_SKILL_SECRET", which the graph does not declare. Add FGQA_SKILL_SECRET to the top-level secrets: list.',
    );
  });
});
