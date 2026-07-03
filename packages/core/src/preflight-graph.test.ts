import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { compileGraph } from "./compiler.js";
import { preflightGraphSkills } from "./preflight-graph.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import type { FlowgraphEvent } from "./events.js";

let fixtureDir = "";

beforeAll(async () => {
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "flowgraph-preflight-"));
  const skillDir = path.join(fixtureDir, "skills", "needs-secret");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
apiVersion: flowgraph/v1
kind: Skill
name: needs-secret
version: 0.1.0
kind_of: command
command: ["echo", "ok"]
env:
  vars:
    - name: FLOWGRAPH_TEST_REQUIRED_SECRET
      required: true
---
`,
  );
  await fs.writeFile(path.join(skillDir, "handler.js"), "export default () => ({});\n");
});

afterAll(async () => {
  if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
});

function graphSpec(): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "preflight-graph" },
    state: { channels: { out: { type: "string" } } },
    nodes: [
      {
        id: "use-skill",
        type: "skill",
        uses: "./skills/needs-secret",
        with: { output: { to: "out" } },
      },
    ],
    edges: [
      { from: "START", to: "use-skill" },
      { from: "use-skill", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

describe("preflightGraphSkills", () => {
  const saved = process.env["FLOWGRAPH_TEST_REQUIRED_SECRET"];

  afterAll(() => {
    if (saved === undefined) delete process.env["FLOWGRAPH_TEST_REQUIRED_SECRET"];
    else process.env["FLOWGRAPH_TEST_REQUIRED_SECRET"] = saved;
  });

  it("fails when a required skill env var is missing", async () => {
    delete process.env["FLOWGRAPH_TEST_REQUIRED_SECRET"];
    const result = await preflightGraphSkills(graphSpec(), { cwd: fixtureDir });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "ENV_VAR_MISSING")).toBe(true);
  });

  it("passes when required env is set", async () => {
    process.env["FLOWGRAPH_TEST_REQUIRED_SECRET"] = "present";
    const result = await preflightGraphSkills(graphSpec(), { cwd: fixtureDir });
    expect(result.ok).toBe(true);
  });

  it("blocks run before any node.start when preflight fails", async () => {
    delete process.env["FLOWGRAPH_TEST_REQUIRED_SECRET"];
    const pf = await preflightGraphSkills(graphSpec(), { cwd: fixtureDir });
    expect(pf.ok).toBe(false);

    const events: FlowgraphEvent[] = [];
    if (pf.ok) {
      const compiled = await compileGraph(graphSpec(), {
        cwd: fixtureDir,
        sinks: [(ev) => { events.push(ev); }],
      });
      await compiled.run({});
    }

    expect(events.filter((e) => e.type === "node.start")).toHaveLength(0);
  });
});
