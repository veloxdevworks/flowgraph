# Examples

Runnable vertical slices demonstrating flowgraph features. Each example includes a graph YAML and (where needed) a registration script or README.

## Quick reference

| Example | What it demonstrates | Env / setup | README |
|---------|---------------------|-------------|--------|
| [quickstart](./quickstart/) | Zero-code skill pipeline | None | [README](./quickstart/README.md) |
| [triage-issue](./triage-issue/) | `code` + `router` + `skill` (north-star) | None | [README](./triage-issue/README.md) |
| [release-notes](./release-notes/) | HITL interrupt + durable resume | `register.ts` | [README](./release-notes/README.md) |
| [hitl](./hitl/) | `hitl` node + interactive/CI resume | None | [README](./hitl/README.md) |
| [review-loop](./review-loop/) | Branching + revise loop until approved | None | — |
| [composition](./composition/) | `map` + `subgraph` fan-out | `register.ts` | [README](./composition/README.md) |
| [reducers](./reducers/) | Custom reducers + parallel fan-out | `register.ts` | [README](./reducers/README.md) |
| [skill-pack](./skill-pack/) | Portable skill packaging | None | [README](./skill-pack/README.md) |
| [fs-agent](./fs-agent/) | Sandboxed FS tools + hooks | None | [README](./fs-agent/README.md) |
| [claude-agent](./claude-agent/) | Claude SDK + builtin tools | `ANTHROPIC_API_KEY` | [README](./claude-agent/README.md) |
| [cursor-agent](./cursor-agent/) | Cursor SDK adapter | `CURSOR_API_KEY` | [README](./cursor-agent/README.md) |

## Run any example

From the monorepo root (after `pnpm install && pnpm build`):

```bash
# Validate all graph specs (CI does this)
for f in examples/**/*.graph.yaml; do
  flowgraph validate "$f"
done
```

Most examples with `package.json` scripts:

```bash
cd examples/quickstart && pnpm start
```

## Choosing an example

| I want to… | Start here |
|------------|------------|
| Run something with no TypeScript | [quickstart](./quickstart/) |
| Register custom functions | [triage-issue](./triage-issue/) |
| Pause for human approval | [release-notes](./release-notes/) or [hitl](./hitl/) |
| Loop until human approves | [review-loop](./review-loop/) |
| Run an LLM agent | [claude-agent](./claude-agent/) or [cursor-agent](./cursor-agent/) |
| Fan out work in parallel | [composition](./composition/) or [reducers](./reducers/) |
| Write automated tests | [composition/composition.test.ts](./composition/composition.test.ts) |

Looking for MCP examples (stdio mock, OAuth, agent tools)? Those ship alongside the optional `@veloxdevworks/flowgraph-mcp` package — see [15 — MCP operations](../docs/15-mcp-operations.md).

See [13 — Getting started](../docs/13-getting-started.md) for installation and [IMPLEMENTATION_STATUS.md](../docs/IMPLEMENTATION_STATUS.md) for feature coverage.
