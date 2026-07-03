# ADR-0006 — Monorepo: pnpm + Turborepo + tsup + Vitest + Changesets

- **Status:** Accepted (kickoff)
- **Date:** 2026-06-25

## Context

The system naturally splits into a light core plus optional, independently versioned adapters (providers, checkpointers, observability) and a schema package consumable without the engine. We must choose a repository structure and toolchain.

## Decision

Use a **monorepo** with **pnpm workspaces + Turborepo**, **tsup** (esbuild) for builds, **Vitest** for tests, and **Changesets** for independent per-package semver releases.

## Consequences

- Clear public/extension boundaries; adapters publish on their own cadence.
- A CI user installing `@veloxdevworks/flowgraph-core` does not pull the Claude/Cursor SDKs (peer-depended adapter packages).
- `@veloxdevworks/flowgraph-spec` is dependency-light and reusable by editor tooling and the future GUI.
- Slightly more upfront config (workspace, pipeline, release flow) than a single package.

## Alternatives considered

- **pnpm + Nx:** powerful, but heavier conventions than needed at this stage.
- **Single package:** simplest, but forces heavy SDK deps onto every consumer and blocks independent adapter versioning; rejected.
