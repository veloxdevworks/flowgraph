# Architecture Decision Records

ADRs capture significant, hard-to-reverse decisions with their context and consequences. They are immutable once accepted; revisiting a decision means a new ADR that supersedes the old one.

Format: [MADR](https://adr.github.io/madr/)-lite — Context · Decision · Status · Consequences · Alternatives.

| ADR | Title | Status |
|---|---|---|
| [0001](./0001-naming.md) | Project name & npm scope (ai-graph) | Superseded by 0013 |
| [0002](./0002-hybrid-authoring-model.md) | Hybrid authoring (YAML topology + registered TS logic) | Accepted |
| [0003](./0003-intelligent-node-hub-and-spoke.md) | Intelligent nodes are agent-with-tools (hub & spoke) | Accepted |
| [0004](./0004-pluggable-providers.md) | Pluggable provider interface first | Accepted |
| [0005](./0005-durability-and-hitl.md) | Durability + HITL are first-class in v1 | Accepted |
| [0006](./0006-monorepo-tooling.md) | Monorepo: pnpm + Turborepo + tsup + Vitest + Changesets | Accepted |
| [0007](./0007-observability-otel.md) | OpenTelemetry as the first-class observability target | Accepted |
| [0008](./0008-license.md) | License: Apache-2.0 | Accepted |
| [0009](./0009-wrap-langgraph.md) | Wrap LangGraph.js; do not fork or reimplement | Accepted |
| [0010](./0010-safe-expression-language.md) | Custom sandboxed expression language (no `eval`) | Accepted |
| [0011](./0011-mcp-first-integrations.md) | MCP-first integrations (deterministic + agentic) | Accepted |
| [0012](./0012-langchain-provider-in-core.md) | LangChain provider built into core | Accepted |
| [0013](./0013-rename-to-flowgraph.md) | Rename to flowgraph under the @veloxdevworks scope | Accepted |

> All current ADRs are Accepted except where noted as superseded. New decisions are added as new ADRs.
