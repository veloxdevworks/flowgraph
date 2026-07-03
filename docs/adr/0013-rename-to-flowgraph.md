# ADR-0013 — Rename to flowgraph under the @veloxdevworks scope

- **Status:** Accepted
- **Date:** 2026-07-02
- **Supersedes:** [ADR-0001](./0001-naming.md)

## Context

ADR-0001 picked **ai-graph** as the project name and planned a standalone `@ai-graph/*` npm scope. Revisiting before the first publish surfaced two problems:

1. **Sibling convention mismatch.** Other Velox products (`@veloxdevworks/formulas`, `@veloxdevworks/barcodes`, `@veloxdevworks/i18n`) all publish under the shared `@veloxdevworks` org scope, not a per-product scope. `@ai-graph/*` would be the only outlier, complicating branding, npm org management, and discoverability as "a Velox product."
2. **Name accuracy.** "ai-graph" is generic and undersells the actual mechanism: a declarative, low-code YAML layer that compiles to LangGraph.js execution (agents, tools, HITL, durability). It also reads as one of many interchangeable "graph" tools.

## Decision

Rename the project to **flowgraph**, published under the shared **`@veloxdevworks`** scope, keeping today's multi-package split (needed for the optional-peer-dependency slimming from the CLI install-surface work):

- npm packages: `@veloxdevworks/flowgraph-core`, `@veloxdevworks/flowgraph-cli`, `@veloxdevworks/flowgraph-spec`, `@veloxdevworks/flowgraph-mcp`, `@veloxdevworks/flowgraph-tools-fs`, `@veloxdevworks/flowgraph-checkpoint-sqlite`, `@veloxdevworks/flowgraph-checkpoint-postgres`, `@veloxdevworks/flowgraph-observability-otel`, `@veloxdevworks/flowgraph-provider-claude`, `@veloxdevworks/flowgraph-provider-cursor`, `@veloxdevworks/flowgraph-testing`, `@veloxdevworks/flowgraph-tui`, `@veloxdevworks/flowgraph-expr`, `@veloxdevworks/flowgraph-skills`
- CLI binary: `flowgraph` (TUI binary: `flowgraph-tui`)
- spec token: `apiVersion: flowgraph/v1`
- env/config prefix: `FLOWGRAPH_*`; OpenTelemetry attribute namespace: `flowgraph.*`
- local state directory: `.flowgraph/` (checkpoints, MCP OAuth tokens, TUI history)
- docs site path: `veloxdevworks.com/flowgraph/`; hosted schema: `veloxdevworks.com/flowgraph/schema/v1.json`
- GitHub org/repo: `veloxdevworks/flowgraph`
- docs-site-only (private, unpublished) package: `@velox/flowgraph-docs` in repo `veloxdevworks/flowgraph-app`, matching the `@velox/formulas-docs` / `@velox/i18n-docs` convention for docs apps

The `flowgraph migrate` command already generically rewrites any `apiVersion` value to the current token, so existing `ai-graph/v1` specs migrate forward with no special-cased logic.

## Consequences

- Matches sibling Velox products' npm org convention, reinforcing "flowgraph is a Velox product" rather than a standalone brand.
- The name change happens before the first publish, so this is a pure find-and-replace across the repo with no deprecated-package shim or dual-publish period required.
- Every package name, the CLI binary, the `apiVersion` token, env vars, and the OTel namespace all change together — done once, atomically, rather than piecemeal.
- The `@ai-graph` scope and `github.com/veloxdevworks/ai-graph` are abandoned; if a public GitHub repo or npm scope reservation already exists under those names, it should be redirected or deleted before publish to avoid confusion.

## Alternatives considered

| Name | Note |
|---|---|
| `flows` | Simple, but directly overlaps with existing "flow" branding in this space (LangFlow, Flowise); risks reading as an interchangeable competitor rather than a distinct low-code-on-LangGraph tool |
| `lowgraph` | Literal to "low-code + graph," but phonetically close to "LangGraph" itself — reads as either a compatibility signal or too derivative |
| `orchestrate` | Accurate to "declarative orchestration layer," but generic in a crowded workflow-engine space (Temporal, Airflow, Camunda) |
| `statecraft` / `flowcraft` | Brandable and collision-free, but more abstract — needs a tagline to land the meaning |
| Keep `ai-graph` under its own scope (status quo) | Rejected — see Context above |
| Single flagship package `@veloxdevworks/flowgraph` (bundle everything) | Rejected — would undo the CLI install-surface slimming (optional MCP/FS/sqlite peer deps) from the prior plan |

## Follow-up

- Verify `@veloxdevworks/flowgraph-*` package names are free (org already exists; just new package names within it).
- Verify/reserve the `veloxdevworks/flowgraph` GitHub repo name.
- Update the `veloxdevworks.com` website integration (deploy pins, redirects, workflow dispatch) to the new path and repo name — tracked alongside this rename.
