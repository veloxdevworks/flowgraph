import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { MemorySaver } from "@langchain/langgraph";
import { GraphSpecSchema } from "@flowgraph/spec";
import { loadGraph } from "./loader.js";
import { compileGraph } from "./compiler.js";
import { inspectThreadReplay } from "./providers/replay-persistence.js";
import type { FlowgraphEvent } from "./events.js";
const decoy = "fgqa-decoy-output-7431";
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function dir() {
  const d = await mkdtemp(join(tmpdir(), "fg-secret-boundary-"));
  dirs.push(d);
  return d;
}
const spec = (node: unknown, runtime = {}) =>
  GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "secret-boundary" },
    nodes: [{ id: "echo", ...(node as object) }],
    edges: [
      { from: "START", to: "echo" },
      { from: "echo", to: "END" },
    ],
    runtime,
  });
it("PLAT-361: expands only config/runtime values after YAML parsing and preserves shell variables", async () => {
  vi.stubEnv("FGQA_R2_DECOY", decoy);
  const d = await dir();
  const document = spec({
    type: "shell",
    with: { command: "printf '%s' '${FGQA_R2_DECOY:-fallback}'" },
  }) as unknown as Record<string, unknown>;
  document.config = { vars: { value: "${FGQA_R2_DECOY}", escaped: "$${FGQA_R2_DECOY}" } };
  await writeFile(join(d, "flow.yaml"), JSON.stringify(document));
  const result = await loadGraph(join(d, "flow.yaml"));
  expect(result.spec?.nodes[0]?.with?.command).toBe("printf '%s' '${FGQA_R2_DECOY:-fallback}'");
  expect(result.spec?.config?.vars).toEqual({ value: decoy, escaped: "${FGQA_R2_DECOY}" });
});
it.each(["shell", "script", "http"])(
  "PLAT-363: redacts returned secrets from %s state, events, logs, checkpoints and replay",
  async (type) => {
    vi.stubEnv("FGQA_R2_KEY", decoy);
    vi.stubEnv("FLOWGRAPH_LOG_LEVEL", "debug");
    const d = await dir();
    const events: FlowgraphEvent[] = [];
    const logged: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => {
      logged.push(args);
    });
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ echo: req.headers.authorization?.replace(/^Bearer /, "") }));
    });
    let node: unknown;
    if (type === "http") {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const address = server.address() as { port: number };
      node = {
        type: "http",
        with: {
          url: `http://127.0.0.1:${address.port}/`,
          headers: { Authorization: `Bearer ${decoy}` },
        },
      };
    } else if (type === "shell")
      node = {
        type,
        with: {
          command: process.execPath,
          args: ["-e", "process.stdout.write(process.argv[1])", "{{ secret.FGQA_R2_KEY }}"],
        },
      };
    else
      node = {
        type,
        with: {
          code: "export default async function(input) { return {echo:input.value}; }",
          input: { value: "{{ secret.FGQA_R2_KEY }}" },
        },
      };
    const saver = new MemorySaver();
    try {
      const graph = await compileGraph(spec(node), {
        cwd: d,
        checkpointer: saver,
        sinks: [
          (e) => {
            events.push(e);
          },
        ],
      });
      const result = await graph.run({ threadId: "secret" });
      expect(result.status).toBe("completed");
      expect(JSON.stringify(result.state)).not.toContain(decoy);
      expect(JSON.stringify(events)).not.toContain(decoy);
      expect(JSON.stringify(logged)).not.toContain(decoy);
      const history = [];
      for await (const entry of saver.list({ configurable: { thread_id: "secret" } }))
        history.push(entry);
      expect(JSON.stringify(history)).not.toContain(decoy);
      expect(JSON.stringify(await inspectThreadReplay(saver, "secret"))).not.toContain(decoy);
    } finally {
      if (server.listening)
        await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    }
  },
  20000,
);
it("PLAT-363: configured redaction patterns cover events as well as state", async () => {
  const events: FlowgraphEvent[] = [];
  const graph = await compileGraph(
    spec(
      {
        type: "shell",
        with: {
          command: process.execPath,
          args: ["-e", "process.stdout.write('private-fragment-451')"],
        },
      },
      {
        hooks: [{ on: "node:after", do: "redact" }],
        secrets: { redact: { patterns: ["private-fragment-[0-9]+"] } },
      },
    ),
    {
      cwd: await dir(),
      sinks: [
        (e) => {
          events.push(e);
        },
      ],
    },
  );
  const result = await graph.run();
  expect(result.status).toBe("completed");
  expect(JSON.stringify(result.state)).not.toContain("private-fragment-451");
  expect(JSON.stringify(events)).not.toContain("private-fragment-451");
});

it("PLAT-361: environment values cannot inject YAML structure", async () => {
  const value = 'decoy\n  extra: "injected"';
  vi.stubEnv("FGQA_R2_MULTILINE", value);
  const d = await dir();
  const document = spec({ type: "shell", with: { command: "true" } }) as unknown as Record<
    string,
    unknown
  >;
  document.config = { vars: { multiline: "${FGQA_R2_MULTILINE}" } };
  await writeFile(join(d, "flow.yaml"), JSON.stringify(document));
  const loaded = await loadGraph(join(d, "flow.yaml"));
  expect(loaded.spec?.config?.vars?.multiline).toBe(value);
});

it("short secret values do not rewrite unrelated business text", async () => {
  vi.stubEnv("FGQA_R2_SHORT", "on");
  const compiled = await compileGraph(
    spec({
      type: "script",
      with: {
        code: "export default async input => ({value:input.secret,msg:'configuration done on 10 items'});",
        input: { secret: "{{ secret.FGQA_R2_SHORT }}" },
      },
    }),
    { cwd: await dir() },
  );
  const result = await compiled.run();
  expect(result.status).toBe("completed");
  expect(result.state.outputs).toMatchObject({
    echo: { value: "[REDACTED]", msg: "configuration done on 10 items" },
  });
});
it("console levels do not suppress structured log events", async () => {
  vi.stubEnv("FLOWGRAPH_LOG_LEVEL", "silent");
  const events: FlowgraphEvent[] = [];
  const compiled = await compileGraph(
    spec({
      type: "shell",
      with: { command: process.execPath, args: ["-e", "process.stdout.write('ok')"] },
    }),
    {
      cwd: await dir(),
      sinks: [
        (event) => {
          events.push(event);
        },
      ],
    },
  );
  expect((await compiled.run()).status).toBe("completed");
  expect(
    events.some((e) => e.type === "log" && (e.data as { level: string }).level === "debug"),
  ).toBe(true);
});
