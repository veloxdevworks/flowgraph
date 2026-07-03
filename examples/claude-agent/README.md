# Claude agent example

Demonstrates Claude Agent SDK **native builtin tools** (`Read`, `Edit`, `Glob`) with flowgraph governance (`permission: ask` → HITL on each tool call via `canUseTool`).

## Setup

```bash
pnpm install
export ANTHROPIC_API_KEY=...
```

Install the Claude provider and SDK if not already present:

```bash
pnpm add @veloxdevworks/flowgraph-provider-claude @anthropic-ai/claude-agent-sdk
```

## Run

Auto-approve tool interrupts (CI-friendly):

```bash
pnpm run run
```

Prompt for each native tool call:

```bash
pnpm run run:prompt
```

## What it does

1. Uses `provider: claude` with `tools: [{ builtin: [Read, Edit, Glob] }]`.
2. Native SDK tools are gated by the same `permission` / `runtime.hooks` model as `@veloxdevworks/flowgraph-tools-fs`.
3. `permission: ask` routes each `Read`/`Edit` through human-in-the-loop before execution.

For LangChain-only graphs, use `@veloxdevworks/flowgraph-tools-fs` instead — see [examples/fs-agent](../fs-agent/).
