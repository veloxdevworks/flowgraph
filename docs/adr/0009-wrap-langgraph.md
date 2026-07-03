# ADR-0009 — Wrap LangGraph.js; do not fork or reimplement

- **Status:** Accepted (kickoff)
- **Date:** 2026-06-25

## Context

The explicit goal is to wrap LangGraph, not build something novel. We must commit to a relationship with the engine and resist the temptation to abstract it away or reimplement scheduling/state.

## Decision

Treat **`@langchain/langgraph` as the unforked L0 engine.** flowgraph compiles its YAML spec into a real `StateGraph` and uses LangGraph's channels, pregel loop, checkpointers, and `interrupt()`/`Command` directly. We add ergonomics, contracts, events/hooks, providers, and packaging — never a competing runtime. Anything LangGraph can do should remain reachable.

## Consequences

- We inherit LangGraph's capabilities and improvements for free; lower maintenance surface.
- We are coupled to LangGraph's API and version cadence; mitigated by isolating the integration inside `@veloxdevworks/flowgraph-core` (the `build` stage) so upstream changes touch one layer.
- Our differentiator stays where it belongs: the low-code/no-code packaging layer.
- We must track LangGraph.js releases and pin/test against them.

## Alternatives considered

- **Abstract the engine behind our own interface (engine-agnostic):** premature; adds a leaky abstraction and dilutes the "wrap LangGraph" mandate. Revisit only if a second engine becomes a real requirement.
- **Fork/reimplement:** explicitly a non-goal; enormous cost, no payoff; rejected.
