# 09 — CLI (`flowgraph`)

The CLI is a thin surface over the `@veloxdevworks/flowgraph-core` programmatic API ([Architecture §6](./01-architecture.md#6-public-api-surface-programmatic)). It is the primary way to run graphs headless in CI and interactively on a desktop.

Binary name: `flowgraph`. Distributed as `@veloxdevworks/flowgraph-cli`, runnable via `npx flowgraph` or installed globally/per-project.

> **Implementation status:** Commands marked **shipped** are in `@veloxdevworks/flowgraph-cli` today. **Planned** items are design targets — see [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md).

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
| `flowgraph tui [graph]` | **shipped** | Interactive TUI (requires `@veloxdevworks/flowgraph-tui`) |
| `flowgraph new <name>` | **shipped** | Scaffold a graph from a template |
| `flowgraph init <name>` | **shipped** | Alias for `new` (single `.graph.yaml`, not a full project) |
| `flowgraph dev <graph>` | **planned** | Watch + re-validate + run with stepping |

Per-command flags use `--cwd <dir>` where noted. The CLI loads `.env` from the working directory silently on `run` and `resume` (no `--env-file` flag yet).

> **Interactive TUI:** For a full-screen, keyboard-driven experience, see [12 — Interactive TUI](./12-tui.md) (`flowgraph tui`).

## 1.1 Optional CLI packages

`@veloxdevworks/flowgraph-cli` ships a slim core install. These features load **on demand** when referenced in a graph — install only what you need:

| Feature | Graph signal | Package |
|---------|--------------|---------|
| MCP servers | `mcpServers:` block, `mcp` nodes, agent MCP tools | `@veloxdevworks/flowgraph-mcp` |
| Local filesystem tools | `localTools.fs:` block | `@veloxdevworks/flowgraph-tools-fs` |
| Durable SQLite checkpoints | `runtime.checkpoint.backend: sqlite` | `@veloxdevworks/flowgraph-checkpoint-sqlite` |
| Interactive TUI | `flowgraph tui` | `@veloxdevworks/flowgraph-tui` |

```bash
pnpm add @veloxdevworks/flowgraph-mcp              # MCP integrations
pnpm add @veloxdevworks/flowgraph-tools-fs         # sandboxed fs_read / fs_write tools
pnpm add @veloxdevworks/flowgraph-checkpoint-sqlite  # resume after process restart
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
  --cwd .
```

| Flag | Description |
|------|-------------|
| `--input <key=val>` | Initial channel values. `@file.json` loads JSON; bare strings are parsed as JSON when valid. When the graph declares an `inputs:` schema, values are coerced/validated against it (defaults applied; missing required keys fail fast). |
| `--thread <id>` | Checkpoint/resume key (required for durable HITL flows). |
| `--stream` | Pretty-print live events to the terminal. |
| `--json` | Emit events as JSONL on stdout (machine-readable). |
| `--on-interrupt <policy>` | `prompt` \| `fail` (default) \| `approve` \| `webhook`. |
| `--no-mcp-oauth` | Do not open a browser for MCP OAuth; fail if tokens are missing (CI-safe). |
| `--cwd <dir>` | Working directory (default: process cwd). |

**Behavior (shipped):**

- Loads, validates, and compiles the graph; exits `2` on load/validation errors.
- If the graph declares `inputs:`, resolves defaults and validates `--input` (and any `input:` seed defaults) **before** the run starts. Missing required keys or type mismatches exit `1` with an aggregated error listing every issue — never an interactive prompt.
- Checkpoint backend comes from `runtime.checkpoint` in the YAML (not a CLI flag).
- Budget limits come from `runtime.budget` in the YAML (not `--max-usd`).
- Skill preflight runs when a **skill node executes**, not upfront at run start.
- With `--stream` / `--json`, events go to configured sinks; otherwise a compact summary prints at the end.
- On interrupt under `--on-interrupt fail`, exits `3` and prints resume instructions.

**Planned flags:** `--checkpoint`, `--max-usd`, `--otel`, global `--config`, `--env-file`, `--log-level`, `--quiet`.

## 3. `flowgraph validate` — **shipped**

```
flowgraph validate ./my.graph.yaml --strict --format json
```

- Accepts a **single graph file path** (glob patterns not supported yet).
- Runs load → parse → validate → resolve imports (offline, no execution).
- `--strict` promotes warnings to errors.
- `--format json` emits machine-readable diagnostics.
- Exit `2` on errors; `0` on success.

> **`--preflight`:** The flag exists but **does not yet run skill env checks** during validate. Use `flowgraph skills doctor` for env readiness.

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

Prints or writes the Graph JSON Schema from `@veloxdevworks/flowgraph-spec`. Use in YAML headers for editor autocomplete:

```yaml
# yaml-language-server: $schema=https://veloxdevworks.com/flowgraph/schema/v1.json
```

See [13 — Getting started](./13-getting-started.md) for the full editor setup.

## 6. `flowgraph migrate` — **shipped**

```
flowgraph migrate ./old.graph.yaml          # dry-run
flowgraph migrate ./old.graph.yaml --write  # apply in place
```

Upgrades a graph spec toward `apiVersion: flowgraph/v1`. Prints migration notes; use `--write` to persist changes.

## 7. Exit codes

| Code | Meaning | When |
|------|---------|------|
| `0` | Success | Completed run, valid graph, successful resume |
| `1` | Runtime / operational error | Run failed, MCP OAuth error, skills doctor failure |
| `2` | Validation / compile error | Bad spec, missing checkpoint thread |
| `3` | Interrupted & unresolved | HITL under `--on-interrupt fail` |

**Planned (not yet mapped by CLI):** `4` preflight/env, `5` budget exceeded, `130` SIGINT.

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
| `--resume <json>` | Value passed to the interrupt handler (default: `{"approved":true}`). |
| `--list` | List pending interrupts and exit (no resume). |
| `--stream` / `--json` | Same as `run`. |
| `--on-interrupt <policy>` | Policy if the run interrupts again. |
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
