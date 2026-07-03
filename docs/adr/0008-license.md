# ADR-0008 — License: Apache-2.0

- **Status:** Accepted
- **Date:** 2026-06-25

## Context

The project is intended as a community standalone and a foundation for a downstream GUI product. The license affects adoption, contribution, and patent posture in the AI/agent space.

## Decision

Use **Apache-2.0** as the project license (confirmed at kickoff).

## Consequences

- Permissive (like MIT) so it is friendly to both OSS and commercial adoption — including reuse by our own future GUI project.
- Includes an **explicit patent grant** and patent-retaliation clause, valuable in the fast-moving agent/LLM space where patent risk is real.
- Slightly more ceremony than MIT (NOTICE file, headers), which is acceptable.
- Compatible with the LangGraph.js (MIT) dependency.

## Alternatives considered

- **MIT:** maximal simplicity and ubiquity, but no explicit patent grant.
- **Copyleft (MPL/AGPL):** would hinder adoption and our own downstream commercial GUI; rejected.

## Follow-up

Add `LICENSE`, `NOTICE`, and a source-header policy during Phase 0 scaffolding.
