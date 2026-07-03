# 12 — Interactive TUI (`flowgraph tui`)

The TUI is a keyboard-driven terminal interface for exploring graphs, running workflows live, answering human-in-the-loop (HITL) interrupts, and inspecting skills/MCP servers. It lives in `@veloxdevworks/flowgraph-tui` and is **optional** — the scriptable `flowgraph` CLI remains the stable surface for CI, automation, and a future GUI.

## Launch

```bash
# From a project directory (discovers *.graph.yaml)
flowgraph tui

# Open a specific graph in the explorer
flowgraph tui ./triage.graph.yaml

# Standalone binary (same package)
npx @veloxdevworks/flowgraph-tui
flowgraph-tui ./my.graph.yaml
```

Requires an interactive terminal (TTY). In CI or piped shells, use `flowgraph run` instead.

Install the TUI package if `flowgraph tui` reports it is missing:

```bash
pnpm add @veloxdevworks/flowgraph-tui
```

## Architecture

The TUI is a thin Ink/React front-end over the same engine and helpers as the CLI:

- `@veloxdevworks/flowgraph-core` — `loadGraph`, `validateSpec`, `compileGraph`, event bus
- `@veloxdevworks/flowgraph-cli` — checkpointer, MCP hub, providers, local tools, interrupt parsing

No parallel run engine. The CLI stays low-dependency; React/Ink ship only with `@veloxdevworks/flowgraph-tui`.

## Screens

| Tab | Key | Screen | Purpose |
|-----|-----|--------|---------|
| 1 | `1` | **Dashboard** | Discover `*.graph.yaml`, recent runs |
| 2 | `2` | **Graph Explorer** | Topology, validation, run input form |
| 3 | `3` | **Run View** | Live event tree, detail pane, usage |
| 4 | `4` | **Threads** | Resume interrupted runs from history |
| 5 | `5` | **Skills** | List skills + doctor/preflight status |
| 6 | `6` | **MCP** | MCP servers, tools, OAuth login |

### Dashboard

- Lists graphs under the current working directory (recursive, depth-limited).
- Shows validity badge and node count.
- **Recent runs** from `.flowgraph/tui-history.json`.

Keys: `↑↓` select, `Enter` open graph, `/` start filter, `Esc` clear filter.

### Graph Explorer

- Graph name, apiVersion, validation status.
- ASCII topology (nodes + edges).
- MCP server summary when declared.

Keys: `r` run (input form for `state.channels`), `v` re-validate, `d` skills tab, `M` MCP tab, `Esc` dashboard.

### Run View

- **Left:** collapsible event tree (`run` → `node` → `intelligent.tool.*`).
- **Right:** selected event detail + final state summary.
- **Bottom:** optional raw event ticker (`t`).

On `interrupt.raised`, a modal opens for approval (`y`/`n`), free-text question, or choice list — same semantics as `flowgraph run --on-interrupt prompt`.

Keys: `t` toggle ticker, `Esc` back (when run finished), `q` quit.

### Threads

- Known thread IDs from local TUI history.
- `a` resume selected thread with default approval.

### Skills

- Scans `./skills/` for `SKILL.md` files.
- Preflight/doctor status per skill; contract detail on selection.

### MCP

- Lists `mcpServers` from the open graph.
- OAuth status and tool counts.
- `l` login (opens browser when possible).

## Chrome

- Header tab bar with numeric shortcuts `1`–`6`.
- Footer with context-sensitive key hints.
- `?` help overlay.
- Colors match the CLI: green ✓, red ✗, yellow ⚠, cyan selection.

## Local history

The TUI writes `.flowgraph/tui-history.json` (recent graphs and thread IDs). This is UX-only; durable checkpoints still come from `runtime.checkpoint` in the graph spec (e.g. sqlite).

## CI vs desktop

| Context | Use |
|---------|-----|
| Developer desktop | `flowgraph tui` or `flowgraph run --stream --on-interrupt prompt` |
| CI / automation | `flowgraph run --json --on-interrupt fail` |
| Future GUI | Same `@veloxdevworks/flowgraph-core` API; may shell out to CLI or embed the run controller |

See also: [09 — CLI](./09-cli.md).
