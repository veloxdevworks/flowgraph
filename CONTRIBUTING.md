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

This is a pnpm + Turborepo monorepo. Each package lives under `packages/`. See [`docs/01-architecture.md`](./docs/01-architecture.md) for the full package layout and dependency rules.

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
