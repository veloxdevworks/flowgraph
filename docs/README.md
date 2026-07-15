# flowgraph — Documentation

> **Name:** _flowgraph_. Plain and descriptive: a graph of AI/automation nodes. (Package scope `@veloxdevworks/flowgraph-*`, CLI `flowgraph`, spec token `apiVersion: flowgraph/v1`.)

flowgraph is a **declarative orchestration layer on top of [LangGraph.js](https://langchain-ai.github.io/langgraphjs/)**. It lets you describe an agentic/automation graph in **YAML** (low-code today, no-code later) and compile it to a runnable LangGraph `StateGraph`, with first-class **events, hooks, skills, intelligent agent nodes, checkpointing, and human-in-the-loop**.

We are **not** building a new graph engine. LangGraph is the engine. flowgraph is the **packaging, authoring, and observability layer** that makes the engine approachable for everyone from CI pipelines to (eventually) non-technical authors using a UI.

---

## Read in this order

| # | Document | What it covers |
|---|----------|----------------|
| 00 | [Vision & Scope](./00-vision.md) | Why this exists, goals, non-goals, naming, success criteria |
| 01 | [Architecture](./01-architecture.md) | Layered architecture, monorepo layout, package boundaries, data flow |
| 02 | [Graph Specification](./02-graph-spec.md) | The YAML graph schema — the heart of the low-code layer |
| 03 | [Node Types](./03-node-types.md) | `intelligent`, `skill`, `http`/`webhook`, `router`, `subgraph`, `code`, custom |
| 04 | [Skills](./04-skills.md) | The `SKILL.md` format: front-matter, env deps, output contracts, preflight |
| 05 | [State & Data Flow](./05-state-and-data.md) | State channels, reducers, the expression language, I/O mapping |
| 06 | [Events & Hooks](./06-events-and-hooks.md) | Event taxonomy, the hook system, OpenTelemetry observability |
| 07 | [Runtime & Execution](./07-runtime-and-execution.md) | Compilation, checkpointing, HITL interrupts/resume, durability, retries |
| 08 | [Providers](./08-providers.md) | Pluggable intelligent-node backends (Claude Agent SDK, Cursor SDK, LangChain) |
| 09 | [CLI](./09-cli.md) | `flowgraph run`, `validate`, `graph`, `skills`, `dev` |
| 10 | [Roadmap](./10-roadmap.md) | Phased milestones from v0.1 → v1.0 |
| 11 | [Local Tools](./11-local-tools.md) | Sandboxed filesystem tools and governance |
| 12 | [Interactive TUI](./12-tui.md) | `flowgraph tui` — keyboard-driven terminal UI |
| 13 | [Getting started](./13-getting-started.md) | Install, first run, editor setup, hybrid authoring |
| 14 | [Programmatic API](./14-programmatic-api.md) | `@veloxdevworks/flowgraph-core` + `@veloxdevworks/flowgraph-testing` |
| 15 | [MCP operations](./15-mcp-operations.md) | OAuth, CI patterns, provider env vars |
| 16 | [Agent Definitions](./16-agents.md) | Reusable `AGENT.md` system prompts for agent nodes |
| — | [Implementation status](./IMPLEMENTATION_STATUS.md) | Shipped vs planned feature matrix |
| — | [ADRs](./adr/) | Architecture Decision Records capturing locked-in choices |
| — | [Examples](../examples/README.md) | Runnable example index |

---

## The 60-second mental model

```
                YAML graph spec  +  SKILL.md files
                          │
                          ▼
   ┌─────────────────────────────────────────────┐
   │  flowgraph Compiler (validate → resolve → build)  │
   │   • Zod-validated spec                        │
   │   • Node Registry resolves type → impl        │
   │   • Builds a LangGraph StateGraph             │
   └─────────────────────────────────────────────┘
                          │  compile()
                          ▼
   ┌─────────────────────────────────────────────┐
   │            LangGraph.js StateGraph            │  ← the engine (unchanged)
   └─────────────────────────────────────────────┘
                          │  invoke / stream
                          ▼
   ┌─────────────────────────────────────────────┐
   │  flowgraph Runtime                                │
   │   • Event bus (observability)                 │
   │   • Hook pipeline (enhancement/interception)  │
   │   • Checkpointer + HITL interrupts            │
   │   • OTel traces/metrics/logs                  │
   └─────────────────────────────────────────────┘
```

A minimal graph looks like this:

```yaml
# hello.graph.yaml
apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: triage-issue
state:
  channels:
    issue: { type: object }
    summary: { type: string }
    label: { type: string }
nodes:
  - id: summarize
    type: agent
    provider: claude
    with:
      prompt: "Summarize this issue for triage:\n{{ state.issue.body }}"
      output: { to: summary }
  - id: classify
    type: router
    with:
      input: "{{ state.summary }}"
      routes:
        bug:     { when: "contains(lower(state.summary), 'error')", to: file-bug }
        feature: { default: true, to: file-feature }
  - id: file-bug
    type: skill
    uses: ./skills/create-jira-bug
  - id: file-feature
    type: skill
    uses: ./skills/create-jira-feature
edges:
  - { from: START, to: summarize }
  - { from: summarize, to: classify }
  - { from: file-bug, to: END }
  - { from: file-feature, to: END }
```

> Note: code samples in these docs describe the **target design**. The monorepo implements the compiler, runtime, CLI, and examples under `packages/` and `examples/`; see the [Roadmap](./10-roadmap.md) for remaining gaps.

---

## Locked decisions (from project kickoff)

These were decided at kickoff and are recorded as ADRs:

- **Hybrid authoring model** — YAML declares topology + config + conditions; logic lives in registered TS nodes/skills. ([ADR-0002](./adr/0002-hybrid-authoring-model.md))
- **Agent nodes are agent-with-tools (hub & spoke)** — other nodes/skills are exposed to the agent as callable tools. ([ADR-0003](./adr/0003-intelligent-node-hub-and-spoke.md))
- **Pluggable provider interface first**, then Claude/Cursor/LangChain adapters. ([ADR-0004](./adr/0004-pluggable-providers.md))
- **Checkpointing + HITL + durability are first-class in v1.** ([ADR-0005](./adr/0005-durability-and-hitl.md))
- **Monorepo: pnpm + Turborepo + tsup + Vitest + Changesets.** ([ADR-0006](./adr/0006-monorepo-tooling.md))
- **OpenTelemetry is the first-class observability target.** ([ADR-0007](./adr/0007-observability-otel.md))
- **Name: `flowgraph`** (scope `@veloxdevworks/flowgraph-*`, CLI `flowgraph`, `apiVersion: flowgraph/v1`). ([ADR-0013](./adr/0013-rename-to-flowgraph.md), supersedes [ADR-0001](./adr/0001-naming.md))
- **License: Apache-2.0.** ([ADR-0008](./adr/0008-license.md))
