# 13 — Getting started

This guide gets you from zero to a running graph in a few minutes. For the full YAML specification, see [02 — Graph specification](./02-graph-spec.md).

## Prerequisites

- **Node.js ≥ 20**
- **pnpm ≥ 9** (for monorepo development)

## Install

### Run without cloning (when published)

```bash
npx flowgraph run my.graph.yaml
```

### Develop from the monorepo

```bash
git clone <repo-url> flowgraph
cd flowgraph
pnpm install
pnpm build
```

The CLI binary is at `packages/cli/dist/bin.js`. Examples use workspace-linked `@veloxdevworks/flowgraph-cli`.

## Your first run (zero TypeScript)

The [quickstart example](../examples/quickstart/) is the smallest end-to-end graph — two skill nodes, no code registration:

```bash
cd examples/quickstart
pnpm start
# equivalent to:
# flowgraph run quickstart.graph.yaml --stream --input 'text=Hello, flowgraph World!'
```

You'll see events (`node.start`, `skill.start`, `run.end`) and final state with `slug`, `words`, and `sentences`.

Try your own input:

```bash
flowgraph run quickstart.graph.yaml --stream --input 'text=Release Notes for v2.0'
```

## Validate and inspect

```bash
flowgraph validate quickstart.graph.yaml
flowgraph graph quickstart.graph.yaml --format ascii
flowgraph graph quickstart.graph.yaml --format mermaid
```

## Scaffold a new graph

```bash
flowgraph new my-flow
flowgraph validate my-flow.graph.yaml
flowgraph run my-flow.graph.yaml --stream --input 'name=World'
```

The default **`hello`** template scaffolds a graph plus `skills/hello/` — runnable immediately with no TypeScript registration. Other templates: `minimal`, `http`, `intelligent`. See [09 — CLI](./09-cli.md).

## Editor autocomplete (JSON Schema)

Generate the schema locally:

```bash
flowgraph schema --out schema/v1.json
```

Add this header to your graph YAML:

```yaml
# yaml-language-server: $schema=./schema/v1.json
# Or when hosted:
# yaml-language-server: $schema=https://veloxdevworks.com/flowgraph/schema/v1.json
apiVersion: flowgraph/v1
kind: Graph
```

Install the [YAML Language Server](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml) extension in VS Code / Cursor for inline validation and autocomplete.

## Hybrid authoring — pick the right pattern

flowgraph uses a **hybrid model**: YAML declares topology and config; logic lives in skills, registered functions, or LLM agents.

| Pattern | When to use | Registration required |
|---------|-------------|----------------------|
| **`skill` node** + on-disk `handler.js` | Portable, shareable units with contracts | No — see [quickstart](../examples/quickstart/) |
| **`code` node** + `registerFunction()` | Custom in-process TS/JS logic | Yes — see [triage-issue](../examples/triage-issue/) |
| **`intelligent` node** | LLM agent with tool loop | LangChain vendor SDK (e.g. `@langchain/openai`) + API key — adapter is built into `@veloxdevworks/flowgraph-core` / CLI |
| **`mcp` node** or agent MCP tools | External tool servers | MCP config + optional OAuth |

**Rule of thumb:** If your handler can be a plain ESM module on disk, use a **skill**. If you need tight integration with your app's runtime, use **`code`** with registration.

## Next steps

| Goal | Example / doc |
|------|---------------|
| Deterministic routing + skills | [triage-issue](../examples/triage-issue/) |
| Human approval + resume | [release-notes](../examples/release-notes/) |
| LLM agents | [claude-agent](../examples/claude-agent/), [08 — Providers](./08-providers.md) |
| MCP integrations | [mcp](../examples/mcp/), [15 — MCP operations](./15-mcp-operations.md) |
| Map + subgraph composition | [composition](../examples/composition/) |
| Programmatic API + tests | [14 — Programmatic API](./14-programmatic-api.md) |
| Full example index | [examples/README.md](../examples/README.md) |
| What's shipped vs planned | [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md) |
