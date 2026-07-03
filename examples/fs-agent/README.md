# Filesystem agent example

Demonstrates governed local file tools (`@veloxdevworks/flowgraph-tools-fs`) with an intelligent node.

## Setup

```bash
pnpm install
export XAI_API_KEY=...   # or GROK_API_KEY
```

## Run

Auto-approve write interrupts (CI-friendly):

```bash
pnpm run run
```

Prompt for each `fs_write` approval:

```bash
pnpm run run:prompt
```

## What it does

1. Registers `fs_read` / `fs_write` scoped to `./workspace` via `localTools.fs`.
2. An intelligent node writes `workspace/haiku.md` and reads it back.
3. `runtime.hooks` gates `fs_write` with `do: interrupt` (human-in-the-loop).

Mutating operations (`write`, `edit`, `delete`) are opt-in via `localTools.fs.operations`.
Read/list are enabled by default when `operations` is omitted.
