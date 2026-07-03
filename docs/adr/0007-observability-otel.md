# ADR-0007 — OpenTelemetry as the first-class observability target

- **Status:** Accepted (kickoff)
- **Date:** 2026-06-25

## Context

The system must expose observability points across the whole flow. We need a primary export standard that integrates with the broad ecosystem (Datadog, Honeycomb, Grafana/Tempo, Jaeger, Langfuse, etc.) without bespoke integrations.

## Decision

**OpenTelemetry is the first-class observability target.** The internal event tree maps to OTel **traces** (run/node/agent-step/tool-call/skill spans), **metrics** (durations, retries, tokens, cost, interrupts, error rates), and **logs** (trace-correlated). Follow OTel **GenAI** semantic conventions for LLM spans plus a small `flowgraph.*` namespace. Ship as an opt-in package `@veloxdevworks/flowgraph-observability-otel`; keep zero-dependency `console`/`jsonl` sinks in core.

## Consequences

- Drops into any OTLP collector; no vendor lock-in.
- "End-to-end trace with zero custom instrumentation" becomes a concrete success criterion.
- Core stays light (OTel SDK only loaded when the package is used).
- Must keep the internal event model rich enough to faithfully produce spans/metrics, and track evolving GenAI semconv.

## Alternatives considered

- **Bespoke logging only:** simplest, but no ecosystem leverage; rejected as the primary.
- **Vendor-specific SDK first:** lock-in; rejected (vendors consume OTLP anyway).
