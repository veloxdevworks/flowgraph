# ADR-0003 — Intelligent nodes are agent-with-tools (hub & spoke)

- **Status:** Accepted (kickoff)
- **Date:** 2026-06-25

## Context

"Intelligent" nodes (Cursor/Claude SDK) should behave like a hub & spoke. This could mean (a) an agent loop that calls tools/sub-nodes (hub = agent, spokes = tools), or (b) a dispatcher that uses the model only to pick the next single graph node.

## Decision

An intelligent node is an **agent-with-tools** running its tool-calling loop **inside a single graph node**. Other graph nodes and skills are exposed to it as callable tools (spokes), invoked through flowgraph's runtime (so tool calls are contract-validated, event-emitting, and hook-able). The agent loops until done, then writes a result back to state. A separate `router` node covers the dispatcher pattern; the two compose.

## Consequences

- Graph topology stays readable: rich agent behavior does not explode into many edges; intra-node tool calls are nested spans, not graph edges.
- Tool calls remain observable and governable (events, hooks, `permission: ask` → HITL).
- Requires a provider abstraction with tool normalization ([ADR-0004](./0004-pluggable-providers.md)) and careful nesting in events/traces.
- Authors who want visible decomposition use `router`/`subgraph`/explicit nodes; both styles are supported and mixable.

## Alternatives considered

- **Dispatcher-only:** simpler, but underuses modern agent SDKs and pushes all logic into graph edges. Kept as the `router` node instead.
