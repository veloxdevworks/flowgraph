# 08 — Providers (Intelligent-Node Backends)

An **intelligent** node delegates its agent loop to a **provider**. flowgraph defines a **pluggable provider interface** first, then ships adapters as optional packages so you install only the backends your graphs reference. v1 targets three: **Claude Agent SDK**, **Cursor SDK**, and a generic **LangChain ChatModel** adapter (LangChain is also built into `@veloxdevworks/flowgraph-core` for convenience).

## 1. Why an abstraction

- The hub-and-spoke agent loop (tool-calling, multi-step, structured output) is conceptually the same across backends; only the SDK calls differ.
- Decoupling lets graphs be **portable** (`provider:` swap) and lets the community add providers (Gemini, OpenAI Responses, local models) without touching core.
- Heavy SDKs (which may bundle native binaries — e.g. Claude Agent SDK ships a Claude Code binary) stay out of `@veloxdevworks/flowgraph-core`.

## 2. The `ProviderAdapter` interface

```ts
interface ProviderAdapter {
  name: string;                                   // "claude" | "cursor" | "langchain" | ...
  capabilities: ProviderCapabilities;

  /** Run an agent loop until completion or interrupt. */
  run(req: AgentRequest, ctx: ProviderRunContext): Promise<AgentResult>;

  /** Optional streaming variant emitting step/token/tool events. */
  stream?(req: AgentRequest, ctx: ProviderRunContext): AsyncIterable<AgentEvent>;

  /** Validate provider-specific config + tools at compile time. */
  validate?(config: unknown): Diagnostics;
}

interface ProviderCapabilities {
  toolCalling: boolean;
  structuredOutput: boolean;       // native schema-constrained output
  streaming: boolean;
  builtinTools?: string[];         // e.g. ["Read","Edit","Bash","Glob","Grep","WebSearch"]
  mcp?: boolean;                   // can consume MCP servers as tools
  models?: string[];              // known model ids (for validation/autocomplete)
}

interface AgentRequest {
  system?: string;
  prompt: string;                  // rendered from {{ }} against state/input
  messages?: Message[];            // optional prior context (e.g. from a messages channel)
  tools: ToolSpec[];               // normalized tools (skills/nodes/builtin/mcp)
  schema?: JsonSchema;             // desired structured output
  model?: string;
  maxSteps?: number;
  maxTokens?: number;
  permission: "auto" | "ask" | "deny";
}

interface AgentResult {
  output: unknown;                 // structured (if schema) or { text }
  messages: Message[];             // final transcript (optional → messages channel)
  steps: AgentStep[];              // tool calls + reasoning trace (for events)
  usage: TokenUsage;               // tokens + cost estimate
  stopReason: "done" | "maxSteps" | "interrupted" | "error";
}
```

### Tool normalization

flowgraph converts a node's `with.tools` into provider-agnostic `ToolSpec`s, then each adapter maps them to its SDK:

| flowgraph tool ref | Becomes | Claude adapter | Cursor adapter | LangChain adapter |
|---|---|---|---|---|
| `skill: <name>` | skill-as-tool (schema = skill `inputs`) | SDK in-process tool / MCP tool | SDK tool | `DynamicStructuredTool` |
| `node: <id>` | node-as-tool | wrapped tool | wrapped tool | tool |
| `builtin: [...]` | provider-native tools | `allowedTools` | native tools | n/a (warn) |
| `mcp: <server>` | MCP server tools (expanded at run time) | MCP server config | MCP config | `StructuredTool` via hub |
| `mcp: <server>` + `tools: [...]` | allow-listed subset of server tools | same | same | same |

### MCP-first integrations (v1)

Graphs declare MCP servers once at the top level (familiar from Claude/Cursor):

```yaml
mcpServers:
  atlassian:
    transport: http
    url: "https://mcp.example.com/v1"
    headers:
      Authorization: "Bearer {{ secret.ATLASSIAN_TOKEN }}"
```

Two consumption modes share one client (`@veloxdevworks/flowgraph-mcp`):

1. **Deterministic** — `type: mcp` nodes call a specific tool or read a resource with arguments mapped from state.
2. **Agentic** — `{ mcp: atlassian }` under `intelligent.with.tools` expands the server's tools at run time and routes invocations through `ctx.invokeTool` (hooks, HITL, events).

```yaml
- id: triage
  type: intelligent
  provider: mock
  with:
    prompt: "Create a ticket if needed."
    tools:
      - mcp: atlassian
        tools: [create_issue, search_issues]   # optional allow-list
```

CLI: `flowgraph mcp tools <graph>` lists discovered tools per server. Remote OAuth servers use `auth.type: oauth2` plus `flowgraph mcp auth login <graph> <server>` (tokens in `.flowgraph/mcp-oauth/`, auto-refresh on run). Header/env bearer tokens remain supported for simpler server auth.

When a tool is invoked, the adapter calls back into flowgraph's runtime (`ctx.invokeTool`), so the call is contract-validated, event-emitting, and hook-able ([06](./06-events-and-hooks.md)).

**Governance layers:**

1. **Node `permission`** — `auto` (default), `ask` (interrupt every tool call), or `deny` (no tools).
2. **`runtime.hooks`** — fine-grained control per tool name on `intelligent:beforeToolCall` (`veto`, `interrupt`, mutate args). Recommended for side-effecting tools like `fs_write` ([11 — Local Tools](./11-local-tools.md)).

`permission: ask` and hook `do: interrupt` both route through HITL ([07 §HITL](./07-runtime-and-execution.md#5-human-in-the-loop)).

### Declarative `providers` block (LangChain)

Graphs declare LLM backends once at the top level. The CLI builds and registers them on `flowgraph run` / `resume`:

```yaml
providers:
  main:
    kind: langchain
    vendor: anthropic          # openai | anthropic | xai | ollama | google
    model: claude-3-5-sonnet-latest
    options: { temperature: 0 }
    baseUrl: http://localhost:11434   # optional (ollama, proxies)
    apiKeyEnv: ANTHROPIC_API_KEY      # optional override

config:
  defaults:
    provider: main
    model: claude-3-5-sonnet-latest   # optional per-run override on intelligent nodes
```

**Shorthand:** `config.defaults.provider: anthropic` (bare vendor name) synthesizes a LangChain provider when no matching `providers` entry exists.

Install the vendor package you reference (`@langchain/anthropic`, `@langchain/openai`, etc.) and set the API key env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …). Ollama needs no key; set `baseUrl` if not localhost.

MCP OAuth tokens (`.flowgraph/mcp-oauth/`) are independent of LLM API keys — intelligent nodes reuse the same MCP hub as deterministic `mcp` nodes.

**Future:** local agent CLIs (Claude Code, Codex, Grok CLI) as separate provider packages that shell out to their own runtimes; they cannot reuse the in-process MCP hub/OAuth path documented here.

## 3. Adapter: Claude (`@veloxdevworks/flowgraph-provider-claude`)

Wraps `@anthropic-ai/claude-agent-sdk` (`query({ prompt, options })`). Maps:

- `tools.builtin` → `options.allowedTools` (`Read`, `Edit`, `Bash`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `Skill`, ...).
- `tools.skill/node` → in-process SDK MCP tools (`createSdkMcpServer` / `tool`) that call back into flowgraph.
- `tools.mcp` → MCP server config.
- `schema` → structured output via a final tool/`output` contract.
- `permission` → SDK permission mode / `canUseTool` callback (→ flowgraph HITL).
- Streams SDK messages → `intelligent.step` / `intelligent.tool.call` / `intelligent.token` events.

```yaml
- id: implement
  type: intelligent
  provider: claude
  model: claude-sonnet-4.5
  with:
    claude:                         # provider-namespaced escape hatch
      permissionMode: acceptEdits
      cwd: "{{ run.workspace }}"
    tools:
      - builtin: [Read, Edit, Bash, Grep]
      - skill: run-tests
    prompt: "Implement: {{ state.task }}"
```

```yaml
providers:
  claude:
    kind: claude
    model: claude-sonnet-4.5
    permissionMode: acceptEdits   # default | acceptEdits | bypassPermissions | plan
    cwd: "{{ run.workspace }}"
    apiKeyEnv: ANTHROPIC_API_KEY  # optional override
```

Auth: `ANTHROPIC_API_KEY` (env/secret, or `apiKeyEnv` override). Requirements documented for preflight (Node ≥ 18; bundled binary).

## 4. Adapter: Cursor (`@veloxdevworks/flowgraph-provider-cursor`)

```yaml
providers:
  cursor:
    kind: cursor
    model: composer-2.5
    runtime: local              # local | cloud
    apiKeyEnv: CURSOR_API_KEY   # optional override
```

Wraps `@cursor/sdk` (`Agent.create`/`prompt`/`stream`). Maps the same `AgentRequest` onto the Cursor agent loop, exposing skills/nodes as `local.customTools` and streaming run messages into flowgraph events. Supports Cursor's local vs. cloud runtime selection via `providers.cursor.runtime` or `with.cursor.runtime`. Auth via `CURSOR_API_KEY` (or `apiKeyEnv`), surfaced to preflight.

**Governance note:** Custom tools (skills/nodes/functions) route through flowgraph `checkToolCall`/`reportToolResult`. Native Cursor builtin tools do not support per-call `canUseTool`; `validate()` warns when combining `tools.builtin` with `permission: ask` or `intelligent:beforeToolCall` hooks — use `provider: claude` or `@veloxdevworks/flowgraph-tools-fs` for fine-grained file-tool gating.

```yaml
- id: refactor
  type: intelligent
  provider: cursor
  with:
    cursor: { runtime: cloud }
    tools: [{ skill: search-codebase }, { node: open-pr }]
    prompt: "Refactor {{ state.module }} to remove the deprecated API."
```

## 5. Adapter: LangChain (built into `@veloxdevworks/flowgraph-core`)

The "works with any model" baseline. Wraps a LangChain `ChatModel` (`@langchain/anthropic`, `@langchain/openai`, etc.) and implements the agent loop with bound tools (`bindTools`) + a tool-execution cycle, or delegates to LangGraph's prebuilt ReAct agent. `schema` uses `withStructuredOutput`. No provider-native `builtin` tools (warns if requested); skills/nodes/MCP work as `StructuredTool`s.

Install a LangChain vendor package for your model (e.g. `pnpm add @langchain/openai`) and set the matching API key env var. The adapter itself ships with `@veloxdevworks/flowgraph-core` — no separate flowgraph provider package required.

```yaml
- id: classify
  type: intelligent
  provider: langchain
  model: gpt-4o            # or anthropic, etc., per configured ChatModel
  with:
    langchain: { temperature: 0 }
    schema: { type: object, properties: { label: { type: string } }, required: [label] }
    prompt: "Classify: {{ state.text }}"
```

## 6. Selection, defaults, and validation

- Default provider/model come from `config.defaults` ([02 §config](./02-graph-spec.md#7-config)); per-node `provider:`/`model:` override.
- On `flowgraph run`, the CLI reads `providers:` from the graph YAML, constructs LangChain adapters from the built-in core provider, or lazy-loads `@veloxdevworks/flowgraph-provider-claude` / `@veloxdevworks/flowgraph-provider-cursor` by `kind`, and passes them to `compileGraph({ providers })`. Missing vendor packages or API keys fail fast with install/env hints.
- `validate()` runs at compile time: unknown model, builtin tools unsupported by the provider, MCP requested where unsupported, or missing auth env ⇒ diagnostics before any model call.

## 7. Registering a custom provider

```ts
import { defineProvider } from "@veloxdevworks/flowgraph-core";

export const gemini = defineProvider({
  name: "gemini",
  capabilities: { toolCalling: true, structuredOutput: true, streaming: true, mcp: false },
  async run(req, ctx) { /* call the Gemini SDK, run tool loop, return AgentResult */ },
  async *stream(req, ctx) { /* yield AgentEvents */ },
  validate(config) { /* ... */ return []; },
});
```

Register via `compileGraph(spec, { providers: [gemini] })` or publish as `@scope/flowgraph-provider-gemini` and `imports: [{ providers: "..." }]`. This keeps the intelligent-node ecosystem open ([Vision §differentiator](./00-vision.md#2-the-idea)).

## 8. Environment variables (quick reference)

| Provider | Package | Primary env var | Optional overrides |
|----------|---------|-----------------|-------------------|
| LangChain / OpenAI | `@veloxdevworks/flowgraph-core` (built-in) + `@langchain/openai` | `OPENAI_API_KEY` | `apiKeyEnv`, `baseUrl` in `providers` block |
| LangChain / Anthropic | `@veloxdevworks/flowgraph-core` (built-in) + `@langchain/anthropic` | `ANTHROPIC_API_KEY` | `vendor: anthropic` |
| LangChain / xAI | `@veloxdevworks/flowgraph-core` (built-in) + `@langchain/xai` | `XAI_API_KEY` | `vendor: xai` |
| LangChain / Google | `@veloxdevworks/flowgraph-core` (built-in) + `@langchain/google-genai` | `GOOGLE_API_KEY` | `vendor: google` |
| LangChain / Ollama | `@veloxdevworks/flowgraph-core` (built-in) + `@langchain/ollama` | _(none)_ | `baseUrl: http://localhost:11434` |
| Claude Agent SDK | `@veloxdevworks/flowgraph-provider-claude` | `ANTHROPIC_API_KEY` | `apiKeyEnv` in `providers.claude` |
| Cursor SDK | `@veloxdevworks/flowgraph-provider-cursor` | `CURSOR_API_KEY` | `apiKeyEnv`, `runtime: local\|cloud` |

MCP OAuth tokens (`.flowgraph/mcp-oauth/`) and LLM API keys are independent. For MCP setup, OAuth flows, and CI patterns, see [15 — MCP operations](./15-mcp-operations.md).

## 9. Cost & pricing tables

Each adapter supplies a pricing function (model → $/token) used by the budget/cost machinery ([06 §6](./06-events-and-hooks.md#6-cost--token-accounting)). Tables are overridable via config for negotiated rates or new models.
