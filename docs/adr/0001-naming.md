# ADR-0001 — Project name & npm scope

- **Status:** Superseded by [ADR-0013](./0013-rename-to-flowgraph.md)
- **Date:** 2026-06-25

## Context

The project needs a name that becomes the npm scope (`@<scope>/*`), the CLI binary, the `apiVersion: <name>/v1` token, and the brand for a community standalone. The repo directory is `ai-graph`.

## Decision

Use **ai-graph** as the project name. It is plain and descriptive — a graph of AI/automation nodes — and matches the repository directory. It derives:

- npm scope `@ai-graph/*`
- CLI binary `ai-graph`
- spec token `apiVersion: ai-graph/v1`
- env/config prefix `AI_GRAPH_*`; OpenTelemetry attribute namespace `aigraph.*`

(An earlier working name, "Skein", was dropped in favor of the descriptive `ai-graph`.)

## Consequences

- All package names, the CLI, and the spec `apiVersion` token derive from this; settling it now avoids a wide rename later.
- "ai-graph" is generic and may face npm scope / GitHub org availability or trademark constraints — verify before the first publish. If a conflict forces a change, it is a mechanical repo-wide rename.

## Alternatives considered

| Name | Note |
|---|---|
| Skein | Brandable but unfamiliar; rejected in favor of a descriptive name |
| Loom / Lattice / Weave / Conductor | Good metaphors, but common / collide with existing projects |

## Follow-up

Verify `@ai-graph` npm scope and GitHub org availability and trademark sanity before first publish.

> **Update (2026-07-02):** The `@ai-graph` scope plan didn't survive contact with the sibling-product convention (`@veloxdevworks/<product>`) and with "ai-graph" reading as too literal/generic once the LangChain-in-core work made the low-code-on-LangGraph pitch clearer. See [ADR-0013](./0013-rename-to-flowgraph.md) for the renaming to **flowgraph** under the `@veloxdevworks` scope.
