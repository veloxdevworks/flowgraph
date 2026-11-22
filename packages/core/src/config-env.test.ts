import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGraph, validateSpec } from "./loader.js";
import { compileGraph } from "./compiler.js";
import { GraphSpecSchema, type GraphSpec } from "@flowgraph/spec";
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

  it("names the file on each file subgraph's diagnostics, so identical ones from two files both show", async () => {
    const d = await write({});
    const { mkdir } = await import("node:fs/promises");
    for (const dir of ["a", "b"]) {
      await mkdir(join(d, dir));
      await writeFile(join(d, dir, "child.yaml"), JSON.stringify(graph({ config: { vars: { c: "${FGQA_CFG_PARENT}" } } })));
    }
    await writeFile(
      join(d, "g.yaml"),
      JSON.stringify(
        graph({}, [
          { id: "first", type: "subgraph", uses: "./a/child.yaml" },
          { id: "second", type: "subgraph", uses: "./b/child.yaml" },
        ]),
      ),
    );
    const r = await loadGraph(join(d, "g.yaml"));
    expect(r.diagnostics.map((x) => [x.file, x.code, x.path])).toEqual([
      [join(d, "a", "child.yaml"), "SECRET_UNDECLARED", "config.vars.c"],
      [join(d, "b", "child.yaml"), "SECRET_UNDECLARED", "config.vars.c"],
    ]);
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
              output: { to: "out" },
            }, input: { token: "{{ config.vars.token }}", label: "{{ config.vars.label }}" },
          },
        ],
      ),
    });
    const r = await loadGraph(join(d, "g.yaml"));
    expect(r.diagnostics).toEqual([]);
    const copies: Array<[string, GraphSpec]> = [
      ["loaded", r.spec!],
      ["structuredClone", structuredClone(r.spec!)],
      ["spread", { ...r.spec!, config: { ...r.spec!.config, vars: { ...r.spec!.config!.vars } } }],
    ];
    for (const [label, spec] of copies) {
      const events: FlowgraphEvent[] = [];
      const compiled = await compileGraph(spec, { cwd: d, sinks: [(e) => { events.push(e); }] });
      const run = await compiled.run({});
      expect(run.status, label).toBe("completed");
      expect(run.state["out"], label).toEqual({ token: "[REDACTED]", label: "public-label-value" });
      expect(JSON.stringify(events), label).not.toContain("config-token-value-1234");
    }
  });

  it("leaves output alone for declared values the config does not contain or that are under 8 characters", async () => {
    vi.stubEnv("FGQA_CFG_TRUE", "true");
    vi.stubEnv("FGQA_CFG_ONE", "1");
    vi.stubEnv("FGQA_CFG_ENV", "production");
    vi.stubEnv("FGQA_CFG_MODE", "default");
    const text = { env: "deploying to production now", mode: "defaults applied", flag: "true", count: "1" };
    const d = await write({
      "g.yaml": graph(
        {
          secrets: ["FGQA_CFG_TRUE", "FGQA_CFG_ONE", "FGQA_CFG_ENV", "FGQA_CFG_MODE"],
          config: { vars: { mode: "${FGQA_CFG_MODE}", flag: "${FGQA_CFG_TRUE}" } },
          state: { channels: { out: { type: "object" } } },
        },
        [{ id: "echo", type: "script", with: { code: "export default async input => input;", output: { to: "out" } }, input: text }],
      ),
    });
    const r = await loadGraph(join(d, "g.yaml"));
    expect(r.diagnostics).toEqual([]);
    expect(r.spec?.config?.vars).toEqual({ mode: "default", flag: "true" });
    for (const spec of [r.spec!, structuredClone(r.spec!)]) {
      const events: FlowgraphEvent[] = [];
      const run = await (await compileGraph(spec, { cwd: d, sinks: [(e) => { events.push(e); }] })).run({});
      expect(run.status).toBe("completed");
      expect(run.state["out"]).toEqual(text);
      expect(JSON.stringify(events)).not.toContain("[REDACTED]");
    }
  });

  it("redacts a value expanded inside an inline subgraph in a copied spec", async () => {
    vi.stubEnv("FGQA_CFG_CHILD_TOKEN", "child-token-value-5678");
    const child = graph(
      {
        secrets: ["FGQA_CFG_CHILD_TOKEN"],
        config: { vars: { token: "${FGQA_CFG_CHILD_TOKEN}" } },
        state: { channels: { out: { type: "object" } } },
      },
      [{ id: "echo", type: "script", with: { code: "export default async input => input;", output: { to: "out" } }, input: { token: "{{ config.vars.token }}" } }],
    );
    const d = await write({
      "g.yaml": graph({ state: { channels: { out: { type: "object" } } } }, [
        { id: "sub", type: "subgraph", spec: child },
      ]),
    });
    const r = await loadGraph(join(d, "g.yaml"));
    expect(r.diagnostics).toEqual([]);
    const events: FlowgraphEvent[] = [];
    const run = await (await compileGraph(structuredClone(r.spec!), { cwd: d, sinks: [(e) => { events.push(e); }] })).run({});
    expect(run.status).toBe("completed");
    expect(run.state["out"]).toEqual({ token: "[REDACTED]" });
    expect(JSON.stringify(events)).not.toContain("child-token-value-5678");
  });
});

describe("compileGraph refuses undeclared ${NAME} in any spec", () => {
  const parse = (doc: unknown) => GraphSpecSchema.parse(doc) as GraphSpec;

  it("refuses a spec built in code, including inside an inline subgraph", async () => {
    const d = await write({});
    await expect(compileGraph(parse(graph({ config: { vars: { a: "x ${FGQA_CFG_CODE}" } } })), { cwd: d })).rejects.toThrow(
      'config.vars.a: `${FGQA_CFG_CODE}` reads secret "FGQA_CFG_CODE", which the graph does not declare',
    );
    const child = graph({ runtime: { checkpoint: { path: "${FGQA_CFG_PARENT}" } } }, [{ id: "inner", type: "function", with: { fn: "noop" } }]);
    const nested = parse(graph({ secrets: ["FGQA_CFG_PARENT"] }, [{ id: "sub", type: "subgraph", spec: child }]));
    await expect(compileGraph(nested, { cwd: d })).rejects.toThrow("nodes.sub.spec.runtime.checkpoint.path: `${FGQA_CFG_PARENT}`");
  });

  it("accepts $${NAME} and a declared name left unexpanded", async () => {
    const d = await write({});
    const spec = parse(graph({ secrets: ["FGQA_CFG_DECLARED"], config: { vars: { a: "$${FGQA_CFG_CODE}", b: "${FGQA_CFG_DECLARED}" } } }));
    await expect(compileGraph(spec, { cwd: d })).resolves.toBeDefined();
  });

  it("refuses a deep copy of a loaded spec, and keeps accepting escapes in a shallow copy", async () => {
    const d = await write({
      "bad.yaml": graph({ config: { vars: { a: "${FGQA_CFG_UNDECLARED}" } } }),
      "escaped.yaml": graph({ config: { vars: { a: "$${FGQA_CFG_UNDECLARED}" } } }),
    });
    const bad = (await loadGraph(join(d, "bad.yaml"))).spec!;
    await expect(compileGraph(structuredClone(bad), { cwd: d })).rejects.toThrow('config.vars.a: `${FGQA_CFG_UNDECLARED}` reads secret');
    const escaped = await loadGraph(join(d, "escaped.yaml"));
    expect(escaped.diagnostics).toEqual([]);
    expect(escaped.spec?.config?.vars).toEqual({ a: "${FGQA_CFG_UNDECLARED}" });
    await expect(compileGraph(escaped.spec!, { cwd: d })).resolves.toBeDefined();
    await expect(compileGraph({ ...escaped.spec! }, { cwd: d })).resolves.toBeDefined();
  });

  it("exempts each escaped occurrence, not every use of the name in the field", async () => {
    const d = await write({
      "mixed.yaml": graph({ config: { vars: { a: "$${FGU}${FGU}", b: "${FGU}$${FGU}" } } }),
      "escaped.yaml": graph({ config: { vars: { a: "$${FGU}-$${FGU}" } } }),
    });
    const mixed = await loadGraph(join(d, "mixed.yaml"));
    expect(mixed.spec?.config?.vars).toEqual({ a: "${FGU}${FGU}", b: "${FGU}${FGU}" });
    expect(mixed.diagnostics.map((x) => [x.code, x.path])).toEqual([
      ["SECRET_UNDECLARED", "config.vars.a"],
      ["SECRET_UNDECLARED", "config.vars.b"],
    ]);
    expect(validateSpec(mixed.spec!).filter((x) => x.code === "SECRET_UNDECLARED").map((x) => x.path)).toEqual(["config.vars.a", "config.vars.b"]);
    await expect(compileGraph(mixed.spec!, { cwd: d })).rejects.toThrow('config.vars.a: `${FGU}` reads secret "FGU"');
    const escaped = await loadGraph(join(d, "escaped.yaml"));
    expect(escaped.diagnostics).toEqual([]);
    await expect(compileGraph(escaped.spec!, { cwd: d })).resolves.toBeDefined();
  });

  it("validateSpec reports the same undeclared placeholders as compileGraph", async () => {
    const spec = parse(graph({ secrets: ["FGQA_CFG_DECLARED"], config: { vars: { a: "${FGQA_CFG_CODE}", b: "$${FGQA_CFG_CODE}", c: "${FGQA_CFG_DECLARED}" } } }));
    expect(validateSpec(spec).filter((x) => x.code === "SECRET_UNDECLARED").map((x) => [x.severity, x.path, x.message])).toEqual([
      ["error", "config.vars.a", '`${FGQA_CFG_CODE}` reads secret "FGQA_CFG_CODE", which the graph does not declare. Add FGQA_CFG_CODE to the top-level secrets: list.'],
    ]);
  });
});
