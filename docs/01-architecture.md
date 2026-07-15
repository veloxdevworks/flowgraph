# 01 — Architecture

## 1. Layered view

flowgraph is organized as concentric layers. Inner layers never depend on outer layers.

```
┌──────────────────────────────────────────────────────────────────┐
│ L5  Surfaces        CLI  •  programmatic API  •  (future GUI*)     │
├──────────────────────────────────────────────────────────────────┤
│ L4  Authoring       YAML spec  •  SKILL.md  •  JSON Schema/IDE     │
├──────────────────────────────────────────────────────────────────┤
│ L3  Compiler        validate → resolve → build StateGraph         │
├──────────────────────────────────────────────────────────────────┤
│ L2  Runtime         event bus • hooks • checkpointing • HITL •     │
│                     OTel • retries • secrets/context              │
├──────────────────────────────────────────────────────────────────┤
│ L1  Extensions      Node Registry • Providers • Skills • Channels │
├──────────────────────────────────────────────────────────────────┤
│ L0  Engine          LangGraph.js  (StateGraph, channels, pregel,  │
│                     checkpointers, interrupt/Command)             │
└──────────────────────────────────────────────────────────────────┘
        * GUI is a separate downstream project; out of scope here.
```

- **L0 Engine** — LangGraph.js. We treat it as a stable dependency and stay close to its primitives.
- **L1 Extensions** — the pluggable building blocks: node types (registry), intelligent-node providers, skills, custom channels/reducers.
- **L2 Runtime** — cross-cutting machinery wrapped around graph execution: events, hooks, checkpoint/store, HITL, retries, OTel, secret/context injection.
- **L3 Compiler** — turns a validated spec into a compiled LangGraph graph.
- **L4 Authoring** — the human-facing artifacts: the YAML graph spec, the `SKILL.md` format, and the generated JSON Schema for editor validation/autocomplete.
- **L5 Surfaces** — how you invoke it: the `flowgraph` CLI and the programmatic API. (The future GUI is an L5 surface in a *different* repo.)

## 2. Compilation pipeline

The compiler is a deterministic pipeline. Each stage has a typed input/output so stages are independently testable.

```
 load          parse           validate         resolve            build           ready
 ────►  raw  ──────►  spec  ──────────►  spec'  ──────────►  plan  ──────►  StateGraph  ──►
 files          (YAML→JSON)   (Zod + refs)   (registry +        (LangGraph
 + env                         + lint        skills + providers)  builder calls)
```

1. **Load** — read the graph file + referenced files (skills, imported subgraphs, `$ref`s). Resolve relative paths, apply layered config (defaults → file → env → CLI flags).
2. **Parse** — YAML → JS object. Strict YAML (no anchors-as-code, no arbitrary tags).
3. **Validate** — Zod schema validation + semantic lint (unknown node refs, unreachable nodes, missing `START`/`END` paths, channel/contract type mismatches, duplicate ids). Produces precise, line-mapped diagnostics.
4. **Resolve** — for each node, look up its `type` in the **Node Registry**; for `agent` nodes resolve the **Provider**; for `skill` nodes load and validate the **SKILL.md** contract and env deps; expand `subgraph` references.
5. **Build** — translate the resolved plan into LangGraph builder calls: `new StateGraph(channels)`, `addNode`, `addEdge`, `addConditionalEdges`, attach checkpointer/store, set interrupt points.
6. **Ready** — return a `CompiledGraph` handle that the Runtime can `invoke`/`stream`.

> Validation is **offline and fast**. `flowgraph validate` runs stages 1–4 with zero side effects (no network, no model calls), so CI can gate on spec correctness cheaply.

## 3. The Node Registry

The registry maps a node `type` string to a **NodeFactory** that produces a LangGraph-compatible node function plus metadata (input/output contract, capabilities, default config schema).

```ts
interface NodeFactory<Config = unknown> {
  type: string;                              // e.g. "http", "intelligent"
  configSchema: ZodType<Config>;             // validates `with:` block
  capabilities?: NodeCapabilities;           // streaming? interruptible? side-effecting?
  build(ctx: BuildContext, config: Config): CompiledNode;
}

interface CompiledNode {
  // The function LangGraph calls. Receives state + runtime config,
  // returns a partial state update (or a Command for control flow).
  run(state: GraphState, ctx: NodeRunContext): Promise<NodeResult>;
  contract: NodeContract;                    // declared inputs/outputs
}
```

Built-in factories (`intelligent`, `skill`, `http`, `webhook`, `router`, `code`, `subgraph`, `map`, `wait`) are registered by `@veloxdevworks/flowgraph-core`. Users register custom factories programmatically or via plugin packages. See [03 — Node Types](./03-node-types.md).

## 4. Runtime composition

Every node function is wrapped by the runtime in a consistent middleware stack so cross-cutting behavior is uniform:

```
            ┌────────────────────────────────────────────┐
 LangGraph  │  emit(node.start) ─► hooks(before) ─►       │
 calls ───► │  ┌──────── retry/timeout ────────┐          │
 node       │  │  OTel span { node.run() }      │          │ ──► state update
            │  └────────────────────────────────┘          │
            │  ─► hooks(after) ─► emit(node.end/error)     │
            └────────────────────────────────────────────┘
```

This wrapper is what guarantees "observable & extensible by default": node authors write only `run()`, and they automatically get events, hooks, tracing, retries, and timeouts. See [06 — Events & Hooks](./06-events-and-hooks.md) and [07 — Runtime](./07-runtime-and-execution.md).

## 5. Monorepo layout

We use a pnpm + Turborepo monorepo ([ADR-0006](./adr/0006-monorepo-tooling.md)). Rationale: clear public/extension boundaries, independent versioning of optional adapters (so a CI user pulling only `@veloxdevworks/flowgraph-core` does not transitively install the Claude or Cursor SDKs), and room to grow plugins.

Packages under `packages/` fall into three tiers. Install only the adapters and plugins you need so `core` never pulls native bindings or optional SDKs transitively.

```
flowgraph/                      (repo root)
├── package.json               (workspace root, private)
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── .changeset/
├── docs/                      ← you are here
├── examples/                  ← runnable example graphs + skills
│   ├── triage-issue/
│   ├── release-notes/
│   └── software-factory/
└── packages/
    │  # Foundation — always relevant; no optional native/SDK deps
    ├── core/                  @veloxdevworks/flowgraph-core         — compiler, registry, runtime, built-in nodes, event bus, hooks, LangChain provider
    ├── spec/                  @veloxdevworks/flowgraph-spec         — Zod schemas + generated JSON Schema (no runtime deps)
    ├── skills/                @veloxdevworks/flowgraph-skills       — SKILL.md loader, front-matter parsing, contract & env preflight
    ├── expr/                  @veloxdevworks/flowgraph-expr         — the safe expression language ({{ ... }}) parser/evaluator
    ├── cli/                   @veloxdevworks/flowgraph-cli          — the `flowgraph` binary
    ├── testing/               @veloxdevworks/flowgraph-testing      — in-memory harness, fixtures, golden-run helpers
    │  # Adapters — peer-dep on core + one provider SDK
    ├── provider-claude/       @veloxdevworks/flowgraph-provider-claude    — Claude Agent SDK adapter
    ├── provider-cursor/       @veloxdevworks/flowgraph-provider-cursor    — Cursor SDK adapter
    │  # Runtime plugins — peer-dep on core + one optional capability
    ├── checkpoint-sqlite/     @veloxdevworks/flowgraph-checkpoint-sqlite  — durable file/sqlite checkpointer
    ├── checkpoint-postgres/   @veloxdevworks/flowgraph-checkpoint-postgres— durable pg checkpointer
    ├── observability-otel/    @veloxdevworks/flowgraph-observability-otel — OpenTelemetry exporter wiring
    └── tools-fs/              @veloxdevworks/flowgraph-tools-fs           — sandboxed local filesystem tools
```

### Package dependency rules

```
# Foundation
spec ◄── core ◄── cli
expr ◄── core
skills ◄── core
testing ── (dev) ── all

# Adapters (peer-depend on core; impl ProviderAdapter)
          ▲   ◄── provider-*

# Runtime plugins (peer-depend on core; one optional capability each)
          ▲   ◄── checkpoint-*      (impl CheckpointerAdapter)
          ▲   ◄── observability-otel
          ▲   ◄── tools-fs
```

- `@veloxdevworks/flowgraph-spec` has **no runtime dependencies** (only Zod). It is importable by editor tooling and the future GUI to validate specs without pulling the engine.
- `@veloxdevworks/flowgraph-core` depends on LangGraph.js, `@veloxdevworks/flowgraph-spec`, `@veloxdevworks/flowgraph-expr`, `@veloxdevworks/flowgraph-skills`. It contains the engine integration and all *deterministic* built-in nodes.
- **Adapters and runtime plugins are separate packages** that `peerDependencies` on `@veloxdevworks/flowgraph-core` and on their heavy SDK or native driver (`@anthropic-ai/claude-agent-sdk`, `@cursor/sdk`, `better-sqlite3`/`pg`, `@opentelemetry/*`). A user installs only the packages they reference. The CLI lazy-loads them by name with a helpful "install `@veloxdevworks/flowgraph-provider-claude`" error if missing.
- If a new capability does **not** need an optional heavy/native dependency, it probably belongs inside `core`, not a new package. See [CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-package).

## 6. Public API surface (programmatic)

The CLI is a thin wrapper over a small, stable programmatic API in `@veloxdevworks/flowgraph-core`:

```ts
import { loadGraph, compileGraph, runGraph } from "@veloxdevworks/flowgraph-core";

// 1. Load + validate (no side effects)
const spec = await loadGraph("./triage.graph.yaml");

// 2. Compile to a LangGraph StateGraph (resolves registry/providers/skills)
const compiled = await compileGraph(spec, {
  registry,                 // optional: extra node types
  providers,                // optional: registered provider adapters
  checkpointer,             // optional: durability backend
  hooks,                    // optional: hook registrations
  observability,            // optional: OTel exporter
});

// 3. Run — invoke or stream events
const result = await runGraph(compiled, {
  input: { issue: {/*...*/} },
  threadId: "issue-123",    // enables checkpoint/resume
  signal,                   // AbortSignal
});

for await (const event of runGraph.stream(compiled, { input })) {
  // structured lifecycle events (see docs/06)
}
```

The future GUI imports the **same** `loadGraph`/`compileGraph` and the `@veloxdevworks/flowgraph-spec` schemas — it does not get a private API. This keeps the standalone honest.

## 7. Execution context & secrets

A `RunContext` is threaded through compilation and execution. It carries:

- **Config** — merged settings (defaults → project file → env → flags).
- **Secrets** — resolved lazily from a `SecretProvider` (env vars by default; pluggable for vaults). Secrets are **never** written into graph state or checkpoints; nodes receive a handle to request them, and they are redacted from events/logs by a redaction layer. See [07 §Secrets](./07-runtime-and-execution.md#8-secrets--redaction).
- **Capabilities / environment** — what's available in this environment (network, interactivity, which provider SDKs/CLIs are installed). Drives skill **preflight** and HITL behavior (interactive vs. fail-fast in CI).
- **Workspace** — base dir for resolving relative paths and a scratch/working directory for nodes.

## 8. CI vs. desktop: one spec, two runtimes

The same compiled graph runs in both environments; only the `RunContext` differs:

| Concern | CI (headless) | Desktop CLI (interactive) |
|---|---|---|
| HITL interrupt | **Fail-fast or auto-resolve** via policy (e.g. `--on-interrupt=fail`/`approve`/`webhook`) | Prompt the user in the terminal; block until answered |
| Secrets | CI secret store / env | Local env / keychain / `.env` |
| Checkpointer | sqlite/pg (durable, shared artifact) or memory (ephemeral) | sqlite file under workspace |
| Observability | OTel → collector; JSON logs to stdout | Pretty TTY renderer + optional OTel |
| Provider auth | API keys via env | API keys or local CLI auth (e.g. logged-in Cursor/Claude) |

This matrix is realized purely through `RunContext` configuration — the spec and compiled graph are identical. See [07 — Runtime](./07-runtime-and-execution.md) and [09 — CLI](./09-cli.md).

## 9. The GUI boundary

This repo intentionally stops at L5 = CLI + programmatic API. A future GUI/agentic authoring tool is a **separate downstream consumer** that:

- uses `@veloxdevworks/flowgraph-spec` to validate and autocomplete YAML,
- uses `@veloxdevworks/flowgraph-core` `loadGraph`/`compileGraph` to dry-run and lint,
- subscribes to the **event stream** for live run visualization,
- emits flowgraph YAML as its output format (no private back-channel).

Designing the engine as a clean standalone with a stable event stream and schema package is what makes a great GUI possible later without coupling.

## 10. Technology choices (summary)

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript (ESM, Node ≥ 20) | Strict mode; types are part of the public contract |
| Engine | `@langchain/langgraph` | L0; not abstracted away |
| Schema/validation | Zod → JSON Schema | One source of truth; JSON Schema generated for editors |
| Expression language | custom safe evaluator (`@veloxdevworks/flowgraph-expr`) | No `eval`; sandboxed, see [05](./05-state-and-data.md) |
| Monorepo | pnpm workspaces + Turborepo | [ADR-0006](./adr/0006-monorepo-tooling.md) |
| Build | tsup (esbuild) | dual ESM/CJS where needed; CLI is ESM |
| Tests | Vitest | unit + golden-run integration via `@veloxdevworks/flowgraph-testing` |
| Release | Changesets | independent semver per package |
| Observability | OpenTelemetry | [ADR-0007](./adr/0007-observability-otel.md) |
| CLI framework | clipanion or commander + prompts | TBD in implementation; see [09](./09-cli.md) |
