# flowgraph

**Declarative orchestration layer on top of [LangGraph.js](https://langchain-ai.github.io/langgraphjs/).** Define agentic and automation graphs in YAML, run them anywhere.

```yaml
# triage.graph.yaml
apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: triage-issue
state:
  channels:
    issue:   { type: object }
    summary: { type: string }
    label:   { type: string }
nodes:
  - id: summarize
    type: intelligent
    provider: claude
    with:
      prompt: "Summarize for triage:\n{{ state.issue.body }}"
      output: { to: summary }
  - id: classify
    type: router
    with:
      input: "{{ state.summary }}"
      routes:
        bug:     { when: "{{ contains(lower(state.summary), 'error') }}", to: file-bug }
        default: { default: true, to: file-feature }
edges:
  - { from: START, to: summarize }
  - { from: summarize, to: classify }
```

```bash
npx flowgraph run triage.graph.yaml --input issue=@payload.json
```

### Interactive mode

```bash
# Optional package — install once per project
pnpm add @veloxdevworks/flowgraph-tui

# Launch the TUI (graph browser, live runs, HITL prompts)
flowgraph tui
flowgraph tui triage.graph.yaml
```

See [docs/12-tui.md](./docs/12-tui.md) for screens and keybindings. Use `flowgraph run` for CI and scripting.

## What it is

flowgraph wraps LangGraph.js with a low-code/no-code packaging layer so that:

- **Any complexity of graph** — from a simple webhook→agent→notify flow to a multi-day, multi-agent software factory — can be declared in YAML.
- **The same spec** runs headless in CI (with `--on-interrupt fail`) and interactively on a developer's desktop (with `--on-interrupt prompt`).
- **Every lifecycle moment** emits a structured event and an OpenTelemetry span with zero custom instrumentation.
- **Skills** are portable, contract-bearing, environment-aware building blocks shared across graphs and teams.
- **Long-running graphs** checkpoint at every step and resume after interrupts, process restarts, or human approval gates.

## Packages

| Package | Description |
|---|---|
| `@veloxdevworks/flowgraph-core` | Compiler, runtime, node registry, event bus, built-in nodes, **built-in LangChain provider** |
| `@veloxdevworks/flowgraph-spec` | Zod schemas + generated JSON Schema (editor autocomplete) |
| `@veloxdevworks/flowgraph-expr` | Sandboxed `{{ expression }}` evaluator |
| `@veloxdevworks/flowgraph-skills` | `SKILL.md` loader, contract validation, preflight |
| `@veloxdevworks/flowgraph-cli` | The `flowgraph` binary |
| `@veloxdevworks/flowgraph-checkpoint-sqlite` | Durable SQLite checkpointer |
| `@veloxdevworks/flowgraph-observability-otel` | OpenTelemetry exporter |
| `@veloxdevworks/flowgraph-provider-claude` | Claude Agent SDK adapter |
| `@veloxdevworks/flowgraph-provider-cursor` | Cursor SDK adapter |
| `@veloxdevworks/flowgraph-testing` | In-memory test harness |

`flowgraph tui` (interactive terminal UI) and MCP server integration ship as separate optional packages (`@veloxdevworks/flowgraph-tui`, `@veloxdevworks/flowgraph-mcp`) built from a companion repo — install them independently when you need them.

## Docs

- **[Getting started](./docs/13-getting-started.md)** — install, first run, editor setup
- **[Full documentation index](./docs/README.md)** — specs, ADRs, guides
- **[Examples](./examples/README.md)** — runnable vertical slices
- **[Implementation status](./docs/IMPLEMENTATION_STATUS.md)** — shipped vs planned

Public docs site (when deployed): [veloxdevworks.com/flowgraph](https://veloxdevworks.com/flowgraph/)

## Status

Phases 1–4 largely complete (compiler, skills, HITL, providers, MCP). APIs are pre-1.0 and may change. See the [roadmap](./docs/10-roadmap.md) and [implementation status](./docs/IMPLEMENTATION_STATUS.md).

## License

Apache-2.0 — see [LICENSE](./LICENSE).
