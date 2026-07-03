# Cursor agent example

Demonstrates the Cursor SDK adapter for local agent runs (`runtime: local`).

## Setup

```bash
pnpm install
export CURSOR_API_KEY=...
```

Install the Cursor provider and SDK if not already present:

```bash
pnpm add @veloxdevworks/flowgraph-provider-cursor @cursor/sdk
```

## Run

```bash
pnpm run run
```

## Custom tools

Expose skills/nodes/functions via `with.tools`; the adapter maps them to `local.customTools` and routes each call through flowgraph's `checkToolCall` / `reportToolResult` governance.

## Limitations

Unlike Claude's `canUseTool`, the Cursor SDK does not expose a per-call permission callback for **native** builtin tools. Use `provider: claude` or `@veloxdevworks/flowgraph-tools-fs` function tools when you need fine-grained `permission: ask` / `runtime.hooks` gating on file operations.
