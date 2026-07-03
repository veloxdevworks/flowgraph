# ADR-0004 — Pluggable provider interface first

> **Partially superseded by [ADR-0012](./0012-langchain-provider-in-core.md)** for the LangChain adapter (now built into `@veloxdevworks/flowgraph-core`). Claude/Cursor guidance below is unchanged.

- **Status:** Accepted (kickoff)
- **Date:** 2026-06-25

## Context

Intelligent nodes need a backend (Claude Agent SDK, Cursor SDK, generic LangChain ChatModel, future Gemini/OpenAI/local). We must decide whether to hardcode one backend first or define an abstraction up front.

## Decision

Define a **`ProviderAdapter` interface first**, then implement adapters as **separate packages** (`@veloxdevworks/flowgraph-provider-langchain`, `@veloxdevworks/flowgraph-provider-claude`, `@veloxdevworks/flowgraph-provider-cursor`). Core ships no provider; the CLI lazy-loads adapters by name. v1 implementation order: LangChain (broadest coverage, simplest loop) → Claude → Cursor.

## Consequences

- Heavy SDKs (some bundling native binaries) stay out of `@veloxdevworks/flowgraph-core`; users install only what they reference.
- Graphs are portable across backends via `provider:` swap.
- Community can add providers without touching core.
- Cost: must design a backend-agnostic agent request/result + tool-normalization model, and validate provider-specific capabilities at compile time.

## Alternatives considered

- **Hardcode Claude first:** faster to a demo, but bakes in coupling and a heavy dep; rejected.
- **Only LangChain:** simplest, but forfeits provider-native agent loops/tools (e.g. Claude Code tools, Cursor runtimes); rejected as the sole path.
