# Contributing to flowgraph

Thank you for your interest in contributing!

## Development setup

```bash
# Install pnpm if you don't have it
npm install -g pnpm

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run all tests
pnpm test

# Type-check
pnpm typecheck
```

## Project structure

This is a pnpm + Turborepo monorepo. Each package lives under `packages/`. Runnable examples live under `examples/`. Internal automation (e.g. the scheduled self-improvement loop) lives under `automation/` — see [`automation/self-improve/README.md`](./automation/self-improve/README.md). See [`docs/01-architecture.md`](./docs/01-architecture.md) for the full package layout and dependency rules.

Packages are tiered so `core` stays free of native bindings and optional SDKs:

| Tier | Examples | Rule of thumb |
|---|---|---|
| Foundation | `core`, `spec`, `expr`, `skills`, `cli`, `testing` | Always relevant; no optional heavy/native deps |
| Adapters | `provider-claude`, `provider-cursor` | Peer-dep on `core` + one provider SDK |
| Runtime plugins | `checkpoint-*`, `observability-otel`, `tools-fs` | Peer-dep on `core` + one optional capability |

## Adding a package

Prefer extending an existing package. Create a new one only when the capability needs an optional heavy or native dependency that must not land in `core`.

1. **Decide the tier.** If it does not need an optional heavy/native dependency, it probably belongs inside `core`, not a new package.
2. **Name it** `@veloxdevworks/flowgraph-<tier>-<name>` so it sorts with siblings (`provider-x`, `checkpoint-x`, etc.) under `packages/`.
3. **Wire deps as peers**, not hard dependencies:
   - `peerDependencies` on `@veloxdevworks/flowgraph-core` and the heavy SDK/driver
   - `peerDependenciesMeta` with `optional: true` when the CLI should lazy-load it
4. **Update docs in the same PR:**
   - Root [README.md](./README.md) package tables (Foundation / Adapters / Runtime plugins)
   - [`docs/01-architecture.md`](./docs/01-architecture.md) layout tree and dependency-rules diagram
5. Scaffold with the same `tsup` / Vitest / Changesets pattern as an existing sibling package.

`examples/` and `automation/` are non-published consumers — do not put public packages there.

## Making changes

1. Fork and create a branch from `main`.
2. Make your change with tests.
3. Run `pnpm build && pnpm test && pnpm typecheck` — all must pass.
4. Add a changeset: `pnpm changeset` — follow the prompts.
5. Open a pull request.

## Changesets

We use [Changesets](https://github.com/changesets/changesets) for versioning and changelogs. Every user-visible change needs a changeset; pure internal/doc changes do not.

## Code style

- TypeScript strict mode; no `any` without a comment explaining why.
- Prettier + ESLint are enforced in CI. Run `pnpm format` before committing.
- Comments only for non-obvious intent — not narrating the code.

## License

By contributing, you agree your contributions are licensed under Apache-2.0.
