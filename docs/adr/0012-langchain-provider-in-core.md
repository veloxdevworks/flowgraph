# ADR-0012 — LangChain provider built into core

- **Status:** Accepted
- **Date:** 2026-07-02
- **Supersedes (partially):** [ADR-0004](./0004-pluggable-providers.md) — LangChain adapter only

## Context

ADR-0004 placed all provider adapters in separate packages so heavy SDKs stay out of `@flowgraph/core`. In practice:

- `@flowgraph/core` already depends on `@langchain/langgraph`, which peer-depends on `@langchain/core` — so LangChain core types are already required for every core install.
- `@flowgraph/cli` already listed `@flowgraph/provider-langchain` as a **hard dependency**, not a lazy optional extra (unlike Claude and Cursor).
- LangChain is the default "works with any model" path for `intelligent` nodes. Requiring a separate `@flowgraph/provider-langchain` package added onboarding friction without meaningful bundle savings.

## Decision

**Fold the LangChain provider adapter into `@flowgraph/core`** at `core/src/providers/langchain/`. Export `createLangChainProvider`, `createLangChainProviderFromConfig`, and related helpers from the core public API.

- Add `@langchain/core` as a direct dependency of `@flowgraph/core`.
- Keep LangChain **vendor** packages (`@langchain/openai`, `@langchain/anthropic`, etc.) as optional peer dependencies — users install only the vendor they use.
- **Delete** `@flowgraph/provider-langchain` (nothing published to npm yet; no shim).
- **Unchanged:** `@flowgraph/provider-claude` and `@flowgraph/provider-cursor` remain separate packages, lazy-loaded by the CLI when referenced in a graph.

## Consequences

- Minimum runnable package for LLM graphs: `@flowgraph/cli` (or `@flowgraph/core`) + one LangChain vendor SDK + API key env var.
- Programmatic users no longer need to discover or install a separate flowgraph provider package for the default path.
- `@flowgraph/core` bundle grows slightly (the adapter code), but `@langchain/core` was already a forced transitive dependency.
- Custom/community providers still implement `ProviderAdapter` and register via `compileGraph({ providers })` — the pluggable interface from ADR-0004 remains.

## Alternatives considered

- **Keep separate package:** preserves ADR-0004 literally, but CLI already bundled it; friction for library users with no benefit.
- **Deprecated re-export shim:** unnecessary before first npm publish.
- **Hardcode only OpenAI vendor in core:** simpler install, but loses multi-vendor YAML `providers:` block without extra work.
