# 15 — MCP operations

Operational guide for Model Context Protocol integrations in flowgraph. For the design rationale, see [ADR-0011](./adr/0011-mcp-first-integrations.md) and [08 — Providers §MCP](./08-providers.md#mcp-first-integrations-v1).

> **Install:** MCP support is provided by the optional `@veloxdevworks/flowgraph-mcp` package (`pnpm add @veloxdevworks/flowgraph-mcp`). It is not bundled in the default `@veloxdevworks/flowgraph-cli` install — see [09 — CLI §1.1](./09-cli.md#11-optional-cli-packages).

## Declaring MCP servers

Add a top-level `mcpServers` block to your graph:

```yaml
mcpServers:
  mock:
    transport: stdio
    command: node
    args: ["./server/mock-mcp-server.js"]

  atlassian:
    transport: http
    url: "https://mcp.atlassian.com/v1/mcp/authv2"
    auth:
      type: oauth2
      clientName: flowgraph
```

## Consumption modes

| Mode | YAML | Use case |
|------|------|----------|
| **Deterministic** | `type: mcp` node | Call a specific tool with mapped args |
| **Agentic** | `tools: [{ mcp: atlassian }]` on `intelligent` | Expand server tools into the agent loop |

Both modes share one MCP client hub (`@veloxdevworks/flowgraph-mcp`). Tool invocations route through flowgraph's runtime (events, hooks, HITL).

## Stdio vs HTTP transport

| Transport | Config | Auth |
|-----------|--------|------|
| **stdio** | `command`, `args`, optional `env` | Usually none (local process) |
| **http** | `url`, optional `headers` | Bearer header, env token, or OAuth 2.1 |

Stdio is ideal for local mock servers and CI. HTTP is required for remote services (Atlassian, etc.).

## OAuth flow

For servers with `auth.type: oauth2`:

```bash
# One-time browser consent
flowgraph mcp auth login ./atlassian.graph.yaml atlassian

# Check token status
flowgraph mcp auth status ./atlassian.graph.yaml

# Clear tokens
flowgraph mcp auth logout ./atlassian.graph.yaml atlassian
```

Tokens are stored under `.flowgraph/mcp-oauth/<server>.json` in the graph's working directory. Refresh tokens enable silent re-auth on subsequent runs.

## Listing tools

```bash
flowgraph mcp tools ./atlassian.graph.yaml
```

Prints each server's tool names and descriptions (requires a live connection).

## CI-safe runs

In CI, disable interactive OAuth prompts:

```bash
flowgraph run ./atlassian.graph.yaml \
  --on-interrupt fail \
  --no-mcp-oauth
```

Pre-authenticate tokens in a setup step, or use stdio mock servers for integration tests. See [examples/mcp](../examples/mcp/README.md) for mock server + audit graph patterns.

## Provider environment variables

MCP OAuth tokens are **independent** of LLM API keys. Intelligent nodes reuse the same MCP hub as deterministic `mcp` nodes.

### LLM providers

| Provider | Package | Environment variable | Notes |
|----------|---------|---------------------|-------|
| LangChain / OpenAI | `@veloxdevworks/flowgraph-core` + `@langchain/openai` | `OPENAI_API_KEY` | Also supports Anthropic, xAI, Ollama, Google via `providers` block |
| LangChain / Anthropic | `@veloxdevworks/flowgraph-core` + `@langchain/anthropic` | `ANTHROPIC_API_KEY` | `vendor: anthropic` in `providers` |
| Claude Agent SDK | `@veloxdevworks/flowgraph-provider-claude` | `ANTHROPIC_API_KEY` | Optional `apiKeyEnv` override in YAML |
| Cursor SDK | `@veloxdevworks/flowgraph-provider-cursor` | `CURSOR_API_KEY` | `runtime: local` or `cloud` |

### MCP auth (non-OAuth)

For HTTP servers using bearer tokens:

```yaml
mcpServers:
  my-api:
    transport: http
    url: "https://api.example.com/mcp"
    headers:
      Authorization: "Bearer {{ secret.MY_API_TOKEN }}"
```

Set `MY_API_TOKEN` in `.env` (loaded automatically by the CLI from cwd).

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| OAuth prompt in CI | Use `--no-mcp-oauth`; run `mcp auth login` locally first or use mock stdio server |
| "No checkpoint found" on resume | Enable `runtime.checkpoint.backend: sqlite` with a persistent path |
| Empty tool list | Verify server is running (stdio) or tokens are valid (HTTP/OAuth) |
| Tool call blocked | Check `permission: ask`, `runtime.hooks`, or `--on-interrupt fail` |

## Examples

- [examples/mcp/](../examples/mcp/) — Mock stdio server, OAuth Atlassian agent, integration audit graphs
- [examples/mcp/atlassian-agent.graph.yaml](../examples/mcp/atlassian-agent.graph.yaml) — Intelligent agent with MCP tools
