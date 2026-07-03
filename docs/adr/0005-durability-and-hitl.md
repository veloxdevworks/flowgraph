# ADR-0005 — Durability + HITL are first-class in v1

- **Status:** Accepted (kickoff)
- **Date:** 2026-06-25

## Context

Target use cases include long-running "software factories" and multi-step approval flows. We must decide whether checkpointing, human-in-the-loop (interrupt/resume), and durable execution are v1 or deferred.

## Decision

**First-class in v1.** Build a checkpointer abstraction over LangGraph's `BaseCheckpointSaver`, ship `MemorySaver` + a durable `@veloxdevworks/flowgraph-checkpoint-sqlite`, and implement HITL via LangGraph's `interrupt()` + `Command({ resume })` keyed by `thread_id`. Support dynamic interrupts, static breakpoints, durable `wait`/`webhook` gates, time-travel (state history / resume-from), and per-environment `onInterrupt` policy.

## Consequences

- Enables the headline capability: interrupt for approval and resume days later across process restarts.
- Requires idempotency support (`ctx.once`, `sideEffecting` flags) because resumed nodes re-run from their start.
- Larger v1 surface, but these concerns are very hard to retrofit, so paying early is correct.
- Postgres checkpointer and durable LangGraph `Store` backends deferred to a later phase; in-memory `ctx.store` is available now.
- `webhook: wait` / `webhook: emit` nodes are implemented; an HTTP ingress server that wraps `resume()` remains future work (today external systems resume via the programmatic API or CLI).

## Alternatives considered

- **Basic in-memory only / defer HITL:** smaller v1, but the north-star use cases are unservable and the architecture would need invasive changes later; rejected.
