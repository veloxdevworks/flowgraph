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
    type: agent
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
npx @veloxdevworks/flowgraph-cli run triage.graph.yaml --input issue=@payload.json
```

Unscoped `npx flowgraph` is a different 2015 npm package — always use `@veloxdevworks/flowgraph-cli`.

Use `flowgraph run` for CI and scripting. An interactive TUI is a **companion** (`@veloxdevworks/flowgraph-tui`) that is **not in this repo and not published** with 0.1 — see [docs/12-tui.md](./docs/12-tui.md).

## What it is

flowgraph wraps LangGraph.js with a low-code/no-code packaging layer so that:

- **Any complexity of graph** — from a simple webhook→agent→notify flow to a multi-day, multi-agent software factory — can be declared in YAML.
- **The same spec** runs headless in CI (with `--on-interrupt fail`) and interactively on a developer's desktop (with `--on-interrupt prompt`).
- **Structured events** cover the run/node/skill/agent lifecycle that the runtime actually emits. OpenTelemetry is an **opt-in package** (`@veloxdevworks/flowgraph-observability-otel`); attach `otelSink()` yourself — CLI `--otel` is not wired in 0.1.
- **Skills** are portable, contract-bearing, environment-aware building blocks shared across graphs and teams.
- **Long-running graphs** checkpoint at every step and resume after interrupts, process restarts, or human approval gates.

## Packages

Packages are grouped so core stays free of native bindings and optional SDKs. Install only the adapters and plugins you need.

### Foundation

| Package | Description |
|---|---|
| `@veloxdevworks/flowgraph-core` | Compiler, runtime, node registry, event bus, built-in nodes, **built-in LangChain provider** |
| `@veloxdevworks/flowgraph-spec` | Zod schemas + generated JSON Schema (editor autocomplete) |
| `@veloxdevworks/flowgraph-expr` | Sandboxed `{{ expression }}` evaluator |
| `@veloxdevworks/flowgraph-skills` | `SKILL.md` loader, contract validation, preflight |
| `@veloxdevworks/flowgraph-cli` | The `flowgraph` binary (`npx @veloxdevworks/flowgraph-cli`) |
| `@veloxdevworks/flowgraph-testing` | In-memory test harness |

### Adapters

Peer-depend on `core` plus one provider SDK.

| Package | Description |
|---|---|
| `@veloxdevworks/flowgraph-provider-claude` | Claude Agent SDK adapter |
| `@veloxdevworks/flowgraph-provider-cursor` | Cursor SDK adapter |

### Runtime plugins

Peer-depend on `core` plus one optional capability (native driver, OTel, sandbox, etc.).

| Package | Description |
|---|---|
| `@veloxdevworks/flowgraph-checkpoint-sqlite` | Durable SQLite checkpointer |
| `@veloxdevworks/flowgraph-checkpoint-postgres` | Durable Postgres checkpointer |
| `@veloxdevworks/flowgraph-observability-otel` | OpenTelemetry exporter |
| `@veloxdevworks/flowgraph-tools-fs` | Sandboxed local filesystem tools |
| `@veloxdevworks/flowgraph-server` | HTTP run server — **not in 0.1** (changeset-ignored; consume from this repo) |

### Companion (not in this repo, not published with 0.1)

| Package | Status |
|---|---|
| `@veloxdevworks/flowgraph-tui` | Companion interactive TUI — do not `pnpm add` as if it ships here |
| `@veloxdevworks/flowgraph-mcp` | Companion MCP hub — CLI commands exist; the package is not on npm yet |

The hosted docs site ([veloxdevworks.com/flowgraph](https://veloxdevworks.com/flowgraph/)) is built from the private `flowgraph-app` companion and **will lag** until that repo syncs.

## Docs

- **[Getting started](./docs/13-getting-started.md)** — install, first run, editor setup
- **[Full documentation index](./docs/README.md)** — specs, ADRs, guides
- **[Examples](./examples/README.md)** — runnable vertical slices
- **[Implementation status](./docs/IMPLEMENTATION_STATUS.md)** — shipped vs planned

Public docs site: [veloxdevworks.com/flowgraph](https://veloxdevworks.com/flowgraph/) (built from the private [`flowgraph-app`](https://github.com/veloxdevworks/flowgraph-app) repo; markdown source lives here in `docs/`).

## Status

0.1 is the first honest published engine: compiler, skills, HITL, providers, CLI. APIs are pre-1.0 and may change. MCP/TUI companions and the hosted server are not in this npm set. See the [roadmap](./docs/10-roadmap.md) and [implementation status](./docs/IMPLEMENTATION_STATUS.md).

## License

Apache-2.0 — see [LICENSE](./LICENSE).
