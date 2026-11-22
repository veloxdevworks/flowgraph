# Publish-readiness review

Evidence-only briefing of `@veloxdevworks/flowgraph-*` as of `main` @ `35015f7` (2026-08-17). **Code and package manifests win.** This is not an implementation pass.

**Verdict:** Do not `npm publish` yet. The engine is real and largely runnable from a monorepo checkout. The npm/first-hour story is not. Nothing in the `@veloxdevworks/flowgraph-*` family is on the registry; root README / CLI docs still tell people to `npx flowgraph`, which installs an unrelated package.

---

## Snapshot (what would actually ship)

| Package | Version | `private` | On npm | In root README tables |
|---|---|---|---|---|
| `@veloxdevworks/flowgraph-core` | 0.1.0 | no | **404** | yes |
| `@veloxdevworks/flowgraph-spec` | 0.1.0 | no | 404 | yes |
| `@veloxdevworks/flowgraph-expr` | 0.1.0 | no | 404 | yes |
| `@veloxdevworks/flowgraph-skills` | 0.1.0 | no | 404 | yes |
| `@veloxdevworks/flowgraph-cli` | 0.1.0 | no | 404 | yes |
| `@veloxdevworks/flowgraph-testing` | 0.1.0 | no | 404 | yes |
| `@veloxdevworks/flowgraph-provider-claude` | 0.1.0 | no | 404 | yes |
| `@veloxdevworks/flowgraph-provider-cursor` | 0.1.0 | no | 404 | yes |
| `@veloxdevworks/flowgraph-checkpoint-sqlite` | 0.1.0 | no | 404 | yes |
| `@veloxdevworks/flowgraph-checkpoint-postgres` | 0.1.0 | no | 404 | yes |
| `@veloxdevworks/flowgraph-observability-otel` | 0.1.0 | no | 404 | yes |
| `@veloxdevworks/flowgraph-tools-fs` | 0.1.0 | no | 404 | yes |
| `@veloxdevworks/flowgraph-server` | 0.1.0 | no | 404 | **no** |
| `@veloxdevworks/flowgraph-mcp` | — | not in this repo | **404** | mentioned as companion |
| `@veloxdevworks/flowgraph-tui` | — | not in this repo | **404** | mentioned as companion |
| `skill-pack-example` (`examples/skill-pack`) | 0.1.0 | **absent** | — | example only |
| unscoped `flowgraph` | — | root is private `0.0.0` | **taken** (`finnp/flowgraph@1.0.0`, “interactive graph editor in the browser”) | docs use this name for `npx` |

Shared gaps on every `packages/*` manifest: no `files`, no `publishConfig`, no `repository` / `homepage` / `bugs`, no `engines`, no package README (except `server`), no per-package LICENSE file, no `prepublishOnly`. Versions are aligned at `0.1.0`. No `link:` specifiers in any `package.json`. Internal deps use `workspace:*`.

`.changeset/config.json` has `"access": "public"` and `"ignore": []`. There are **zero changeset files**. There is **no CHANGELOG**. Root release script is `turbo run build --filter="./packages/*" && changeset publish`.

---

## Discarded stale hypotheses

These appear in older notes / `AGENTS.md` / numbered docs. **Current code disagrees.**

| Hypothesis | Current evidence |
|---|---|
| DTS build is red because `TestRunResult.status` omits `"paused"` and CLI compares a removed `"interrupted"` status | **Fixed.** `TestRunResult` includes `"paused"` (`packages/testing/src/index.ts`). CLI handles `interrupted` (exit 3) and `paused` (`packages/cli/src/commands.ts`). Commits `d113209`, `5f27250`. `AGENTS.md` “Pre-existing DTS build break” is stale. |
| `validate --preflight` does not run skill checks (`docs/09-cli.md`) | **Stale.** `commands.ts` runs `preflightGraphSkills` + `preflightGraphAgents` when `--preflight` is set. `IMPLEMENTATION_STATUS.md` is correct. |
| Skill preflight runs only when a skill node executes (`docs/09-cli.md`) | **Stale for CLI `run`/`resume`.** Those commands preflight before compile (`commands.ts` ~223). Execute-time preflight still also runs in `runSkill`. |
| Hosted schema URL is unpublished (`IMPLEMENTATION_STATUS.md` §Known limitations #3) | **URL is live** (`https://veloxdevworks.com/flowgraph/schema/v1.json`). Content is **behind** current spec (no `vendor: bedrock`, no `kind: cli`). |
| `examples/README.md` claims a local `examples/mcp/` folder | **It does not.** The example index correctly defers to `docs/15-mcp-operations.md`. Other docs still link a missing folder. |

`AGENTS.md` is not linked from consumer docs. It does not leak into the npm story, but it is now the *wrong* operator note for this checkout (DTS / lint / test-abort claims).

---

## 1. Ship blockers

Would be wrong or broken on npm, or would fail a first-hour follow-the-README.

### 1.1 `npx flowgraph` installs the wrong package

**Wrong:** Root README, `docs/09-cli.md`, and `docs/13-getting-started.md` tell consumers to run `npx flowgraph …`. The CLI package name is `@veloxdevworks/flowgraph-cli`; the bin inside it is `flowgraph`. Unscoped `flowgraph@1.0.0` is already on npm (finnp/flowgraph).

**Evidence:**

```36:37:README.md
npx flowgraph run triage.graph.yaml --input issue=@payload.json
```

```7:9:packages/cli/package.json
  "bin": {
    "flowgraph": "./dist/bin.js"
  },
```

`npm view flowgraph` → `flowgraph@1.0.0` “interactive graph editor in the browser”. `npm view @veloxdevworks/flowgraph-cli` → 404.

**Hurts:** CLI user, first-hour docs.

**Smallest fix:** Replace every `npx flowgraph` with `npx @veloxdevworks/flowgraph-cli` (or `pnpm dlx @veloxdevworks/flowgraph-cli`). Do not publish an unscoped `flowgraph` alias — the name is taken. Keep the “when published” qualifier until the 404s are gone.

### 1.2 Tarball hygiene: no `files`, no LICENSE, source + tests + turbo logs

**Wrong:** `npm pack` of `@veloxdevworks/flowgraph-core` is 129 files: `dist/**`, full `src/**` (including `*.test.ts`), `tsconfig.json`, `tsup.config.ts`, `.turbo/turbo-build.log`. **No LICENSE. No README.** CLI pack: 27 files, same pattern. Server pack includes `deploy/` terraform and `Dockerfile`.

Apache-2.0 requires the license text to travel with the work. npm pages will be empty (no README).

**Evidence:** `packages/*/package.json` have no `"files"`. Single repo `LICENSE` is not copied into package dirs. `npm pack --dry-run` on `packages/core` (this review).

**Hurts:** every npm consumer; legal/compliance; plugin authors reading source-in-tarball as public API.

**Smallest fix:** Add `"files": ["dist", "README.md", "LICENSE"]` to every publishable package; copy or root-reference LICENSE; add a one-screen package README. Exclude `deploy/` from the server tarball (or mark server private).

### 1.3 `workspace:*` in published dependencies / peers + `changeset publish`

**Wrong:** Foundation packages hard-depend on each other via `"workspace:*"`. CLI optional peers are also `workspace:*` (`checkpoint-sqlite`, `tools-fs`). Provider packages peer-depend on `core`/`spec` via `workspace:*`. Root script runs `changeset publish` (npm client), not `pnpm publish`.

pnpm rewrites `workspace:` on **`pnpm publish`**. Plain `npm publish` / default `changeset publish` can leave the literal `workspace:*` on the registry, which npm consumers cannot resolve.

**Evidence:** `packages/core/package.json` dependencies; `packages/cli/package.json` `peerDependencies`; `package.json` `"release": "… && changeset publish"`; `.npmrc` is only `auto-install-peers=false`.

**Hurts:** every npm install of CLI/core/plugins.

**Smallest fix:** Change release to `pnpm publish -r` (or `pnpm changeset publish`) and **inspect the packed `package.json`** before first publish. Prefer `workspace:^` so published peers become `^0.1.0`, not an exact pin. Add a CI “pack and assert no `workspace:`” check.

### 1.4 YAML `runtime.checkpoint.backend: sqlite|postgres` silently becomes memory

**Wrong:** Spec and docs treat `backend: sqlite` / `postgres` as durable. `resolveCheckpointer` only honors an injected `BaseCheckpointSaver` instance or `"memory"` / `"none"`. Any other backend string **returns `new MemorySaver()`** with no error.

CLI `run`/`resume` injects sqlite when the YAML says sqlite (`packages/cli/src/interrupts.ts` `checkpointerOption`). A library user who follows `docs/14-programmatic-api.md` (`checkpointer: "sqlite"`) does **not** get sqlite: `CompileOptions.checkpointer` is `"memory" | "none" | BaseCheckpointSaver` — the string `"sqlite"` is not a valid option, and if forced would still fall through to memory.

Postgres is never wired in the CLI. Only `packages/server` constructs `createPostgresCheckpointer` when `DATABASE_URL` is set.

**Evidence:**

```741:753:packages/core/src/compiler.ts
function resolveCheckpointer(spec: GraphSpec, opts: CompileOptions): BaseCheckpointSaver | undefined {
  // ...
  const backend = spec.runtime?.checkpoint?.backend ?? (opts.checkpointer as string) ?? "memory";
  if (backend === "memory") return new MemorySaver();
  // sqlite/postgres are provided by external packages and passed as instances.
  return new MemorySaver();
}
```

```71:74:docs/14-programmatic-api.md
const compiled = await compileGraph(spec, {
  cwd,
  checkpointer: "sqlite",  // or pass a BaseCheckpointSaver instance
```

**Hurts:** library user (silent data loss / “resume after restart” that cannot work); CLI user is OK for sqlite only.

**Smallest fix:** Fail compile when YAML asks for sqlite/postgres and no saver instance was passed. Fix `docs/14` to `createSqliteCheckpointer(path)` + pass the instance. Document that CLI sqlite is the only YAML-driven durable path.

### 1.5 Companion packages documented as `pnpm add` but do not exist

**Wrong:** README interactive mode, `docs/09-cli.md` §1.1, `docs/12-tui.md`, and `docs/15-mcp-operations.md` tell users to `pnpm add @veloxdevworks/flowgraph-tui` / `@veloxdevworks/flowgraph-mcp`. Those packages are **not in this monorepo** and **404 on npm**. CLI lazy-imports them and prints an install hint that cannot succeed.

`IMPLEMENTATION_STATUS.md` marks both **Shipped**.

**Evidence:** `packages/cli/src/commands.ts` `import("@veloxdevworks/flowgraph-tui")`; `packages/cli/src/mcp.ts` `lazyOptionalImport("@veloxdevworks/flowgraph-mcp")`; `pnpm-workspace.yaml` is only `packages/*`, `examples/*`, `automation/*`; `npm view` 404s.

**Hurts:** CLI user following TUI / MCP first-hour paths.

**Smallest fix:** Until those packages are published from the companion repo, mark TUI/MCP **not published** in README + status, and keep the install hint but add “not on npm yet — clone companion / wait”. Do not call them Shipped in the status matrix.

### 1.6 Accidental publishables: `skill-pack-example` and `flowgraph-server`

**Wrong:** Changesets `"ignore": []`. `examples/skill-pack` is named `skill-pack-example`, has no `"private": true`, and is in the pnpm workspace — a blanket `changeset publish` can release an unscoped example package. `@veloxdevworks/flowgraph-server` is likewise public-by-default, ships deploy terraform in the tarball, and is omitted from the root package tables.

**Evidence:** `examples/skill-pack/package.json`; `packages/server/package.json`; `.changeset/config.json`.

**Hurts:** npm namespace / ops (server); surprise unscoped publish (skill-pack).

**Smallest fix:** `"private": true` on `skill-pack-example` (or add it to changeset `ignore`). Decide server: either document + `files: ["dist"]` + README install, or `"private": true` until hosted-ops is an intentional release.

### 1.7 No changeset, no version policy, first publish would be a dump of `0.1.0`

**Wrong:** CONTRIBUTING requires a changeset per user-visible change. `.changeset/` has only `config.json`. There is no CHANGELOG and no published baseline. `pnpm release` as written would rely on Changesets seeing 0.1.0 as unpublished and (if it proceeds) emitting twelve public packages with the hygiene problems above.

**Hurts:** maintainers; consumers who cannot see what 0.1.0 contains.

**Smallest fix:** One initial changeset covering the foundation set; generate CHANGELOGs; dry-run publish to a local registry before npm.

---

## 2. Honesty gaps

Docs or README that lie, contradict code, or mix design-target with shipped.

### 2.1 Root README overclaims OTel and “Phases 1–4”

**Wrong:** “Every lifecycle moment emits a structured event **and an OpenTelemetry span with zero custom instrumentation**.” CLI has no `--otel`. `@veloxdevworks/flowgraph-observability-otel` exists; nothing in CLI attaches `otelSink`. YAML `runtime.observability.otel` is schema-only.

“Phases 1–4 largely complete” is directionally true for compiler/skills/HITL/providers, but MCP/TUI are not in this repo, OTel is not default, and several advertised events never fire (see 2.3).

**Evidence:** `README.md` “What it is”; `docs/09-cli.md` planned `--otel`; `packages/observability-otel/src/index.ts` (`otelSink`, `startOtel`); no CLI import of that package.

**Hurts:** CLI user, ops expecting traces out of the box.

**Smallest fix:** README: “events by default; OTel via `@veloxdevworks/flowgraph-observability-otel` + `otelSink` on `compileGraph`.” Point at `IMPLEMENTATION_STATUS.md` for phase caveats.

### 2.2 Programmatic API docs describe functions that do not exist

**Wrong:** `docs/01-architecture.md` §6 and `docs/07-runtime-and-execution.md` §1 use `runGraph(compiled, …)`, `runGraph.stream`, `getStateHistory(compiled, …)`, `resumeFrom`, `flowgraph run --resume`. Public API is `compiled.run` / `.stream` / `.resume` / `.continueRun` / `.getState` / `.getStateHistory`. There is no `runGraph` export and no `resumeFrom`. Resume is `flowgraph resume`, not `run --resume`.

`docs/14-programmatic-api.md` is the accurate page (except `checkpointer: "sqlite"` — §1.4). `continueRun` (pause/resume without HITL) is implemented and **not documented** in 14.

**Evidence:** `packages/core/src/index.ts` exports; `CompiledGraph` in `compiler.ts` lines 128–139; grep finds no `runGraph` / `resumeFrom` symbol.

**Hurts:** library user.

**Smallest fix:** Rewrite 01/07 samples to match 14 + `CompiledGraph`. Document `continueRun`. Mark `resumeFrom` planned only in 14/status (already).

### 2.3 Event taxonomy advertises types that are never emitted

**Wrong:** `EventType` and `docs/06-events-and-hooks.md` list `state.update`, `edge.taken`, `checkpoint.write`, `checkpoint.load`, and `graph.compile.*`. Repo-wide emit sites: `state.update` / `edge.taken` / `checkpoint.*` appear **only** as type literals. `graph.compile.*` is not even in `EventType`. Updates show up on `node.end` / `node.output`.

**Evidence:** `packages/core/src/events.ts` lines 19–36; grep for `"state.update"` / `"edge.taken"` / `"checkpoint.write"` hits only `events.ts`.

**Hurts:** library user, OTel/UI authors, anyone writing `eventsOfType(events, "state.update")`.

**Smallest fix:** Either emit them or remove them from `EventType` + docs 06 until they exist. Status already notes `state.update` / `edge.taken` in spirit; extend that note to checkpoint events.

### 2.4 `docs/09-cli.md` vs code (preflight, doctor, templates)

| Doc claim | Code |
|---|---|
| `validate --preflight` does not check skills | It does (`commands.ts`) |
| Run preflight only at skill execute | CLI preflights at run/resume start |
| `flowgraph new --template intelligent` | Template id is `agent`; `intelligent` is a deprecated alias |
| `skills doctor ./triage.graph.yaml` (`docs/04-skills.md`) | Doctor takes **skill directory paths**, not graph files (`skills-command.ts`) |

**Hurts:** CLI user.

**Smallest fix:** Align 09/04 with `IMPLEMENTATION_STATUS.md` + `commands.ts`. Doctor example → `flowgraph skills doctor ./skills/…` or `flowgraph validate --preflight`.

### 2.5 Node-type and hybrid-authoring drift

**Wrong:** Runtime canonical types are `agent` and `function`. Load-time aliases: `intelligent` → `agent`, `code` → `function` (`packages/core/src/loader.ts`). Docs still mix them: `docs/02-graph-spec.md` samples use `intelligent`; `docs/13-getting-started.md` table says `function` then “use **`code`**”; `docs/10-roadmap.md` Phase 1 exit cites `code`; `docs/15` agentic MCP table says `intelligent`.

`docs/03-node-types.md` has a **delay** section title; there is no `delay` type — use `wait`.

**Hurts:** graph author (confusion, not a runtime break — aliases work).

**Smallest fix:** Canonical names in all user-facing samples; one “aliases” footnote.

### 2.6 Getting-started / example READMEs that cannot be followed as written

| Path | Claim | Reality |
|---|---|---|
| `docs/13-getting-started.md` | Node ≥ 20, pnpm ≥ 9 | Root `engines`: Node `>=22.13`, pnpm `>=11`. CI is Node 22.x. Packages declare no `engines`. |
| `docs/13` “Next steps” | MCP → `examples/mcp/` | Directory **does not exist**. |
| `docs/15-mcp-operations.md` | `examples/mcp/atlassian-agent.graph.yaml` | Missing. |
| `examples/release-notes` | CLI `flowgraph run` / `resume` | Graph is `type: function` with **no `imports`**. CLI will not load `register.ts`. README’s own “import register before compile” is the real path; the CLI block is misleading. |
| `examples/review-loop` | `pnpm start` → `flowgraph run`; “None — zero API keys; uses registered `code` functions” | No `imports`. Functions are registered only in tests. Checkpoint backend is `memory` — resume after process exit cannot work. |
| `docs/IMPLEMENTATION_STATUS.md` examples table | `mcp` example “Yes” | Folder gone. |
| Hosted schema | Matches shipped spec | Live JSON omits `bedrock` and `kind: cli` that `packages/spec/src/schema.ts` and `docs/08-providers.md` document. |

`software-factory` and `reducers` **do** load `register.ts` via `imports: [{ reducers: ./register.ts }]`. That pattern is the one that works and is under-documented as the way to register `function`s (there is no `imports[].functions`).

**Hurts:** CLI user walking HITL / MCP / “first graph with functions”.

**Smallest fix:** Add `imports: [{ reducers: ./register.ts }]` (or a real `providers`/`nodes` import) to release-notes and review-loop; or stop showing CLI commands for those examples. Redeploy schema from current `generateJsonSchema()`. Delete or retarget `examples/mcp` links. Engines: document ≥22.13 everywhere.

### 2.7 Mock provider in docs without registration

**Wrong:** `docs/08-providers.md` shows `type: agent` / `provider: mock` with no registration step. `mockProvider` lives in core and is **not** auto-registered by CLI or `compileGraph`. Graphs must pass `{ providers: [mockProvider] }` or `imports: [{ providers: … }]`.

**Evidence:** `packages/core/src/providers/mock.ts`; CLI `buildProviders()` only builds YAML `providers:` / vendor shorthand; `AGENTS.md` “Providers gotcha” (this part is still true).

**Hurts:** CLI user copying the MCP/agent sample; anyone expecting `provider: mock` to just work.

**Smallest fix:** One paragraph + a 5-line `imports` example. Optionally auto-register `mock` in CLI when `provider: mock` is referenced (product change; not required to publish if docs are honest).

### 2.8 Design docs still read as the product

`docs/README.md` admits “code samples describe the **target design**,” but 00–12 are the indexed “read in this order” path. Concrete overclaims beyond those above:

- `docs/07`: `CheckpointerAdapter`; checkpoint lifecycle events + `checkpoint:beforeWrite` hook; `ask_human` **is** implemented (`packages/core/src/providers/ask-human.ts`) — keep that.
- `docs/04`: `checkSkillEnv(skill, ctx)` — not an export; real API is `preflightSkill` / `preflightGraphSkills`.
- `docs/01`: `@veloxdevworks/flowgraph-spec` “no runtime dependencies (only Zod)” — also depends on `zod-to-json-schema`. Architecture tree omits `server`.
- `docs/03` / `docs/05`: desktop builder, canvas, Run History — **flowgraph-app/desktop**, not this package.
- `CONTRIBUTING.md`: “Prettier + ESLint are enforced in CI”; “`pnpm build && pnpm test && pnpm typecheck` — all must pass.” CI (`.github/workflows/ci.yml`) has no lint job; `pnpm lint` is a no-op (no package `lint` tasks). Example validate is `continue-on-error: true`. Roadmap Phase 0 claims `CODE_OF_CONDUCT` — file is absent.

**Hurts:** new contributors more than npm users; still poisons the docs site if 00–12 are published as-is.

**Smallest fix:** Banner on 00–12: “design spec; shipped = IMPLEMENTATION_STATUS + 13–16.” Strip desktop UI sentences from 03/05 or mark “desktop app (separate repo).”

### 2.9 Skill `kind_of: agent | composite` is in the schema, not the runner

**Wrong:** `SkillKindSchema` allows `executable | command | agent | composite`. `runSkill` only handles `executable` and `command`.

**Evidence:** `packages/skills/src/schema.ts`; `packages/core/src/nodes/skill-runner.ts` lines 48–65.

**Hurts:** skill author.

**Smallest fix:** Document only `executable`/`command` as shipped; reject the others at validate, or drop them from the Zod enum until implemented.

---

## 3. Missing pieces

A serious consumer of this kind of product would notice. Not all are publish blockers if labeled.

### 3.1 Plugins / packages expected but absent or unwired

| Expected | Status |
|---|---|
| MCP hub | Interface in core (`McpHub`); implementation **not in this repo**, not on npm |
| TUI | CLI command only; package **not in this repo**, not on npm |
| Postgres checkpointer | Package exists; **no CLI wiring**, no example |
| OTel | Package exists; **not on CLI**, no example |
| OpenAI / Gemini / Bedrock **provider packages** | Not needed — LangChain vendor adapters live in core; Bedrock is in spec, missing from hosted schema |
| Redis / remote checkpointer | Not present (fine for 0.1 if undocumented) |
| Published skill pack | `examples/skill-pack` is local; name `skill-pack-example` is not scoped |

### 3.2 Public API holes (implemented vs advertised)

| Surface | Shipped? | Notes |
|---|---|---|
| `compileGraph` / `run` / `resume` / `getState` / `getStateHistory` / `stream` | yes | |
| `continueRun` (paused threads) | yes | Undocumented in 14 |
| `resumeFrom(checkpointId)` | no | Planned |
| `CompiledGraph.step` / `flowgraph dev` | no | Planned |
| HITL `ctx.interrupt`, `hitl` node, `--on-interrupt` | yes | |
| Durable resume (CLI + sqlite package) | yes | YAML-only / programmatic string `"sqlite"` is not |
| Skills loader + doctor + run preflight | yes | Nested skill refs inside map/subgraph/agent tools **not** scanned (`discover-skills.ts` comment; status #1 accurate) |
| Map | yes | Inner events lack `parentSpanId` (status #4 accurate; verified `nodes/map.ts`) |
| Subgraph + nested `parentSpanId` | yes | |
| Mock / dry-run | mock exists, not auto-registered; no dry-run mode | |
| Token streaming | `agent.token` type exists; LangChain/mock/cli advertise `streaming: false` | |
| `flowgraph.config.ts` | no | |
| Triggers (`cron`, `webhook`, …) | schema only; host-interpreted (`docs/02` is honest) | |
| YAML hook phases `skill:*`, `router:*`, `checkpoint:*`, `interrupt:*` | listed; compiler invokes a smaller set | |

### 3.3 Docs pages that do not exist (named)

For a 0.1 consumer, the missing **pages** (not “more docs”) are:

1. **`docs/17-install-from-npm.md`** (or a rewritten 13) — scoped package names, `npx @veloxdevworks/flowgraph-cli`, Node 22.13, optional peers table that matches `package.json`.
2. **Per-package READMEs** on npm — especially `core`, `cli`, `checkpoint-sqlite`, `provider-*`.
3. **A “register functions for CLI” page** — `imports: [{ reducers: ./register.ts }]` (current working hack) vs programmatic `registerFunction`.
4. **Postgres + OTel recipes** — 15-line `compileGraph` snippets; do not pretend CLI flags exist.
5. **CHANGELOG / 0.1.0 release notes** — what is supported vs experimental. Nothing is marked `experimental` in code; README correctly says pre-1.0.

### 3.4 Stability

- `apiVersion: flowgraph/v1` is a strict literal; APIs are pre-1.0 (README is honest).
- Deprecated but working: `intelligent` / `code` node types, `intelligent` template, `IntelligentWithSchema` / `CodeWithSchema`.
- No `experimental` flag. Treat everything as **0.x unstable** until a versioning policy exists (roadmap: planned).

---

## 4. Nice-to-have

- `"types"` before `"import"` in `exports` (TS recommendation).
- CLI `package.json` has `exports` but no `main`/`types` (works; slightly odd).
- Declare `@veloxdevworks/flowgraph-mcp` and `-tui` as **optional peers** of CLI once they exist (today only sqlite + tools-fs are peers; MCP/TUI/providers are undeclared lazy imports).
- `observability-otel` has no peer on `core` (intentional structural typing) — fine; mention in its README.
- `getStateHistory` not exposed in CLI — OK if 14 says so (status already does).
- Root `devDependencies` includes `@veloxdevworks/flowgraph-cli` `workspace:*` — fine.
- Copy `LICENSE` via a small prepublish script instead of twelve copies.
- Hosted docs site (`veloxdevworks.com/flowgraph`) clone/build path is more honest than GitHub README `npx`; keep them in sync after the npx fix.
- `CODE_OF_CONDUCT` claimed in roadmap Phase 0 — add or drop the claim.
- Example validate in CI should not be `continue-on-error: true` before calling the suite “green.”

---

## Consumer-path scorecard

| Path | Docs alone? | Blocker / gap |
|---|---|---|
| Install CLI | **No** | `npx flowgraph` → wrong package; scoped packages 404 |
| Write YAML | Mostly | Alias drift; hosted schema missing bedrock/cli |
| Run (monorepo) | Yes | `node packages/cli/dist/bin.js` / example `pnpm start` |
| Run (npm) | **No** | Not published; wrong npx name |
| Resume | CLI+sqlite yes | Programmatic `"sqlite"` lie; release-notes CLI needs `imports` |
| HITL | Concept yes | `hitl` example needs API key; review-loop CLI broken |
| Add LangChain / Claude / Cursor provider | Mostly | YAML `providers:` + install SDK; docs 08 is usable |
| Add mock provider | **No** | Not auto-registered |
| Add sqlite checkpointer | CLI yes | Library user must pass an instance |
| Add postgres checkpointer | Partial | Package only; no CLI |
| Function / shell / script node | Yes if they use shell/script | Function + CLI needs `imports` pattern |
| Subgraph / map | Yes | `examples/composition` is test-centric (honest) |
| Skills | Yes (quickstart) | `skills doctor` graph-path example wrong |
| MCP | **No** | Package + example missing |
| Streaming (CLI events) | Yes | `--stream` / `--json`; not LLM token streaming |
| TUI | **No** | Package missing |
| Testing harness | Yes | 14 matches `@veloxdevworks/flowgraph-testing` |
| OTel | Partial | Package exists; README/vision overclaim |

---

## Recommended publish sequence

Do not run `pnpm release` / `changeset publish` until the checklist below is true.

### Before any `npm publish`

1. **Install story:** replace `npx flowgraph` everywhere; document `npx @veloxdevworks/flowgraph-cli`. Confirm you will not fight finnp/flowgraph for the unscoped name.
2. **Manifests:** `files`, LICENSE, README, `repository`/`homepage`/`bugs`, `engines: { "node": ">=22.13" }` on every public package.
3. **Workspace protocol:** publish via **pnpm** and verify packed `package.json` has semver, not `workspace:*`. Switch peers to `workspace:^`.
4. **Ignore / private:** `skill-pack-example` private or ignored; explicit decision on `flowgraph-server`.
5. **Fail-fast checkpointer:** unknown/uninjected `sqlite`/`postgres` must error, not `MemorySaver`.
6. **Docs honesty pass (minimum):** README OTel sentence; 14 `checkpointer: "sqlite"`; 09 preflight; MCP/TUI “not on npm”; delete `examples/mcp` links; engines 22.13; release-notes/review-loop CLI or `imports`.
7. **Initial changeset** + generated CHANGELOG. Dry-run to a local registry (`verdaccio` or `pnpm publish --dry-run` per package).
8. **CI:** current `main` DTS story looks green (stale `AGENTS.md` aside). Keep `pnpm build && pnpm typecheck && pnpm test` actually passing on the commit you tag.

### Package order (once the above is true)

1. **`spec` → `expr` → `skills` → `core`**  
   No optional native deps. This is the library minimum. `core` pulls the first three as dependencies (rewritten to `0.1.0` / `^0.1.0`).
2. **`testing`** (depends on core+spec). Safe once core types include `"paused"` (they do).
3. **`cli`**  
   Only after install docs use the scoped name and optional peers rewrite correctly. Bin: `flowgraph`.
4. **Adapters:** `provider-claude`, `provider-cursor` (peers: core, spec, vendor SDK).
5. **Plugins:** `checkpoint-sqlite` (needed for the documented HITL CLI path), then `tools-fs`, `checkpoint-postgres`, `observability-otel`.
6. **`server`** last, or not in 0.1.0 — hosted/ECS/AgentCore, not a first-hour CLI dependency.
7. **`mcp` / `tui`** from the companion repo **as their own release**, then flip README from “not published” to install instructions. Do not mark them Shipped in this repo until `npm view` succeeds.

### What “0.1.0 is honest” means

Supported in 0.1: YAML `flowgraph/v1` load/validate/compile; built-in nodes (`agent`/`function` + aliases, skill, router, http, webhook, mcp **node** without hub, shell, script, service, port, demo, subgraph, map, hitl, wait); CLI `run`/`validate`/`graph`/`schema`/`migrate`/`resume`/`new`/`skills {doctor,list,resolve}`; in-memory + CLI-injected sqlite checkpoints; LangChain-in-core + optional Claude/Cursor packages; `@veloxdevworks/flowgraph-testing`.

Not supported in 0.1 (say so): npm `npx flowgraph`; TUI; MCP hub; CLI postgres/OTel flags; `resumeFrom` / `dev --step`; mock auto-register; `state.update` / `edge.taken` / `checkpoint.*` events; skill kinds `agent`/`composite`; published skill packs.

Tag the GitHub repo and npm `repository` field as `https://github.com/veloxdevworks/flowgraph` (this repo). Do not point package metadata at private `flowgraph-app`.
