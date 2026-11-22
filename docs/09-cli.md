# 09 — CLI (`flowgraph`)

The CLI is a thin surface over the `@flowgraph/core` programmatic API ([Architecture §6](./01-architecture.md#6-public-api-surface-programmatic)). It is the primary way to run graphs headless in CI and interactively on a desktop.

Binary name: `flowgraph`. Distributed as `@flowgraph/cli`, runnable via `npx flowgraph` or installed globally/per-project.

> **Implementation status:** Commands marked **shipped** are in `@flowgraph/cli` today. **Planned** items are design targets — see [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md).

## 1. Command overview

| Command | Status | Description |
|---------|--------|-------------|
| `flowgraph run <graph>` | **shipped** | Run a graph to completion (or first interrupt) |
| `flowgraph validate <graph>` | **shipped** | Offline validate + lint (no side effects, no model calls) |
| `flowgraph graph <graph>` | **shipped** | Inspect/visualize a graph (mermaid/json/ascii) |
| `flowgraph schema` | **shipped** | Emit Graph JSON Schema for editor autocomplete |
| `flowgraph migrate <graph>` | **shipped** | Migrate a spec toward `flowgraph/v1` |
| `flowgraph resume <graph>` | **shipped** | Resume an interrupted run by threadId |
| `flowgraph skills …` | **partial** | `doctor`, `list`, `resolve` shipped; `show`, `new` planned |
| `flowgraph mcp …` | **shipped** | `tools`, `auth login|status|logout` |
| `flowgraph tui [graph]` | **shipped** | Interactive TUI (requires `@flowgraph/tui`) |
| `flowgraph new <name>` | **shipped** | Scaffold a graph from a template |
| `flowgraph init <name>` | **shipped** | Alias for `new` (single `.graph.yaml`, not a full project) |
| `flowgraph dev <graph>` | **planned** | Watch + re-validate + run with stepping |

Per-command flags use `--cwd <dir>` where noted. The CLI loads `.env` from the working directory silently on `run` and `resume` (no `--env-file` flag yet).

> **Interactive TUI:** For a full-screen, keyboard-driven experience, see [12 — Interactive TUI](./12-tui.md) (`flowgraph tui`).

## 1.1 Optional CLI packages

`@flowgraph/cli` ships a slim core install. These features load **on demand** when referenced in a graph — install only what you need:

| Feature | Graph signal | Package |
|---------|--------------|---------|
| MCP servers | `mcpServers:` block, `mcp` nodes, agent MCP tools | `@flowgraph/mcp` |
| Local filesystem tools | `localTools.fs:` block | `@flowgraph/tools-fs` |
| Durable SQLite checkpoints | `runtime.checkpoint.backend: sqlite` | `@flowgraph/checkpoint-sqlite` |
| Interactive TUI | `flowgraph tui` | `@flowgraph/tui` |

```bash
pnpm add @flowgraph/mcp              # MCP integrations
pnpm add @flowgraph/tools-fs         # sandboxed fs_read / fs_write tools
pnpm add @flowgraph/checkpoint-sqlite  # resume after process restart
```

If a graph references a feature whose package is not installed, the CLI fails fast with an install hint.

## 2. `flowgraph run` — **shipped**

```
flowgraph run ./triage.graph.yaml \
  --input issue=@./payload.json \
  --input repo=acme/widgets \
  --thread issue-123 \
  --on-interrupt fail \
  --stream \
  --json \
  --no-mcp-oauth \
  --targets ./targets.yaml \
  --cwd .
```

| Flag | Description |
|------|-------------|
| `--input <key=val>` | Initial channel values. The text after `=` is decoded once, by the type the graph declares for the key: a `number` or `boolean` input is parsed, a `json` input is JSON text, a `string` or `select` input is kept exactly as written. A key that is a state channel (not an input) is decoded by the channel's `type`; `any` takes JSON when the text is valid JSON and the text itself otherwise. `key=@file.json` supplies the file's JSON value as it is. The decoded values are then checked against `inputs:` (defaults applied; missing required keys, wrong types and undeclared keys fail fast). |
| `--thread <id>` | Checkpoint/resume key (required for durable HITL flows). |
| `--stream` | Pretty-print live events to the terminal. |
| `--json` | Emit events as JSONL on stdout (machine-readable). |
| `--on-interrupt <policy>` | `prompt` \| `fail` (default) \| `approve` \| `webhook`. |
| `--no-mcp-oauth` | Do not open a browser for MCP OAuth; fail if tokens are missing (CI-safe). |
| `--targets <file>` | YAML or JSON topology naming the workers that `runsOn` nodes may be placed on ([ADR-0020](./adr/0020-node-placement.md) §4). See below. |
| `--cwd <dir>` | Working directory (default: process cwd). |

**Behavior (shipped):**

- Loads, validates, and compiles the graph; exits `2` on load/validation errors.
- If the graph declares `inputs:`, resolves defaults and validates `--input` **before** the run starts. Missing required keys, type mismatches or keys the graph does not declare exit `1` with an aggregated error listing every issue — never an interactive prompt.
- Checkpoint backend comes from `runtime.checkpoint` in the YAML (not a CLI flag).
- Budget limits come from `runtime.budget` in the YAML (not `--max-usd`).
- Skill preflight runs when a **skill node executes**, not upfront at run start.
- With `--stream` / `--json`, events go to configured sinks; otherwise a compact summary prints at the end.
- A pending human gate under `--on-interrupt fail` exits `3` and prints resume instructions. Webhook listeners stay active until their continuation completes or reaches a human gate. Signal and conditional waits return exit `3` with their deadline and resume instructions; a separate invocation resumes them. Final completion exits `0`, final failure exits `1`, and listener resources are closed. Webhook/timeout continuations keep `--json` stdout as JSONL.

**Placement (`--targets`):**

```yaml
# targets.yaml
targets:
  studio-pc:
    url: https://studio-pc.lan:8787
    token: env:STUDIO_PC_TOKEN       # literal, or env:NAME
local:
  labels: [app:blender]              # custom labels for this machine (a label with a check must pass it)
```

- The file is validated with the topology schema; an unreadable or invalid file exits `2` with diagnostics.
- This machine's labels are the built-in ones (`os:`, `arch:`, `gpu:`, `flowgraph:`, `nodeType:`, `plugin:`) plus `local.labels` whose checks pass.
- Before the run starts, one line per placed node is printed (to stderr under `--json`): `placement: character → studio-pc (os:windows, app:cc5)`. A node this machine can run prints `→ local`.
- If a placed node has no matching worker, the run does not start: the `PLACEMENT_UNSATISFIED` message (node, needed labels, what each candidate reported) is printed and the CLI exits `2`, the same code as other validation and preflight failures.
- Without `--targets` only this machine is considered: a `runsOn` node it cannot satisfy (and that does not set `fallback: local`) fails the same way.
- Worker tokens come from the file or the environment; nothing from the coordinator's environment is sent to a worker. See [07 — Runtime §6a](./07-runtime-and-execution.md#6a-node-placement) for what runs remotely and the outcomes.

**Planned flags:** `--checkpoint`, `--max-usd`, `--otel`, global `--config`, `--env-file`, `--log-level`, `--quiet`.

## 3. `flowgraph validate` — **shipped**

```
flowgraph validate ./my.graph.yaml --strict --format json
```

- Accepts a **single graph file path** (glob patterns not supported yet).
- Loads and parses the graph, then lints it. It does not run the graph, call a model, or load `imports` modules (`nodes`, `providers`, `reducers`). Skill, agent and subgraph aliases are read as data.
- Map bodies, inline subgraph `spec` blocks and `uses:` subgraph files are linted like the graph itself; a file's diagnostics name that file ([02 §11](./02-graph-spec.md#11-validation--diagnostics)).
- A node type that is not already registered is an error. On a graph that declares a `nodes` import, that type — including a typo — is a warning, `PLUGIN_TYPE_UNRESOLVED`, because validate does not load the module. A `custom:` reducer is an error unless a `reducers` import is declared, in which case it is a warning, `UNREGISTERED_REDUCER`. `flowgraph run` loads those modules when the graph executes.
- `--strict` promotes warnings to errors.
- `--format json` emits machine-readable diagnostics.
- Exit `2` on errors; `0` on success.
- `--preflight` also checks skill environment dependencies, agent definitions and toolchain binaries. Binary names are looked up with `which` or `where` and no shell. Import modules are still not loaded.

`flowgraph skills doctor` checks skill environment readiness on its own.

## 4. `flowgraph graph` — **shipped**

```
flowgraph graph ./triage.graph.yaml --format mermaid > triage.mmd
flowgraph graph ./triage.graph.yaml --format ascii
flowgraph graph ./triage.graph.yaml --format json
```

| Format | Output |
|--------|--------|
| `ascii` (default) | Terminal-friendly node/edge listing |
| `mermaid` | Mermaid flowchart |
| `json` | Metadata, node ids/types, and edges |

## 5. `flowgraph schema` — **shipped**

```
flowgraph schema --out schema/v1.json
```

Prints or writes the Graph JSON Schema (draft-07) from `@flowgraph/spec`. Its `$id` is `https://veloxdevworks.com/flowgraph/schema/v1.json`; a breaking schema change is published at a new versioned path. The root refers to the `GraphSpec` definition through `allOf`, and the schema compiles under Ajv strict mode with `allowUnionTypes`. Nodes, inline subgraph `spec` blocks and `map` bodies are recursive definitions, so nested graphs get the same completion and checks as the top level. Per-type `with` fields are not typed yet. Use in YAML headers for editor autocomplete:

```yaml
# yaml-language-server: $schema=https://veloxdevworks.com/flowgraph/schema/v1.json
```

See [13 — Getting started](./13-getting-started.md) for the full editor setup.

## 6. `flowgraph migrate` — **shipped**

```
flowgraph migrate ./old.graph.yaml          # dry-run
flowgraph migrate ./old.graph.yaml --write  # apply in place
```

Upgrades a graph or skill spec toward `apiVersion: flowgraph/v1`, canonicalizes `kind`, and rewrites legacy `type: webhook` nodes to `type: http` with `once: true` (and `method: POST` if absent). Prints migration notes; use `--write` to persist changes.

Pre-v1 alias rewrites:

- `apiVersion` → `flowgraph/v1` and `kind: Subgraph` → `kind: Graph`;
- node types `code` → `function`, `intelligent` → `agent`;
- hook events `intelligent:beforeToolCall` / `intelligent:afterToolCall` → `agent:beforeToolCall` / `agent:afterToolCall`;
- `runtime.store` → `runtime.memory`;
- `SKILL.md` front-matter `kind_of` → `kindOf`.

Data-contract rewrites (applied on the YAML document so comments and layout survive):

- channel `items` / `properties` → `schema`;
- input `label` → `ui.label`, and input `type: text` → `type: string` with `ui: { widget: textarea }`;
- top-level `input:` seed values → `default` on the matching `inputs` entries;
- `function` / `script` / `shell` `with.input` → the node's `input:`;
- `agent` / `router` `with.provider` / `with.model` → node-level `provider:` / `model:`;
- map `{{ item.<as> }}` → `{{ <as> }}`, including inside the map body.

Anything that needs a decision is left as it is and printed as a manual item: a node that has both `input` and `with.input`, an `agent` / `router` that sets both node-level and `with.` `provider` or `model` to different values, a subgraph that sets both `stateMap.out` and `output`, and a map `with.output`.

## 7. Exit codes

| Code | Meaning | When |
|------|---------|------|
| `0` | Success | Completed run, valid graph, successful resume |
| `1` | Runtime / operational error | Run failed, MCP OAuth error, skills doctor failure |
| `2` | Validation / compile error | Bad spec, missing checkpoint thread |
| `3` | Interrupted & unresolved | HITL under `--on-interrupt fail` |
| `130` | Cancelled | Ctrl-C or SIGTERM during `run` or `resume`. The first one cancels the run, so nodes stop what they started; a second exits at once |

**Planned (not yet mapped by CLI):** `4` preflight/env, `5` budget exceeded.

## 8. `flowgraph skills` — **partial**

| Subcommand | Status | Description |
|------------|--------|-------------|
| `skills doctor [paths…]` | **shipped** | Check skill env deps (`--json`, `--cwd`) |
| `skills list [dir]` | **shipped** | Discover skills in a directory |
| `skills resolve <uses>` | **shipped** | Show where a `uses:` reference resolves |
| `skills show <skill>` | **planned** | Print contract + SKILL.md body |
| `skills new <name>` | **planned** | Scaffold SKILL.md + handler |

```
flowgraph skills doctor ./skills/mock-create-ticket
flowgraph skills list
flowgraph skills resolve skills/slugify --cwd examples/quickstart
```

## 9. `flowgraph resume` — **shipped**

```
flowgraph resume ./graph.yaml --thread release-42 --resume '{"approved":true}'
flowgraph resume ./graph.yaml --thread release-42 --list
flowgraph resume ./graph.yaml --thread release-42 --list --json
```

| Flag | Description |
|------|-------------|
| `--thread <id>` | **Required.** Thread to resume. |
| `--resume <json>` | Explicit JSON answer. Required for a pending human gate; `false` / `null` deny rather than approve. |
| `--list` | Read-only: list pending interrupt ids and exit, including overdue waits; `--json` prints one JSON document. |
| `--stream` / `--json` | Same as `run`. |
| `--on-interrupt <policy>` | Policy if the run interrupts again. `approve` supplies `{decision:"approve"}` for review gates and `true` for approvals; question/choice/form gates require an explicit answer. |
| `--from <checkpoint-id>` | Resume from a historical checkpoint; already-recorded decisions cannot be replaced. Fork before the gate instead. |
| `--replay-workspace <dir>` | Separate output directory required when historical replay may repeat side effects. |
| `--workspace <dir>` | Confirm the original execution workspace for a legacy thread that predates workspace recording. A recorded thread refuses a different explicit workspace. |
| `--no-mcp-oauth` | CI-safe MCP behavior. |

Requires a durable checkpoint backend (`runtime.checkpoint.backend: sqlite` or Postgres). See [07 §HITL](./07-runtime-and-execution.md#5-human-in-the-loop).

## 10. `flowgraph mcp` — **shipped**

```
flowgraph mcp tools ./atlassian.graph.yaml
flowgraph mcp auth login ./atlassian.graph.yaml atlassian
flowgraph mcp auth status ./atlassian.graph.yaml
flowgraph mcp auth logout ./atlassian.graph.yaml atlassian
```

See [15 — MCP operations](./15-mcp-operations.md) for OAuth, token storage, and CI patterns.

## 11. `flowgraph new` / `flowgraph init` — **shipped**

```
flowgraph new my-flow                    # default: hello (zero-code skill graph)
flowgraph new my-api --template http
flowgraph new my-agent --template intelligent
flowgraph new my-code --template minimal
flowgraph init my-flow                   # alias for new
```

Templates: `hello` (default), `minimal`, `http`, `intelligent`.

- **`hello`** — writes `<name>.graph.yaml` plus `skills/hello/` (SKILL.md + handler.js). Runnable immediately with `flowgraph run` — no TypeScript registration.
- **`minimal`**, **`http`**, **`intelligent`** — single `<name>.graph.yaml` only.

**Planned:** Full project scaffold (`package.json`, `graphs/`, `skills/`, `.env.example`, `flowgraph.config.ts`) and `flowgraph new skill <name>`.

## 12. `flowgraph dev` — **planned**

Developer loop: watch graph + skills, re-validate on change, pretty streaming, `--break-before` / `--break-after` breakpoints, `--step` superstep stepping. Not implemented yet.

## 13. CI usage example (GitHub Actions)

```yaml
- run: pnpm build
- run: |
    for f in graphs/*.graph.yaml; do
      npx flowgraph validate "$f" --strict
    done
- run: |
    npx flowgraph run graphs/triage.graph.yaml \
      --input issue=@"$GITHUB_EVENT_PATH" \
      --thread "issue-${{ github.event.issue.number }}" \
      --on-interrupt fail \
      --no-mcp-oauth
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The **same** graph file a developer runs locally with `--on-interrupt prompt --stream` runs here headless with `--on-interrupt fail` — one spec, two runtimes ([Architecture §8](./01-architecture.md#8-ci-vs-desktop-one-spec-two-runtimes)).


### JSONL and logging

`run --json` and `resume --json` keep stdout as JSONL events. Runtime logger
messages go to stderr. The default level is `info`; set `FLOWGRAPH_LOG_LEVEL=debug` explicitly for command diagnostics. Known secret values are masked at every level. `FLOWGRAPH_LOG_LEVEL=warn`
limits console logs to warnings/errors; `FLOWGRAPH_LOG_LEVEL=silent` suppresses
console logging while structured log events remain available. Failed runs print
the thread id and known usage with pending/unknown/unpriced counts on stderr.
Use terminal run event `data.usage` for machine-readable cumulative totals.
Custom imported code must likewise keep arbitrary console output off stdout
when it participates in a JSONL CLI run.

### Inspecting and reconciling usage

`flowgraph usage inspect [graph] --thread <id>` prints the persisted ledger,
including pending and unresolved receipt ids. After stopping/reconciling the old
owner and provider outcome, resolve an exact receipt:

```bash
flowgraph usage resolve graph.yaml --thread issue-123 --receipt <id> --tokens 120 --cost-usd 0.002 --owner-stopped
flowgraph usage resolve graph.yaml --thread issue-123 --receipt <id> --not-billed --owner-stopped
```

Supply actual usage for the receipt, or `--not-billed` only for confirmed zero
usage. Negative/non-finite values, conflicting options and duplicate resolution
are refused. Under a token cap, resolving only USD leaves token uncertainty to
reconcile before another paid call. Completed charges survive recovery.

A crashed execution can also leave an ownership claim. Use `flowgraph thread
inspect graph.yaml --thread <id>`, stop/reconcile the recorded owner and external
work, then `flowgraph thread release graph.yaml --thread <id> --token <exact-token>
--owner-stopped` before resolving usage. Release refuses a live local owner or a
stale token. Neither claims nor usage receipts expire automatically.

For a database configured by a server/host rather than the graph, both command
groups accept `--backend sqlite|postgres --path <database>` and an optional graph:

```bash
flowgraph usage inspect --backend sqlite --path /data/checkpoints.db --thread issue-123
flowgraph thread inspect --backend postgres --path "$DATABASE_URL" --thread issue-123
```

See [usage and budget boundaries](./07-runtime-and-execution.md#usage-and-budget-boundaries)
for late results, legacy receipts and pricing limitations.

Hosted `GET /runs/:threadId` includes `pendingInterruptIds` for interrupted/paused runs. This lookup is read-only and best-effort; if providers or graph state are unavailable, run detail still returns with an empty list. Use `/state` for full interrupt payloads. Invalid-resume 400 responses also include `pendingInterruptIds`; busy responses expose no host ownership details.

### Paths and error events

Relative checkpoint database paths are host settings resolved against the CLI working directory. The first run's working directory (`--cwd`, or the current directory) is the default execution workspace, so shell/file paths stay relative to that folder even when the graph is in a subfolder. An explicit `runtime.workspace` still resolves relative to the declaring graph directory, as do graph imports and script source files.

Checkpointed runs record their workspace before executing nodes. Resume and continue reuse it even when invoked from another directory, so media submission journals and shell replay records remain in the same place. An explicitly changed workspace or node workspace declaration is refused with `THREAD_WORKSPACE_MISMATCH`; historical replay still uses its separate `--replay-workspace`. Legacy checkpoints without a recorded workspace require the known original workspace via `--workspace` or `runtime.workspace` before executing again (`THREAD_WORKSPACE_REQUIRED`). Use absolute checkpoint paths when invoking the same graph from different directories.

Dynamic `node.workspace` templates must resolve to the same folder during recovery. The saved root and declaration checks do not pin changes to values used inside a template, such as graph configuration or run metadata; start a new thread when intentionally changing those destinations.

`--json` failures include a `run.error` event with `data.code` and a one-line reason on stderr, including refusals before a run is admitted. Node errors retain their typed code in both `node.error` and `run.error`. Continuations and forks begin a new invocation with `run.start` followed by their resume/continue event. CLI startup loads graph/runtime packages and optional integrations lazily where supported; this can add about half a second before execution and is separate from node duration.

### Crash recovery discovery

`flowgraph recover <graph> --thread <id>` reads all recovery blockers in one call: execution ownership (including same-host liveness), usage receipts, decoded replay task identities, media journals and checkpoint IDs with parent links. It does not run nodes, apply deadlines, release claims or buy work. Recovery and media inspection use the thread's recorded workspace; for legacy records, read-only discovery falls back to the graph workspace. Use `--workspace` to inspect or reconcile a known original workspace explicitly. Host database overrides are `--backend sqlite|postgres --path <database>`; `media inspect` also accepts them without a graph.

Stop the old owner and reconcile external work before an explicit resolution. Identical usage, replay and media resolutions can be retried safely; changing a reconciled result returns a conflict. Shell replay results have the shape `{"stdout":"...","stderr":"...","exitCode":0}`. A tool replay result is the tool's raw return value, not a tool-message wrapper. Inspect help lists only read options; resolve help lists mutation flags.

`thread release` reports `alreadyReleased: true` when no claim is held; a token that mismatches a held claim is still refused. Obtain the token from `thread inspect` or `recover`. `replay inspect` and `recover` show unresolved operations plus completed slot names by default; `replay inspect --full` explicitly includes historical results and stdout.
