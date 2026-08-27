# ADR-0015 — Publish OSS packages under the `@flowgraph` scope

- **Status:** Accepted
- **Date:** 2026-08-27
- **Supersedes:** the npm-scope portion of [ADR-0013](./0013-rename-to-flowgraph.md)
- **Does not change:** product name, CLI binary, spec token, env prefix, OTel namespace, GitHub org/repo, or docs URL from ADR-0013

## Context

ADR-0013 renamed the project to **flowgraph** and published packages as `@veloxdevworks/flowgraph-*` so they would match sibling Velox products (`@veloxdevworks/formulas`, `@veloxdevworks/barcodes`, `@veloxdevworks/i18n`). That convention is still right for those products.

flowgraph is a community-facing engine with its own CLI, spec, and install surface. The long `@veloxdevworks/flowgraph-core` names dilute product cohesion: consumers think in terms of flowgraph, not the company org. A dedicated `@flowgraph/*` scope (`@flowgraph/core`) reads as one product. GitHub, the docs site, and the company remain Velox-hosted.

Nothing has been published yet, so this is still a mechanical rename with no deprecate/shim layer. (Formerly `@veloxdevworks/flowgraph-*`.)

## Decision

Publish OSS engine packages under **`@flowgraph/<name>`**, dropping the `flowgraph-` prefix that duplicated the scope:

- npm packages: `@flowgraph/core`, `@flowgraph/cli`, `@flowgraph/spec`, `@flowgraph/mcp`, `@flowgraph/tools-fs`, `@flowgraph/checkpoint-sqlite`, `@flowgraph/checkpoint-postgres`, `@flowgraph/observability-otel`, `@flowgraph/provider-claude`, `@flowgraph/provider-cursor`, `@flowgraph/provider-deepagents`, `@flowgraph/testing`, `@flowgraph/tui`, `@flowgraph/expr`, `@flowgraph/skills`, `@flowgraph/server`, `@flowgraph/sqlite`
- CLI binary, spec token, env/config prefix, local state directory, OTel namespace, docs site path, GitHub org/repo, and the unpublished `@velox/flowgraph-docs` package: **unchanged** from ADR-0013
- Proprietary desktop packages (`@veloxdevworks/flowgraph-desktop`, `-ipc`, `-ui-graph`, `-sidecar`, `-example-*`) stay on the Velox org until a later decision

Confirm `@flowgraph` org access on npm before the first public publish.

## Consequences

- Install and import paths match the product (`pnpm add @flowgraph/core`).
- Velox remains the GitHub org and docs host; npm scope is the product brand.
- Sibling Velox libraries stay `@veloxdevworks/*`; flowgraph is the intentional exception.
- Pre-publish: find-and-replace only; no dual-publish period.

## Alternatives considered

| Option | Note |
|---|---|
| Keep `@veloxdevworks/flowgraph-*` (ADR-0013) | Rejected — weaker product cohesion for a standalone engine |
| `@flowgraph/flowgraph-core` (scope + old prefix) | Rejected — redundant; `@flowgraph/core` is the point of the scope |
| Move GitHub/docs off Velox in the same change | Out of scope; hosting and npm identity are independent |
