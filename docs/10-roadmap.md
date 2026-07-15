# 10 — Roadmap

A phased plan from empty repo → community-ready v1.0. Each phase ends with a **demoable, tested vertical slice**. Phases are sequenced so the riskiest assumptions (LangGraph wrapping, the compile pipeline, HITL/durability) are proven early.

> Estimates are relative sizing (S/M/L), not calendar commitments.

## Current progress (as of Phase A docs pass)

| Phase | Status | Notes |
|-------|--------|-------|
| 0 — Foundations | **Done** | Monorepo, CI, packages scaffolded |
| 1 — Spec + Compiler | **Done** | `triage-issue` runs with `code` + `router` + `skill` |
| 2 — Skills | **Done** | `skills doctor`, skill packs, preflight |
| 3 — Durability & HITL | **Mostly done** | `release-notes` + `resume`; `dev --step` / `resumeFrom` planned |
| 4 — Intelligent + providers | **Done** | Claude, Cursor, LangChain adapters; MCP agent tools |
| 5 — Composition & scale | **Partial** | `map` + `subgraph` + nested HITL shipped; `software-factory` lifecycle example shipped (fan-out via `composition`) |
| 6 — Observability (full) | **Partial** | OTel package exists; CLI `--otel` not wired; full hook surface partial |
| 7 — DX & docs | **In progress** | Getting started, implementation status, docs site scaffold |

See [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md) for the detailed shipped vs planned matrix.

## Phase 0 — Foundations (repo scaffold)  · S ✓

**Goal:** a working monorepo that builds, lints, tests, and releases nothing yet.

- pnpm workspace + Turborepo + tsconfig base + tsup + Vitest + Changesets ([ADR-0006](./adr/0006-monorepo-tooling.md)).
- Empty packages: `core`, `spec`, `expr`, `skills`, `cli`, `testing`.
- CI: install, build, typecheck, test, lint on PR.
- `LICENSE` (Apache-2.0, [ADR-0008](./adr/0008-license.md)), root `README`, `CONTRIBUTING`, `CODE_OF_CONDUCT`.

**Exit:** `pnpm build && pnpm test` green; `npx flowgraph --help` prints (stub). ✓

## Phase 1 — Spec + Compiler core (deterministic only)  · L ✓

**Goal:** YAML → LangGraph `StateGraph` for deterministic nodes. The make-or-break slice.

- `@veloxdevworks/flowgraph-spec`: Zod schema for `apiVersion/kind/metadata/state/nodes/edges/config/runtime`; JSON Schema generation.
- `@veloxdevworks/flowgraph-expr`: safe expression parser/evaluator + stdlib + compile-time reference checking.
- `@veloxdevworks/flowgraph-core`: load → parse → validate → resolve → build pipeline; Node Registry; reducers; built-in nodes `http`, `code`, `router` (rules mode), `wait`.
- Event bus + `console`/`jsonl` sinks; node middleware (events only).
- `@veloxdevworks/flowgraph-cli`: `validate`, `graph`, `run` (basic), `init`.
- `@veloxdevworks/flowgraph-testing`: in-memory harness + golden-run helper.

**Exit:** the `triage-issue` example runs end-to-end using `http` + `router` + `code` (no LLM), fully traced via events; `flowgraph validate` catches a curated set of bad specs. ✓

## Phase 2 — Skills  · M ✓

**Goal:** portable, contract-bearing, env-aware skills.

- `@veloxdevworks/flowgraph-skills`: `SKILL.md` front-matter parser; `inputs`/`outputs` contract validation; `kind_of: executable | command`; `ctx` (secrets/http/logger/emit).
- `skill` node type; skill resolution (alias/path/package); skill packs.
- Preflight (`env.vars/bin/network/node/packages`) + `flowgraph skills doctor`.
- Secret provider (env/dotenv) + redaction layer.

**Exit:** `triage-issue` files a real ticket via a `skill`; `flowgraph skills doctor` reports env readiness; secrets never appear in events/logs. ✓

## Phase 3 — Durability & HITL  · L (mostly ✓)

**Goal:** checkpoint, interrupt, resume — proven across a process restart.

- Checkpointer adapter over LangGraph `BaseCheckpointSaver`; `MemorySaver` + `@veloxdevworks/flowgraph-checkpoint-sqlite`.
- `ctx.interrupt()`, static breakpoints, `wait` (signal / webhook) nodes.
- `flowgraph resume`; `--on-interrupt` policies; `ctx.once` idempotency.
- Time-travel: `getStateHistory` ✓; `resumeFrom`, `flowgraph dev --step` — **planned**.

**Exit:** `release-notes` example pauses for approval, the process exits, and a later `flowgraph resume` continues from the durable checkpoint to publish. ✓

## Phase 4 — Agent nodes + providers  · L ✓

**Goal:** hub-and-spoke agent nodes with pluggable backends.

- `ProviderAdapter` interface + tool normalization + `agent` node ([ADR-0003](./adr/0003-intelligent-node-hub-and-spoke.md)).
- LangChain provider built into `@veloxdevworks/flowgraph-core` (broadest model coverage, simplest loop); `@veloxdevworks/flowgraph-provider-claude` (Claude Agent SDK) and `@veloxdevworks/flowgraph-provider-cursor` as optional lazy-loaded packages.
- Skills/nodes/MCP as tools; structured output (`schema`); `permission: ask` → HITL.
- `intelligent.*` events; token/cost accounting + `runtime.budget`.
- `router` model mode.

**Exit:** `triage-issue` uses an `intelligent` summarize+classify with a skill exposed as a tool; works on ≥2 providers by swapping `provider:`. ✓ (via separate agent examples; triage-issue remains deterministic)

## Phase 5 — Composition & scale  · M (partial)

**Goal:** build real "software factories."

- `subgraph` + `map` (fan-out/fan-in) nodes ✓; child-run nesting in events/traces ✓.
- Custom node plugin packages (`imports[].nodes`); custom reducers via `imports[].reducers`; custom providers via `imports[].providers`.
- `global concurrency`, robust retry/backoff, abort propagation hardening.

**Exit:** the `software-factory` example runs a prototype vs production lifecycle with quality gates, fix loops, and human review — durable + traced. ✓ (map/subgraph fan-out demonstrated separately in `composition`)

## Phase 6 — Observability & hooks (full)  · M (partial)

**Goal:** production-grade observability and the enhancement surface.

- `@veloxdevworks/flowgraph-observability-otel` ✓ (package shipped; CLI `--otel` wiring pending).
- Full hook system (all phases, mutate/veto/route/retry/interrupt); YAML-bindable hook subset.
- Default guardrail hooks (redaction, budget, max-steps) as overridable defaults.
- Audit-log sink; cost dashboards via metrics.

**Exit:** an end-to-end OTel trace of a multi-node run in a collector with zero custom instrumentation; a `beforeToolCall` hook gates `Bash` behind approval.

## Phase 7 — DX, docs, hardening for community v1.0  · M (in progress)

**Goal:** something the OSS community adopts standalone.

- Tutorials + cookbook (the three north-star examples as guided walkthroughs) — **partial** ([13 — Getting started](./13-getting-started.md), example READMEs).
- JSON Schema published for editor autocomplete ✓ (`flowgraph schema`); hosted at `veloxdevworks.com/flowgraph/` — **in progress**; `flowgraph new` templates ✓.
- API reference (typedoc) — **planned**; semantic-versioning policy — **planned**; `flowgraph migrate` ✓ (shipped, no longer skeleton-only).
- `@veloxdevworks/flowgraph-checkpoint-postgres`; durable LangGraph `Store` backends (in-memory `ctx.store` shipped early).
- Performance pass; fuzz/property tests for spec + expr; example skill pack published to npm.

**Exit:** v1.0.0 release via Changesets; external user authors+runs a non-trivial graph with zero TS; stable `flowgraph/v1` contract.

## Cross-cutting tracks (continuous)

- **Testing:** golden-run integration per example; provider adapters tested against recorded fixtures (no live keys in CI); expr/spec property tests.
- **Stability:** `apiVersion` contract discipline; additive-only changes within `v1`.
- **Security:** secret redaction tests; sandboxed expr evaluator; supply-chain (provenance, lockfile, minimal deps in `core`).
- **Docs:** these specs evolve with implementation; ADRs added for new decisions.

## Sequencing rationale

1. **Prove the wrapper early (Phase 1).** If compiling YAML → `StateGraph` with clean events isn't pleasant, nothing else matters.
2. **Skills before intelligence (Phase 2 < 4).** Skills are the reusable contract unit and become agent tools; getting contracts/preflight right first makes agent nodes' tool layer fall out naturally.
3. **Durability before agents (Phase 3 < 4).** Agent loops are long-running and the prime HITL consumer; we want resume/interrupt solid before adding them.
4. **Observability/hooks full build last (Phase 6).** Events exist from Phase 1 (so we can see everything early); the heavy OTel + full hook system lands once the surfaces are stable.

## Decided

- **Name:** `flowgraph` (scope `@veloxdevworks/flowgraph-*`, CLI `flowgraph`, `apiVersion: flowgraph/v1`) — [ADR-0013](./adr/0013-rename-to-flowgraph.md).
- **License:** Apache-2.0 — [ADR-0008](./adr/0008-license.md).

## Open items to confirm (tracked)

- Verify `@veloxdevworks/flowgraph-*` package names and `veloxdevworks/flowgraph` GitHub repo availability before first publish ([ADR-0013](./adr/0013-rename-to-flowgraph.md)).
- CLI framework choice (clipanion vs commander+prompts) — decided in Phase 1.
- Minimum supported Node version (proposed ≥ 20).
