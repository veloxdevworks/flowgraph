# Implementation status

This document tracks what is **shipped** in the monorepo today versus what the numbered design docs describe as the **target**. When in doubt, trust `packages/` and `examples/` over aspirational spec text.

Last reviewed: 0.1 publish hygiene (tarballs, fail-fast checkpointer, honest consumer docs).

## Summary

| Area | Status |
|------|--------|
| YAML spec + Zod validation + JSON Schema | **Shipped** |
| Compiler + runtime (`loadGraph` → `compileGraph` → `run`/`resume`/`continueRun`/`stream`) | **Shipped** |
| Built-in node types (incl. `script`, `demo`, `service`, `port`) | **Shipped** |
| Skills loader, contracts, preflight | **Shipped** |
| Expression language (`@veloxdevworks/flowgraph-expr`) | **Shipped** |
| Events + console/jsonl sinks | **Shipped** (nested subgraph events forward with `parentSpanId`) |
| Hooks (YAML subset + guardrails) | **Shipped** (partial defaults) |
| HITL + in-memory checkpointing | **Shipped** |
| Providers: LangChain (in core), Claude, Cursor | **Shipped** |
| MCP hub (stdio, HTTP, OAuth) | **Companion** (`@veloxdevworks/flowgraph-mcp` — not in this repo, **not published** with 0.1) |
| Local FS tools + governance | **Shipped** (`@veloxdevworks/flowgraph-tools-fs` optional peer of CLI) |
| SQLite checkpointing (CLI) | **Shipped** (`@veloxdevworks/flowgraph-checkpoint-sqlite` optional peer of CLI) |
| TUI (`@veloxdevworks/flowgraph-tui`) | **Companion** — not in this repo, **not published** with 0.1 |
| Postgres checkpointer package | **Shipped** (no CLI default, no example) |
| OTel package | **Shipped** as `@veloxdevworks/flowgraph-observability-otel` (attach `otelSink()` yourself; CLI `--otel` unwired) |
| HTTP server | **In repo, not in 0.1 npm** (`@veloxdevworks/flowgraph-server` is changeset-ignored) |
| `software-factory` example | **Shipped** (lifecycle demo; map fan-out covered by `composition`) |

## CLI commands

| Command / flag | Status | Notes |
|----------------|--------|-------|
| `run`, `validate`, `graph`, `schema`, `migrate` | **Shipped** | |
| `resume`, `new`, `init` | **Shipped** | `init` = alias for `new`; default `hello` template is zero-code runnable |
| `tui` | **Companion** | Command exists; package not published |
| `skills doctor`, `list`, `resolve` | **Shipped** | |
| `skills show`, `skills new` | **Planned** | Documented in spec, not implemented |
| `mcp tools`, `mcp auth *` | **Companion** | Lazy-load unpublished `@veloxdevworks/flowgraph-mcp` |
| `dev` | **Planned** | Watch/step mode |
| Global `--config`, `--env-file`, `--otel`, `--quiet` | **Planned** | Dotenv loaded silently from cwd |
| `run --checkpoint`, `--max-usd` | **Planned** | Use `runtime.checkpoint` / `runtime.budget` in YAML |
| `validate --preflight` | **Shipped** | Checks skill env/bin deps; `flowgraph run` also preflights before execution |
| `validate` glob patterns | **Planned** | Single file path only |

See [09 — CLI](./09-cli.md) for the authoritative command reference.

## Runtime API

| API | Status | Notes |
|-----|--------|-------|
| `compileGraph`, `CompiledGraph.run`, `.resume`, `.continueRun`, `.stream`, `.getState` | **Shipped** | |
| `getStateHistory` | **Shipped** | On `CompiledGraph`; not exposed in CLI |
| `resumeFrom` | **Planned** | Not an API today — do not document as shipped |
| `runGraph` / `runGraph.stream` | **Does not exist** | Use `compiled.run` / `compiled.stream` |
| `CompiledGraph.step` / `flowgraph dev --step` | **Planned** | Time-travel debugging |
| `flowgraph.config.ts` auto-discovery | **Planned** | Register nodes/providers via imports in YAML today |

## Known limitations

1. **Skill preflight scope** — Upfront preflight scans top-level `skill` nodes only; nested skill refs inside `map`/`subgraph`/agent tools are not scanned yet.
2. **OTel CLI wiring** — `@veloxdevworks/flowgraph-observability-otel` exists; attach sinks programmatically or wait for `--otel`.
3. **Schema hosting** — `https://veloxdevworks.com/flowgraph/schema/v1.json` published when docs site deploys; local via `flowgraph schema --out`.
4. **Map per-item event scope** — `map` inner events share the parent bus but do not set `parentSpanId` per iteration (no per-item canvas node). Subgraph nesting does set `parentSpanId`.
5. **README phase label** — Root README updated to reflect Phases 1–4 progress; some numbered docs still describe future targets inline.

## Examples

| Example | README | Runnable | Integration test |
|---------|--------|----------|------------------|
| quickstart | Yes | Yes (zero-code) | Yes |
| triage-issue | Yes | Yes (requires `run.js`) | Yes |
| release-notes | Yes | Yes (requires `register.ts`) | Yes |
| composition | Yes | Yes (requires `register.ts`) | Yes |
| skill-pack | Yes | Test-only | Yes |
| review-loop | Yes | Yes (`register.ts`) | Yes |
| hitl | Yes | Yes (scripted provider in test) | Yes |
| fs-agent | Yes | Yes (API key for live run) | Yes |
| mcp | — | **No folder** in this repo | — |
| claude-agent, cursor-agent, reducers | Yes | Yes | reducers: Yes |
| software-factory | Yes | Yes | Yes |

## Documentation layers

| Layer | Purpose |
|-------|---------|
| `docs/00`–`12` | Design specifications (target + shipped, mixed) |
| `docs/13`–`15` | User-facing operational guides |
| `examples/*/README.md` | Runnable walkthroughs |
| Hosted docs site | Private `flowgraph-app` companion — **will lag** until that repo syncs (markdown source stays in `docs/`) |

When adding features, update this file and the relevant CLI/spec doc in the same PR.
