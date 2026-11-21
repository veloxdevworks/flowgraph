import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGraph } from "./loader.js";
import { compileGraph } from "./compiler.js";
import type { FlowgraphEvent } from "./events.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function write(files: Record<string, unknown>): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "fg-config-env-"));
  dirs.push(d);
  for (const [name, doc] of Object.entries(files)) await writeFile(join(d, name), JSON.stringify(doc));
  return d;
}

function graph(extra: Record<string, unknown>, nodes: unknown[] = [{ id: "noop", type: "function", with: { fn: "noop" } }]) {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "config-env" },
    nodes,
    edges: [
      { from: "START", to: (nodes[0] as { id: string }).id },
      { from: (nodes[0] as { id: string }).id, to: "END" },
    ],
    ...extra,
  };
}

describe("${VAR} expansion in config and runtime", () => {
  it("expands declared names as before: value, fallback, empty, and $${ escapes", async () => {
    vi.stubEnv("FGQA_CFG_SET", "from-env");
    const d = await write({
      "g.yaml": graph({
        secrets: ["FGQA_CFG_SET", "FGQA_CFG_UNSET"],
        config: {
          vars: {
            set: "${FGQA_CFG_SET}",
            fallback: "${FGQA_CFG_UNSET:-fallback}",
            empty: "x${FGQA_CFG_UNSET}y",
            escaped: "$${FGQA_CFG_SET}",
            escapedUndeclared: "$${FGQA_CFG_OTHER}",
          },
        },
      }),
    });
    const r = await loadGraph(join(d, "g.yaml"));
    expect(r.diagnostics).toEqual([]);
    expect(r.spec?.config?.vars).toEqual({
      set: "from-env",
      fallback: "fallback",
      empty: "xy",
      escaped: "${FGQA_CFG_SET}",
      escapedUndeclared: "${FGQA_CFG_OTHER}",
    });
  });

  it("leaves an undeclared name unexpanded and reports SECRET_UNDECLARED at load and compile", async () => {
    vi.stubEnv("FGQA_CFG_UNDECLARED", "must-not-appear");
    const d = await write({
      "g.yaml": graph({
        config: { vars: { a: "${FGQA_CFG_UNDECLARED}", b: ["${FGQA_CFG_UNDECLARED:-dflt}"] } },
        runtime: { checkpoint: { path: "${FGQA_CFG_PATH:-.flowgraph/c.db}" } },
      }),
    });
    const r = await loadGraph(join(d, "g.yaml"));
    expect(r.spec?.config?.vars).toEqual({ a: "${FGQA_CFG_UNDECLARED}", b: ["${FGQA_CFG_UNDECLARED:-dflt}"] });
    expect(r.diagnostics.map((x) => [x.code, x.path, x.message])).toEqual([
      ["SECRET_UNDECLARED", "config.vars.a", '`${FGQA_CFG_UNDECLARED}` reads secret "FGQA_CFG_UNDECLARED", which the graph does not declare. Add FGQA_CFG_UNDECLARED to the top-level secrets: list.'],
      ["SECRET_UNDECLARED", "config.vars.b.0", '`${FGQA_CFG_UNDECLARED:-dflt}` reads secret "FGQA_CFG_UNDECLARED", which the graph does not declare. Add FGQA_CFG_UNDECLARED to the top-level secrets: list.'],
      ["SECRET_UNDECLARED", "runtime.checkpoint.path", '`${FGQA_CFG_PATH:-.flowgraph/c.db}` reads secret "FGQA_CFG_PATH", which the graph does not declare. Add FGQA_CFG_PATH to the top-level secrets: list.'],
    ]);
    await expect(compileGraph(r.spec!, { cwd: d })).rejects.toThrow(
      'config.vars.a: `${FGQA_CFG_UNDECLARED}` reads secret "FGQA_CFG_UNDECLARED", which the graph does not declare',
    );
  });

  it("checks an inline subgraph against its own list", async () => {
    vi.stubEnv("FGQA_CFG_PARENT", "parent-value");
    vi.stubEnv("FGQA_CFG_CHILD", "child-value");
    const child = (vars: Record<string, string>, secrets: string[]) =>
      graph({ secrets, config: { vars } }, [{ id: "inner", type: "function", with: { fn: "noop" } }]);
    const d = await write({
      "g.yaml": graph({ secrets: ["FGQA_CFG_PARENT"], config: { vars: { p: "${FGQA_CFG_PARENT}" } } }, [
        { id: "own", type: "subgraph", spec: child({ c: "${FGQA_CFG_CHILD}" }, ["FGQA_CFG_CHILD"]) },
        { id: "borrowed", type: "subgraph", spec: child({ c: "${FGQA_CFG_PARENT}" }, []) },
      ]),
    });
    const r = await loadGraph(join(d, "g.yaml"));
    expect(r.spec?.config?.vars).toEqual({ p: "parent-value" });
    expect(r.spec?.nodes[0]?.spec?.config?.vars).toEqual({ c: "child-value" });
    expect(r.spec?.nodes[1]?.spec?.config?.vars).toEqual({ c: "${FGQA_CFG_PARENT}" });
    expect(r.diagnostics.map((x) => [x.code, x.path])).toEqual([["SECRET_UNDECLARED", "nodes.borrowed.spec.config.vars.c"]]);
  });

  it("checks a file subgraph against its own list and refuses it when it compiles", async () => {
    vi.stubEnv("FGQA_CFG_PARENT", "parent-value");
    const d = await write({
      "child.graph.yaml": graph({ config: { vars: { c: "${FGQA_CFG_PARENT}" } } }),
      "g.yaml": graph({ secrets: ["FGQA_CFG_PARENT"] }, [{ id: "sub", type: "subgraph", uses: "./child.graph.yaml" }]),
    });
    const r = await loadGraph(join(d, "g.yaml"));
    expect(r.diagnostics.map((x) => [x.code, x.path])).toEqual([["SECRET_UNDECLARED", "config.vars.c"]]);
    const child = await loadGraph(join(d, "child.graph.yaml"));
    await expect(compileGraph(child.spec!, { cwd: d })).rejects.toThrow('reads secret "FGQA_CFG_PARENT"');
    const run = await (await compileGraph(r.spec!, { cwd: d })).run({});
    expect(run.status).toBe("error");
    expect(run.error?.message).toContain('reads secret "FGQA_CFG_PARENT", which the graph does not declare');
  });

  it("redacts expanded values like other declared secrets, but not graph-authored fallbacks", async () => {
    vi.stubEnv("FGQA_CFG_TOKEN", "config-token-value-1234");
    const d = await write({
      "g.yaml": graph(
        {
          secrets: ["FGQA_CFG_TOKEN", "FGQA_CFG_UNSET"],
          config: { vars: { token: "${FGQA_CFG_TOKEN}", label: "${FGQA_CFG_UNSET:-public-label-value}" } },
          state: { channels: { out: { type: "object" } } },
        },
        [
          {
            id: "echo",
            type: "script",
            with: {
              code: "export default async input => input;",
              input: { token: "{{ config.vars.token }}", label: "{{ config.vars.label }}" },
              output: { to: "out" },
            },
          },
        ],
      ),
    });
    const r = await loadGraph(join(d, "g.yaml"));
    expect(r.diagnostics).toEqual([]);
    const events: FlowgraphEvent[] = [];
    const compiled = await compileGraph(r.spec!, { cwd: d, sinks: [(e) => { events.push(e); }] });
    const run = await compiled.run({});
    expect(run.status).toBe("completed");
    expect(run.state["out"]).toEqual({ token: "[REDACTED]", label: "public-label-value" });
    expect(JSON.stringify(events)).not.toContain("config-token-value-1234");
  });
});
