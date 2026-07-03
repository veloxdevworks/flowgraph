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

## Registering `code` node functions

Unlike skills, `code` nodes reference registered functions by name:

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

Requires a durable checkpointer configured in `runtime.checkpoint`:

```ts
const compiled = await compileGraph(spec, {
  cwd,
  checkpointer: "sqlite",  // or pass a BaseCheckpointSaver instance
  // ...
});

// First run — interrupts at HITL gate
await compiled.run({ threadId: "rel-1", input: { version: "1.4.0" }, onInterrupt: "fail" });

// Later — resume with operator decision
await compiled.resume({
  threadId: "rel-1",
  resume: { approved: true, notes: "LGTM" },
});
```

See [release-notes](../examples/release-notes/register.ts) for `ctx.interrupt()` and `ctx.once()` patterns.

## Custom providers

```ts
import { compileGraph, defineProvider } from "@veloxdevworks/flowgraph-core";

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

When not using the CLI, pass an MCP hub to `compileGraph`:

```ts
import { McpHub } from "@veloxdevworks/flowgraph-mcp";

const mcp = new McpHub({ cwd, servers: spec.mcpServers });
await mcp.connectAll();

const compiled = await compileGraph(spec, { mcp, cwd });
// ...
await mcp.close();
```

The CLI handles this via `mcpHubForRun` — see [15 — MCP operations](./15-mcp-operations.md).

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

- `resumeFrom(checkpointId)` — time-travel resume from a specific checkpoint
- `CompiledGraph.step()` — superstep debugging
- `flowgraph.config.ts` — project-level auto-registration

See [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md).
