# ADR-0010 — Custom sandboxed expression language (no `eval`)

- **Status:** Accepted (kickoff)
- **Date:** 2026-06-25

## Context

The hybrid authoring model ([ADR-0002](./0002-hybrid-authoring-model.md)) needs dynamic data flow in YAML: conditions (`when`, branch), interpolation (prompts, URLs), and I/O mapping. We must decide how `{{ ... }}` expressions are evaluated.

## Decision

Build a **purpose-built, sandboxed expression evaluator** (`@veloxdevworks/flowgraph-expr`): member/index access, literals, comparison/logical/arithmetic operators, ternary/nullish/pipe, and a curated, side-effect-free standard library. **No JavaScript `eval`/`Function`**, no host access (`process`, `require`, prototypes). Expressions are parsed at compile time so referenced channels/inputs can be statically checked.

## Consequences

- Specs remain safe to share and run from untrusted sources; no arbitrary code execution.
- Static analysis catches typos and type mismatches at `validate` time.
- Evaluation is total (missing paths → `null`, with an optional strict mode), preventing crashes on optional fields.
- Cost: we maintain a parser/evaluator and stdlib; capability is intentionally bounded (anything more belongs in a `code` node or skill).

## Alternatives considered

- **JS `eval`/`vm`:** powerful but unsafe for shareable specs and hard to analyze statically; rejected.
- **Existing template engine (e.g. full JMESPath/Jinja-like):** considered; we adopt a small JMESPath/JS-expression-inspired subset rather than a heavyweight dependency, optimizing for static checkability and a tiny safe core.
