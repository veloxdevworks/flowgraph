# ADR-0002 — Hybrid authoring model

- **Status:** Accepted (kickoff)
- **Date:** 2026-06-25

## Context

The differentiator is a low-code/no-code layer. We must decide how much logic lives in YAML vs. in code. Options ranged from a pure declarative DSL (everything, including transforms, in YAML) to code-first (YAML as thin sugar).

## Decision

**Hybrid.** YAML declares graph topology, node configuration, routing conditions, and references node `type`s and skills that resolve to TS implementations via a registry. No imperative/arbitrary code is embedded in YAML. Complex logic lives in registered/custom nodes and skills, still referenced declaratively. A small, safe expression language ([ADR-0010](./0010-safe-expression-language.md)) handles conditions and data mapping.

## Consequences

- Specs stay safe to share, diff, validate, and (later) generate by a GUI/agent — they are data, not programs.
- Power is preserved via typed `code`/custom nodes and skills, so no capability ceiling.
- Requires a strong registry, contract system, and expression evaluator (build cost).
- Clear path to no-code: a generator only needs to emit valid YAML against a published schema.

## Alternatives considered

- **Pure declarative DSL:** maximal approachability but a capability ceiling and an ever-growing in-YAML mini-language; rejected.
- **Code-first:** maximal power, minimal approachability; defeats the differentiator; rejected.
