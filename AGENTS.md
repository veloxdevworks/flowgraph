# AGENTS.md

`flowgraph` is the open-source engine (pnpm + Turborepo monorepo). The proprietary
repos `flowgraph-app` and `flowgraph-desktop` consume its `@veloxdevworks/flowgraph-*`
packages via `link:` to a sibling checkout of this repo.

## Cursor Cloud specific instructions

### Workspace layout & the `ai-graph` symlink (critical)

- This repo is checked out at `/agent/repos/flowgraph`. The sibling repos
  `flowgraph-app` and `flowgraph-desktop` reference it through `link:` specifiers
  that point at a sibling directory named **`ai-graph`** (e.g.
  `link:../../ai-graph/packages/core`). The startup update script creates
  `/agent/repos/ai-graph -> /agent/repos/flowgraph`. If `pnpm install` in a
  downstream repo cannot resolve `@veloxdevworks/flowgraph-*`, recreate it:
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
  `@veloxdevworks/flowgraph-spec` first, or just run the root build.
- Standard commands live in `CONTRIBUTING.md` and `package.json`
  (`pnpm build`, `pnpm test`, `pnpm typecheck`).

### Pre-existing DTS build break (important)

- `pnpm build`, `pnpm test`, and `pnpm typecheck` currently **fail at the
  type-declaration (DTS) step** on a pre-existing type error, not an env issue:
  `packages/testing` (`TestRunResult.status` omits the `"paused"` run status that
  `core` now returns) and `packages/cli` (`src/commands.ts` compares against a
  status that can no longer be `"interrupted"`). CI would be red on `main` for the
  same reason.
- The important consequence: every package's **runtime JS bundle still builds
  fine** (tsup emits `dist/*.js` before DTS fails), so the engine is fully
  runnable. `packages/cli/dist/bin.js` is produced and works. To get a complete
  build without the aborted `cli` step, run
  `pnpm --filter @veloxdevworks/flowgraph-cli build` after the top-level build.
- Because turbo's `test`/`typecheck` tasks depend on `build`, the aggregate
  `pnpm test` aborts before running specs. Run a package's tests directly instead,
  e.g. `pnpm --filter @veloxdevworks/flowgraph-core exec vitest run` (core: 132
  tests pass).
- Downstream repos (`flowgraph-app`, `flowgraph-desktop`) still build/test fine
  against this checkout, since they consume `core`/`spec`/`expr`/`skills` (whose
  DTS builds succeed), not `testing`/`cli` types.

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
  directly fails. `pnpm typecheck` + `pnpm test` currently also fail at the DTS
  step (see "Pre-existing DTS build break" above) — validate with per-package
  `vitest run` until those type errors are fixed.

### Providers gotcha

- `intelligent` nodes require a *registered* provider. The built-in `mock`
  provider is NOT auto-registered by the CLI/runtime; graphs using `provider: mock`
  must register it via an `imports` module, and `provider: langchain` needs a model
  plus an API key. Deterministic node types (`router`, `skill`, `code` with
  registered functions) run with no LLM.
