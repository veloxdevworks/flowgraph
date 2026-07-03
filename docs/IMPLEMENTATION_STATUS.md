# Implementation status

This document tracks what is **shipped** in the monorepo today versus what the numbered design docs describe as the **target**. When in doubt, trust `packages/` and `examples/` over aspirational spec text.

Last reviewed: Phase A documentation pass (Phases 1–4 largely complete).

## Summary

| Area | Status |
|------|--------|
| YAML spec + Zod validation + JSON Schema | **Shipped** |
| Compiler + runtime (`loadGraph` → `compileGraph` → `run`/`resume`) | **Shipped** |
| Built-in node types (11) | **Shipped** |
| Skills loader, contracts, preflight | **Shipped** |
| Expression language (`@veloxdevworks/flowgraph-expr`) | **Shipped** |
| Events + console/jsonl sinks | **Shipped** |
| Hooks (YAML subset + guardrails) | **Shipped** (partial defaults) |
| HITL + in-memory checkpointing | **Shipped** |
| Providers: LangChain (in core), Claude, Cursor | **Shipped** |
| MCP hub (stdio, HTTP, OAuth) | **Shipped** (`@veloxdevworks/flowgraph-mcp` optional peer of CLI) |
| Local FS tools + governance | **Shipped** (`@veloxdevworks/flowgraph-tools-fs` optional peer of CLI) |
| SQLite checkpointing (CLI) | **Shipped** (`@veloxdevworks/flowgraph-checkpoint-sqlite` optional peer of CLI) |
| TUI (`@veloxdevworks/flowgraph-tui`) | **Shipped** |
| Postgres checkpointer package | **Shipped** (no CLI default, no example) |
| OTel package | **Shipped** (not wired to CLI `--otel`) |
| `software-factory` example | **Not started** (Phase 5 exit) |

## CLI commands

| Command / flag | Status | Notes |
|----------------|--------|-------|
| `run`, `validate`, `graph`, `schema`, `migrate` | **Shipped** | |
| `resume`, `tui`, `new`, `init` | **Shipped** | `init` = alias for `new`; default `hello` template is zero-code runnable |
| `skills doctor`, `list`, `resolve` | **Shipped** | |
| `skills show`, `skills new` | **Planned** | Documented in spec, not implemented |
| `mcp tools`, `mcp auth *` | **Shipped** | |
| `dev` | **Planned** | Watch/step mode |
| Global `--config`, `--env-file`, `--otel`, `--quiet` | **Planned** | Dotenv loaded silently from cwd |
| `run --checkpoint`, `--max-usd` | **Planned** | Use `runtime.checkpoint` / `runtime.budget` in YAML |
| `validate --preflight` | **Partial** | Flag exists; handler ignores it |
| `validate` glob patterns | **Planned** | Single file path only |

See [09 — CLI](./09-cli.md) for the authoritative command reference.

## Runtime API

| API | Status | Notes |
|-----|--------|-------|
| `compileGraph`, `CompiledGraph.run`, `.resume`, `.getState` | **Shipped** | |
| `getStateHistory` | **Shipped** | On `CompiledGraph`; not exposed in CLI |
| `resumeFrom` | **Planned** | Referenced in [07 — Runtime](./07-runtime-and-execution.md) |
| `runGraph.step` / `flowgraph dev --step` | **Planned** | Time-travel debugging |
| `flowgraph.config.ts` auto-discovery | **Planned** | Register nodes/providers via imports in YAML today |

## Known limitations

1. **Nested subgraph HITL** — Interrupts inside embedded subgraphs throw at runtime (`nested HITL is not yet supported`).
2. **Skill preflight timing** — Env checks run when a skill node executes, not upfront on `flowgraph run`.
3. **OTel CLI wiring** — `@veloxdevworks/flowgraph-observability-otel` exists; attach sinks programmatically or wait for `--otel`.
4. **Schema hosting** — `https://veloxdevworks.com/flowgraph/schema/v1.json` published when docs site deploys; local via `flowgraph schema --out`.
5. **README phase label** — Root README updated to reflect Phases 1–4 progress; some numbered docs still describe future targets inline.

## Examples

| Example | README | Runnable |
|---------|--------|----------|
| quickstart | Yes | Yes (zero-code) |
| triage-issue | Yes | Yes (requires `run.js`) |
| release-notes | Yes | Yes (requires `register.ts`) |
| composition | Yes | Yes (requires `register.ts`) |
| skill-pack | Yes | Test-only |
| mcp | Yes | Yes (mock + optional OAuth) |
| hitl, fs-agent, claude-agent, cursor-agent, reducers | Yes | Yes |
| software-factory | N/A | **Not built** |

## Documentation layers

| Layer | Purpose |
|-------|---------|
| `docs/00`–`12` | Design specifications (target + shipped, mixed) |
| `docs/13`–`15` | User-facing operational guides |
| `docs/adr/` | Locked architecture decisions |
| `examples/*/README.md` | Runnable walkthroughs |
| `apps/docs/` | Public docs website (Vite + React) |

When adding features, update this file and the relevant CLI/spec doc in the same PR.
