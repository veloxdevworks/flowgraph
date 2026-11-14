# 08 — Providers (Intelligent-Node Backends)

An **intelligent** node delegates its agent loop to a **provider**. flowgraph defines a **pluggable provider interface** first, then ships adapters as optional packages so you install only the backends your graphs reference. v1 targets three: **Claude Agent SDK**, **Cursor SDK**, and a generic **LangChain ChatModel** adapter (LangChain is also built into `@flowgraph/core` for convenience).

## 1. Why an abstraction

- The hub-and-spoke agent loop (tool-calling, multi-step, structured output) is conceptually the same across backends; only the SDK calls differ.
- Decoupling lets graphs be **portable** (`provider:` swap) and lets the community add providers (Gemini, OpenAI Responses, local models) without touching core.
- Heavy SDKs (which may bundle native binaries — e.g. Claude Agent SDK ships a Claude Code binary) stay out of `@flowgraph/core`.

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
  contextMessages?: boolean;       // sends AgentRequest.messages as chat turns (see 17-context.md)
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

Two consumption modes share one client (`@flowgraph/mcp`):

1. **Deterministic** — `type: mcp` nodes call a specific tool or read a resource with arguments mapped from state.
2. **Agentic** — `{ mcp: atlassian }` under `intelligent.with.tools` expands the server's tools at run time and routes invocations through `ctx.invokeTool` (hooks, HITL, events).

```yaml
- id: triage
  type: agent
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
2. **`runtime.hooks`** — fine-grained control per tool name on `agent:beforeToolCall` (`veto`, `interrupt`, mutate args). Recommended for side-effecting tools like `fs_write` ([11 — Local Tools](./11-local-tools.md)).

`permission: ask` and hook `do: interrupt` both route through HITL ([07 §HITL](./07-runtime-and-execution.md#5-human-in-the-loop)).

### Declarative `providers` block (LangChain)

Graphs declare LLM backends once at the top level. The CLI builds and registers them on `flowgraph run` / `resume`:

```yaml
providers:
  main:
    kind: langchain
    vendor: anthropic          # openai | anthropic | xai | ollama | google | bedrock
    model: claude-3-5-sonnet-latest
    options: { temperature: 0 }
    baseUrl: http://localhost:11434   # optional (ollama, proxies)
    apiKeyEnv: ANTHROPIC_API_KEY      # optional override
    # region: us-east-1               # required for bedrock (AWS region)

config:
  defaults:
    provider: main
    model: claude-3-5-sonnet-latest   # optional per-run override on agent nodes
```

**Shorthand:** `config.defaults.provider: anthropic` (bare vendor name) synthesizes a LangChain provider when no matching `providers` entry exists.

Install the vendor package you reference (`@langchain/anthropic`, `@langchain/openai`, `@langchain/aws`, etc.) and set the API key env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …). Ollama needs no key; set `baseUrl` if not localhost.

**AWS Bedrock** (`vendor: bedrock`): use an [inference-profile model ID](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html) (e.g. `us.anthropic.claude-sonnet-4-20250514-v1:0`), set `region` on the provider entry, and authenticate via the AWS default credential chain — `AWS_PROFILE` / `~/.aws` files, or `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ optional `AWS_SESSION_TOKEN`). There is no single API-key env for Bedrock. Note: the LangChain adapter constructs the chat model from the provider entry's `model` at build time and ignores per-node `model:` / `req.model` for LangChain vendors.

MCP OAuth tokens (`.flowgraph/mcp-oauth/`) are independent of LLM API keys — agent nodes reuse the same MCP hub as deterministic `mcp` nodes.

### Media providers (image / video / 3D)

`image`, `video` and `model3d` nodes use **media providers**, a separate interface from the agent `ProviderAdapter` (media generation is an async job, not an agent loop; see [ADR-0017](./adr/0017-generative-media-nodes-and-plugin-manifest.md)). Credentials are configured **once** in the same `providers:` block:

```yaml
providers:
  grok:   { kind: langchain, vendor: xai }      # agents AND images/video use this one entry
  gpt:    { kind: langchain, vendor: openai }   # agents AND image generation
  tripo:  { kind: media, vendor: tripo }        # dedicated media backend, no LLM side
  meshy:  { kind: media, vendor: meshy, apiKeyEnv: MESHY_KEY }
```

- A `langchain` entry whose vendor has a registered media adapter (`xai`, `openai`) automatically **also** serves media under the same name, reusing its `apiKeyEnv` and `baseUrl`. The entry's `model` is an LLM model id and is not used for media; set `model:` on the media node instead.
- `kind: media` is for backends with no LLM side, or to pin separate credentials. Fields: `vendor`, `model`, `baseUrl`, `apiKeyEnv`, `options`. The key is read at call time through the run's secret provider (`env`/`dotenv`).
- A bare vendor name also works (`provider: xai` on a node) using that vendor's default key env var.
- A node without `provider:` uses `config.defaults.provider` when that provider can do the modality, otherwise the only provider that can, otherwise fails listing the candidates.
- **Third-party vendors:** a plugin loaded through `imports[].providers` calls `registerMediaVendor({ vendor, modalities, create })` (or `registerMediaProvider`) from `@flowgraph/core`; `kind: media` entries then name the vendor. A `MediaProvider` implements `start` / `poll` / `fetch` / `cancel` and persists outputs through the supplied `saveOutput`.
**Reference vendors (`@flowgraph/media`)**, loaded automatically by the CLI and server. Written from each vendor's official docs (2026-11-05); **not yet exercised against the live APIs**. Model ids and prices move quickly, so check the vendor docs and override with `model:` on the node or `model` on the provider entry.

| Vendor id | Use via | Serves | Key env (default) | Default model(s) | Notes |
|---|---|---|---|---|---|
| `xai` | `langchain` entry (vendor `xai`) or `kind: media` | image, video | `XAI_API_KEY` (also `GROK_API_KEY`) | `grok-imagine-image-2.0`, `grok-imagine-video-1.5` | Image generate + edit (up to 5 reference images); video is async, image-to-video with one input, reference images with several. No cancel endpoint. Reports actual cost. |
| `openai` | `langchain` entry (vendor `openai`) or `kind: media` | image | `OPENAI_API_KEY` | `gpt-image-2.5-sunburst` | Generations and edits (up to 16 inputs). Token-priced, so the cost is reported after the call. OpenAI's video API (Sora) was shut down on 2026-09-24, so there is no OpenAI video. |
| `tripo` | `kind: media` | model3d | `TRIPO_API_KEY` | `v3.1-20260211` | Text, single-image and multiview. GLB natively; other formats go through a paid convert step. Model URLs are short-lived, so the file is downloaded immediately. |
| `meshy` | `kind: media` | model3d | `MESHY_API_KEY` | Meshy `latest` | Text (preview then refine run as one job), image, multi-image. Formats: glb, fbx, obj, usdz, stl, 3mf. No price per credit is published, so no cost is reported. |
| `elevenlabs` | `kind: media` | audio (speech, sfx, music) | `ELEVENLABS_API_KEY` (also `XI_API_KEY`) | `eleven_v4`, `eleven_text_to_sound_v3`, `music_v2_5` | All synchronous. A voice may be an id or a name (looked up). Music needs a paid plan. `ogg`/`flac` are not offered; music has no `wav`. |

Suno has no public API today (invite-only partner beta), so there is no Suno adapter; see ADR-0017.

- On the hosted server, an untrusted author's `kind: media` entry is subject to the same endpoint checks as `langchain` entries (no `baseUrl`).

### Local CLI providers (`kind: cli`)

SDK providers keep their declared backend: a missing key fails with the configured environment-variable name, even when a local agent CLI is installed. To use a local agent and its login/billing, declare `kind: cli` explicitly. For OpenAI, the top-level `baseUrl` overrides `options.configuration.baseURL`; other client configuration fields are retained. For Anthropic and xAI it is passed as the client's own endpoint option (`anthropicApiUrl`, `baseURL`). Generated agent templates require choosing a model before running them.

When Claude Code, Cursor CLI, Codex, or Grok Build is installed on `PATH`, you can run agent nodes against that local CLI instead of an API key:

```yaml
providers:
  local:
    kind: cli
    vendor: claude          # claude | cursor | codex | grok
    # binary: claude        # optional override (defaults: claude, cursor-agent, codex, grok)
    # model: claude-sonnet-4.5
    # cwd: ./workspace
```

**Explicit backend:** `claude`, `cursor`, and `langchain` entries always use their declared SDK/API backend. An installed CLI does not change credential selection or billing. Choose `kind: cli` when local-agent execution is intended.

**v1 limits:** the CLI provider is single-shot (prompt → text). It does not mediate flowgraph tools/MCP through the CLI; the installed CLI runs its own agent loop. For hub-and-spoke tool wiring, use the SDK providers (`claude` / `cursor` / `langchain`) with an API key.

Cursor CLI (`vendor: cursor`) is always invoked with `-p --trust` so headless Desktop/sidecar runs skip the workspace-trust prompt. Claude CLI uses `-p --permission-mode dontAsk` (Claude `-p` already skips its trust dialog). Neither path passes `--force` / `--yolo` / `--always-approve` (those auto-allow shell commands).

## 3. Adapter: Claude (`@flowgraph/provider-claude`)

Wraps `@anthropic-ai/claude-agent-sdk` (`query({ prompt, options })`). Maps:

- `tools.builtin` → `options.allowedTools` (`Read`, `Edit`, `Bash`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `Skill`, ...).
- `tools.skill/node` → in-process SDK MCP tools (`createSdkMcpServer` / `tool`) that call back into flowgraph.
- `tools.mcp` → MCP server config.
- `schema` → structured output via a final tool/`output` contract.
- `permission` → SDK permission mode / `canUseTool` callback (→ flowgraph HITL). Unattended runs default to `dontAsk` (no TTY prompts); `permission: ask` keeps `default` so HITL can fire. Set `providers.claude.permissionMode` to override.
- Streams SDK messages → `agent.step` / `agent.tool.call` / `agent.token` events.

```yaml
- id: implement
  type: agent
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
    permissionMode: acceptEdits   # default | acceptEdits | bypassPermissions | plan | dontAsk
    cwd: "{{ run.workspace }}"
    apiKeyEnv: ANTHROPIC_API_KEY  # optional override
```

Auth: `ANTHROPIC_API_KEY` (env/secret, or `apiKeyEnv` override). Requirements documented for preflight (Node ≥ 18; bundled binary).

## 4. Adapter: Cursor (`@flowgraph/provider-cursor`)

```yaml
providers:
  cursor:
    kind: cursor
    model: composer-2.5
    runtime: local              # local | cloud
    apiKeyEnv: CURSOR_API_KEY   # optional override
```

Wraps `@cursor/sdk` (`Agent.create`/`prompt`/`stream`). Maps the same `AgentRequest` onto the Cursor agent loop, exposing skills/nodes as `local.customTools` and streaming run messages into flowgraph events. Supports Cursor's local vs. cloud runtime selection via `providers.cursor.runtime` or `with.cursor.runtime`. Auth via `CURSOR_API_KEY` (or `apiKeyEnv`), surfaced to preflight.

Local runs always set `local.trust: true` (same idea as Cursor CLI `--trust`): flowgraph has already chosen the workspace, and there is no TTY to answer a trust prompt. That is not `--force` / `--yolo` (auto-allow shell).

**Governance note:** Custom tools (skills/nodes/functions) route through flowgraph `checkToolCall`/`reportToolResult`. Native Cursor builtin tools do not support per-call `canUseTool`; `validate()` warns when combining `tools.builtin` with `permission: ask` or `agent:beforeToolCall` hooks — use `provider: claude` or `@flowgraph/tools-fs` for fine-grained file-tool gating.

```yaml
- id: refactor
  type: agent
  provider: cursor
  with:
    cursor: { runtime: cloud }
    tools: [{ skill: search-codebase }, { node: open-pr }]
    prompt: "Refactor {{ state.module }} to remove the deprecated API."
```

## 5. Adapter: LangChain (built into `@flowgraph/core`)

The "works with any model" baseline. Wraps a LangChain `ChatModel` (`@langchain/anthropic`, `@langchain/openai`, etc.) and implements the agent loop with bound tools (`bindTools`) + a tool-execution cycle, or delegates to LangGraph's prebuilt ReAct agent. `schema` uses `withStructuredOutput`. No provider-native `builtin` tools (warns if requested); skills/nodes/MCP work as `StructuredTool`s.

Install a LangChain vendor package for your model (e.g. `pnpm add @langchain/openai`) and set the matching API key env var. The adapter itself ships with `@flowgraph/core` — no separate flowgraph provider package required.

```yaml
- id: classify
  type: agent
  provider: langchain
  model: gpt-4o            # or anthropic, etc., per configured ChatModel
  with:
    langchain: { temperature: 0 }
    schema: { type: object, properties: { label: { type: string } }, required: [label] }
    prompt: "Classify: {{ state.text }}"
```

## 6. Selection, defaults, and validation

- Default provider/model come from `config.defaults` ([02 §config](./02-graph-spec.md#7-config)); per-node `provider:`/`model:` override.
- On `flowgraph run`, the CLI reads `providers:` from the graph YAML, constructs LangChain adapters from the built-in core provider, or lazy-loads `@flowgraph/provider-claude` / `@flowgraph/provider-cursor` by `kind`, and passes them to `compileGraph({ providers })`. Missing vendor packages or API keys fail fast with install/env hints.
- `validate()` runs at compile time: unknown model, builtin tools unsupported by the provider, MCP requested where unsupported, or missing auth env ⇒ diagnostics before any model call.

## 7. Registering a custom provider

```ts
import { defineProvider } from "@flowgraph/core";

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
| LangChain / OpenAI | `@flowgraph/core` (built-in) + `@langchain/openai` | `OPENAI_API_KEY` | `apiKeyEnv`, `baseUrl` in `providers` block |
| LangChain / Anthropic | `@flowgraph/core` (built-in) + `@langchain/anthropic` | `ANTHROPIC_API_KEY` | `vendor: anthropic` |
| LangChain / xAI | `@flowgraph/core` (built-in) + `@langchain/xai` | `XAI_API_KEY` | `vendor: xai` |
| LangChain / Google | `@flowgraph/core` (built-in) + `@langchain/google-genai` | `GOOGLE_API_KEY` | `vendor: google` |
| LangChain / Ollama | `@flowgraph/core` (built-in) + `@langchain/ollama` | _(none)_ | `baseUrl: http://localhost:11434` |
| LangChain / Bedrock | `@flowgraph/core` (built-in) + `@langchain/aws` | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`, or `AWS_PROFILE` | `vendor: bedrock`, `region`, inference-profile `model` ID |
| Claude Agent SDK | `@flowgraph/provider-claude` | `ANTHROPIC_API_KEY` | `apiKeyEnv` in `providers.claude` |
| Cursor SDK | `@flowgraph/provider-cursor` | `CURSOR_API_KEY` | `apiKeyEnv`, `runtime: local\|cloud` |

MCP OAuth tokens (`.flowgraph/mcp-oauth/`) and LLM API keys are independent. For MCP setup, OAuth flows, and CI patterns, see [15 — MCP operations](./15-mcp-operations.md).

## 9. Cost & pricing tables

Each adapter supplies a pricing function (model → $/token) used by the budget/cost machinery ([06 §6](./06-events-and-hooks.md#6-cost--token-accounting)). Tables are overridable via config for negotiated rates or new models.

**LangChain vendors (including Bedrock):** the built-in LangChain adapter records token usage from the model response but does **not** populate `costUSD`. USD budgets (`runtime.budget.maxUSD` / related hooks) therefore do not enforce for LangChain backends today — use token budgets, or supply a custom pricing/cost path. This is an accepted limitation until vendor pricing maps are added.

## 10. Agent completion and retries

`with.schema` validates the final output against JSON Schema draft-07, including nested objects, arrays, required fields, enums, formats, and additional-property restrictions. Validation does not coerce data or remove fields. Invalid schemas/outputs fail with `AGENT_SCHEMA_INVALID`/`AGENT_OUTPUT_INVALID`. LangChain uses native structured output when supported. With tools, a constrained finalization call follows the tool loop; this can add one model call. Otherwise the final text must parse as valid JSON matching the schema. Vendor/model API restrictions still apply; OpenAI models that require the Responses API can set `options.useResponsesApi: true`.

Tools are explicit. To offer issue reporting, add `tools: [{ function: report_issue }]`; it is no longer injected into every call. Recoverable tool-handler exceptions become `{ isError: true, error: { code, message } }` tool results, allowing the model to recover. Permission denial, interrupts, replay mismatches, cancellation, and non-retryable runtime failures still propagate. MCP `isError` fails deterministic nodes and becomes a recoverable tool failure inside an agent.

Exhausting `with.maxSteps` fails with `AGENT_MAX_STEPS` (including `partialOutput` on the error) instead of reporting success. Configured LangChain models force SDK `maxRetries` to zero. Configure the node's `retry` policy for bounded retries with `node.retry` events; raw models supplied to `createLangChainProvider` remain the caller's responsibility.
