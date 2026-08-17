# 14 — Programmatic API

Use `@veloxdevworks/flowgraph-core` when you need to embed graphs in an application, register functions dynamically, or wire custom providers and sinks. The CLI is a thin wrapper around this API ([09 — CLI](./09-cli.md)).

## Minimal compile + run

```ts
import { loadGraph, validateSpec, compileGraph, consoleSink } from "@veloxdevworks/flowgraph-core";

const graphPath = "./my.graph.yaml";
const cwd = new URL(".", import.meta.url).pathname;

const { spec, diagnostics } = await loadGraph(graphPath, { cwd });
if (!spec) throw new Error(diagnostics.map((d) => d.message).join("; "));

const lintDiags = validateSpec(spec);
if (lintDiags.some((d) => d.severity === "error")) {
  throw new Error("Graph has validation errors");
}

const compiled = await compileGraph(spec, {
  cwd,
  graphPath,
  sinks: [consoleSink({ format: "pretty" })],
});

const result = await compiled.run({
  input: { issue: { title: "Bug", body: "Something broke" } },
  threadId: "run-1",
  onInterrupt: "fail",
});

console.log(result.status, result.state);
```

## Custom logic: prefer `shell` / `script`, or register `function`

For graph authors, the zero-setup option is a [`shell` node](./03-node-types.md#5-shell--run-a-local-command) — no TypeScript registration required:

```yaml
- id: greet
  type: shell
  with:
    command: echo
    args: ["Hello, {{ input.name }}!"]
    output: { to: message }
```

When embedding flowgraph in a host process, you can still use the legacy `function` node with `registerFunction` for in-process TypeScript handlers:

```ts
import { registerFunction, loadGraph, compileGraph } from "@veloxdevworks/flowgraph-core";

registerFunction("classifyIssue", (input) => {
  const { title = "", body = "" } = input as { title?: string; body?: string };
  const text = `${title} ${body}`.toLowerCase();
  if (/\bbug\b/.test(text)) return "bug";
  return "feature";
});

// Then load + compile as above
```

See [triage-issue](../examples/triage-issue/run.js) for a complete runner script.

## Resume after interrupt

Requires a **injected** durable checkpointer. YAML `runtime.checkpoint.backend: sqlite|postgres` does **not** construct a saver — compile throws unless you pass an instance (or `checkpointer: "none"` for embedding).

```ts
import { createSqliteCheckpointer } from "@veloxdevworks/flowgraph-checkpoint-sqlite";

const compiled = await compileGraph(spec, {
  cwd,
  checkpointer: createSqliteCheckpointer(".flowgraph/checkpoints.db"),
});

// First run — interrupts at HITL gate
await compiled.run({ threadId: "rel-1", input: { version: "1.4.0" }, onInterrupt: "fail" });

// Later — resume with operator decision (HITL)
await compiled.resume({
  threadId: "rel-1",
  resume: { approved: true, notes: "LGTM" },
});

// Continue a paused (non-HITL) thread from its next nodes
await compiled.continueRun({ threadId: "rel-1" });
```

There is no `runGraph` / `resumeFrom` helper. The public API is `compiled.run` / `.resume` / `.continueRun` / `.stream` (plus `getState` / `getStateHistory`).

See [release-notes](../examples/release-notes/register.ts) for `ctx.interrupt()` and `ctx.once()` patterns. The example graph imports `./register.ts` so `flowgraph run` / `resume` work.

## Custom providers

Core exports `mockProvider` but does **not** auto-register it (the CLI does). Pass it in, or define your own:

```ts
import { compileGraph, defineProvider, mockProvider } from "@veloxdevworks/flowgraph-core";

await compileGraph(spec, { providers: [mockProvider] });

const mock = defineProvider({
  name: "mock",
  capabilities: { toolCalling: true, structuredOutput: true, streaming: false },
  async run(req) {
    return {
      output: { text: "mock response" },
      messages: [],
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 },
      stopReason: "done",
    };
  },
});

await compileGraph(spec, { providers: [mock] });
```

Graphs can also declare providers in YAML (`providers:` block) — the CLI builds them automatically. See [08 — Providers](./08-providers.md).

## Events and hooks

```ts
import { compileGraph, consoleSink, jsonlSink } from "@veloxdevworks/flowgraph-core";

const compiled = await compileGraph(spec, {
  sinks: [
    consoleSink({ format: "pretty" }),
    jsonlSink(process.stdout),
  ],
});
```

Hooks from the graph spec (`runtime.hooks`) are applied at compile time. Programmatic hook registration uses `createHookBus` — see [06 — Events & hooks](./06-events-and-hooks.md).

## MCP hub (programmatic)

When not using the CLI, pass an MCP hub to `compileGraph`. `@veloxdevworks/flowgraph-mcp` is a **companion package** — it is **not in this repo and not published** with 0.1. The CLI still has `flowgraph mcp …` commands that lazy-load it when present.

```ts
// Companion — not published with 0.1
import { McpHub } from "@veloxdevworks/flowgraph-mcp";

const mcp = new McpHub({ cwd, servers: spec.mcpServers });
await mcp.connectAll();

const compiled = await compileGraph(spec, { mcp, cwd });
await mcp.close();
```

See [15 — MCP operations](./15-mcp-operations.md).

## Testing with `@veloxdevworks/flowgraph-testing`

The testing package provides an in-memory harness — no CLI, no filesystem checkpoint:

```ts
import { describe, it, expect } from "vitest";
import { runInMemory, runGraphFile, compileForTest, eventsOfType } from "@veloxdevworks/flowgraph-testing";
import "./register.js";  // registerFunction calls

describe("my graph", () => {
  it("completes with expected state", async () => {
    const result = await runGraphFile("./my.graph.yaml", {
      cwd: import.meta.dirname,
      input: { text: "hello" },
    });

    expect(result.status).toBe("completed");
    expect(result.state.slug).toBe("hello");
  });

  it("collects events", async () => {
    const { compiled, events } = await compileForTest(spec);
    await compiled.run({ input: {} });
    expect(events.some((e) => e.type === "run.end")).toBe(true);
  });
});
```

### API reference

| Function | Purpose |
|----------|---------|
| `compileForTest(spec)` | Compile with in-memory checkpointer; returns `{ compiled, events }` |
| `runInMemory(spec, opts)` | Compile + run; collect events |
| `runGraphFile(path, opts)` | Load YAML + imports + run in memory |
| `eventsOfType(events, type)` | Filter events by type in assertions |

Examples using this pattern: [composition](../examples/composition/composition.test.ts), [quickstart](../examples/quickstart/quickstart.test.ts), [release-notes](../examples/release-notes/release-notes.test.ts).

## Planned API (not yet shipped)

- `resumeFrom(checkpointId)` — time-travel resume from a specific checkpoint (do not call this today)
- `CompiledGraph.step()` — superstep debugging
- `flowgraph.config.ts` — project-level auto-registration

`runGraph` / `runGraph.stream` / `runGraph.step` are **not** APIs — use the `CompiledGraph` methods above.

See [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md).
