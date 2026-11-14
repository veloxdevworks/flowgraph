# AGENTS.md

`flowgraph` is the open-source engine (pnpm + Turborepo monorepo). The proprietary
repos `flowgraph-app` and `flowgraph-desktop` consume its `@flowgraph/*`
packages via `link:` to a sibling checkout of this repo.

## Cursor Cloud specific instructions

### Workspace layout & the `ai-graph` symlink (critical)

- This repo is checked out at `/agent/repos/flowgraph`. The sibling repos
  `flowgraph-app` and `flowgraph-desktop` reference it through `link:` specifiers
  that point at a sibling directory named **`ai-graph`** (e.g.
  `link:../../ai-graph/packages/core`). The startup update script creates
  `/agent/repos/ai-graph -> /agent/repos/flowgraph`. If `pnpm install` in a
  downstream repo cannot resolve `@flowgraph/*`, recreate it:
  `sudo ln -sfn /agent/repos/flowgraph /agent/repos/ai-graph`.

### Build order

- Dependencies are refreshed on startup by the update script (`pnpm install` per
  repo). Run `pnpm build` here **before** running or building `flowgraph-app` /
  `flowgraph-desktop`: their `link:` consumers import from `packages/*/dist`, and
  the `flowgraph` CLI bin (`packages/cli/dist/bin.js`) only exists after a build.
- After pull, prefer a root `pnpm build` (turbo already runs dependency builds via
  `^build`). If you isolate a core DTS/`typecheck` against a leftover
  `packages/spec/dist`, stale types can briefly reject new input field types
  (e.g. `"json"`) even though runtime JS is fine — rebuild
  `@flowgraph/spec` first, or just run the root build.
- Standard commands live in `CONTRIBUTING.md` and `package.json`
  (`pnpm build`, `pnpm test`, `pnpm typecheck`).

### Validation

- Run root `pnpm build`, `pnpm typecheck`, and `pnpm test`. The earlier DTS
  mismatch in `testing`/`cli` has been fixed; do not assume aggregate checks fail.
- When diagnosing a local environment failure, compare the same test on unchanged
  `main` and record it separately from regressions introduced by your change.
- PostgreSQL integration tests use `FLOWGRAPH_TEST_POSTGRES_URL`. CI runs them
  again against the same service database after the aggregate test suite.

### Running the CLI / a graph

- After `pnpm build`, invoke the CLI as `node packages/cli/dist/bin.js <cmd>`
  (CI does the same). The `node_modules/.bin/flowgraph` symlink is only created by
  a `pnpm install` that runs *after* the CLI is built, so prefer the `dist/bin.js`
  path.
- Zero-config demo (no network/keys):
  `cd examples/quickstart && node ../../packages/cli/dist/bin.js run quickstart.graph.yaml --stream --input 'text=Hello'`.

### Lint

- `pnpm lint` (turbo) is effectively a no-op — packages define no `lint` task and
  CI has no lint job. The root `eslint.config.js` imports `@eslint/js` /
  `typescript-eslint`, which are not in `devDependencies`, so invoking `eslint`
  directly fails. Use the standard build, typecheck and test commands.

### Providers gotcha

- `intelligent` nodes require a *registered* provider. The built-in `mock`
  provider is NOT auto-registered by the CLI/runtime; graphs using `provider: mock`
  must register it via an `imports` module, and `provider: langchain` needs a model
  plus an API key. Deterministic node types (`router`, `skill`, `code` with
  registered functions) run with no LLM.
