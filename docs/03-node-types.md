# 03 — Node Types

A node is a unit of work. Every node resolves through the **Node Registry** ([Architecture §3](./01-architecture.md#3-the-node-registry)) from its `type` string to a `NodeFactory`. This doc specifies the built-in node types and the contract for custom ones.

## 0. Common node contract

Regardless of type, every node:

- has a unique `id`, optional `name`/`description`;
- may declare an `input` mapping (state → node input object) and a `when` guard;
- may set `retry`, `timeout`, and `on.error` behavior;
- is wrapped by the runtime middleware (events, hooks, OTel, retry/timeout — see [01 §4](./01-architecture.md#4-runtime-composition));
- returns a **NodeResult**: either a partial state update, or a `Command` (control-flow directive: go to node X, update state, or interrupt).

```ts
type NodeResult =
  | { update?: Partial<GraphState> }                       // merge into channels (via reducers)
  | { command: { goto?: string | string[]; update?: Partial<GraphState> } }
  | { interrupt: { reason: string; payload: unknown } };   // pause for HITL
```

Node **capabilities** are declared by the factory so the compiler/runtime can reason about them:

```ts
interface NodeCapabilities {
  sideEffecting?: boolean;   // mutates the outside world (affects retry/replay safety)
  streaming?: boolean;       // emits incremental output events
  interruptible?: boolean;   // may raise HITL interrupts
  routing?: boolean;         // returns control-flow commands
}
```

---

## 1. `intelligent` — agent node (hub & spoke)

An LLM-driven agent that runs a tool-calling loop. **This is the hub in hub-and-spoke**: other nodes and skills are exposed to it as callable tools (spokes). It decides which to call, loops until done, then writes its result back to state. Backed by a pluggable **provider** (see [08 — Providers](./08-providers.md)).

```yaml
- id: implement
  type: intelligent
  provider: claude                 # claude | cursor | langchain | <registered>  (defaults from config)
  model: claude-sonnet-4.5         # optional; provider-specific
  input:
    task: "{{ state.currentTask }}"
  with:
    system: "You are a senior engineer. Implement the task, then stop."
    prompt: "Task:\n{{ input.task }}"

    # --- hub & spoke: expose tools the agent may call ---
    tools:
      - skill: run-tests           # a skill becomes a tool
      - skill: search-codebase
      - node: open-pr              # another graph node exposed as a tool
      - builtin: [Read, Edit, Bash]  # provider-native tools (e.g. Claude Agent SDK tools)
      - mcp: "@acme/mcp-jira"      # an MCP server's tools

    # --- structured output contract (optional) ---
    schema:                        # JSON-schema-ish; enforces/parses structured result
      type: object
      properties:
        filesChanged: { type: array, items: { type: string } }
        summary:      { type: string }
      required: [summary]

    # --- agent loop controls ---
    maxSteps: 25                   # tool-call iterations before forced stop
    maxTokens: 200000
    permission: auto               # auto | ask | deny  (tool-use approval policy; "ask" ⇒ HITL)

    output:
      to: implementation           # or map: { ... }
```

### Hub & spoke semantics

- The agent runs **inside a single graph node**. Its internal tool-calls do **not** create graph edges; they are intra-node steps. This keeps the graph topology readable while allowing rich agent behavior.
- A tool that is a **skill** or **node** is invoked through flowgraph's runtime, so tool-calls still emit events/traces (nested spans under the agent span) and respect contracts.
- `permission: ask` raises a **HITL interrupt before every tool call** on that node. `permission: deny` blocks all tool calls. `permission: auto` (default) allows tools unless a hook vetoes or interrupts.
- Per-tool gates use `runtime.hooks` on `intelligent:beforeToolCall` (e.g. require approval only for `fs_write`). See [11 — Local Tools](./11-local-tools.md).
- In CI, interrupt behavior is governed by `--on-interrupt` / `runtime.hitl.onInterrupt`.
- When a richer, *visible-in-the-graph* decomposition is wanted, use a `router` + explicit nodes or a `subgraph` instead of (or in addition to) agent tools. The two compose.

### Provider mapping

`provider: claude` ⇒ `@anthropic-ai/claude-agent-sdk` `query()` loop; `provider: cursor` ⇒ `@cursor/sdk`; `provider: langchain` ⇒ a bound `ChatModel` with tool-calling. Provider-specific knobs are namespaced (see [08](./08-providers.md)). Built-in tool names like `Read/Edit/Bash` are provider-native and validated against the chosen provider's capabilities at compile time.

---

## 2. `skill` — invoke a declared skill

Runs a **skill**: a portable, contract-bearing unit defined by a `SKILL.md` file (front-matter + body). The skill declares its inputs/outputs and environment dependencies; flowgraph validates the contract and runs a **preflight** to confirm the env can execute it. Full spec: [04 — Skills](./04-skills.md).

```yaml
- id: file-bug
  type: skill
  uses: ./skills/create-jira-bug      # path | imported alias | published package
  input:
    project: "{{ config.vars.jiraProject }}"
    summary: "{{ state.summary }}"
  with:
    output: { to: ticket }            # map skill's declared outputs into state
```

- `uses` resolves to a skill (by alias from `imports`, relative path, or package).
- The skill's declared **input contract** is validated against the provided `input`.
- The skill's declared **output contract** is validated against what it returns and mapped via `output`.
- If the skill's `env` requirements are unmet, compilation/preflight fails with a precise "missing `JIRA_TOKEN`" / "requires `git` on PATH" message ([04 §Preflight](./04-skills.md#5-preflight--environment-checks)).
- Skills may themselves be **executable** (a TS handler), **command-based** (run a CLI), or **agent-backed** (delegate to an intelligent provider) — see [04 §Skill kinds](./04-skills.md#3-skill-kinds).

---

## 3. `router` — intelligent / rule-based routing

A node whose job is to **choose the next node(s)** based on state/output. Routing can be rule-based (expressions) or model-based (an LLM picks among labeled routes). Implemented via LangGraph conditional edges, but expressed as a first-class node for readability.

```yaml
- id: route-by-result
  type: router
  with:
    mode: rules                    # rules | model
    input: "{{ state.testResults }}"
    routes:
      passed:  { when: "{{ state.testResults.failed == 0 }}", to: open-pr }
      failed:  { when: "{{ state.testResults.failed > 0 }}",  to: fix-loop }
      flaky:   { when: "{{ state.testResults.flaky }}",       to: rerun-tests }
      default: { to: needs-human }
```

Model-based routing:

```yaml
- id: classify-intent
  type: router
  with:
    mode: model
    provider: claude
    input: "{{ state.userMessage }}"
    instruction: "Pick the route that best matches the user's intent."
    routes:
      billing:   { description: "Questions about invoices/payments", to: billing-flow }
      technical: { description: "Bug reports / how-to", to: tech-flow }
      default:   { to: fallback }
```

- A router may target **multiple** routes (fan-out) by returning more than one match (configurable: `firstMatch` vs `allMatches`).
- Model-based routers are constrained to emit one of the declared route keys (enforced via structured output), so routing is always valid.
- Routers are `routing: true` capability; they return a `Command{ goto }` rather than a state update.

---

## 4. `http` / `webhook` / `mcp` — network & integration I/O

Deterministic network and integration nodes.

### `mcp` — deterministic MCP tool or resource call

Calls a tool or reads a resource on a server declared in the graph's top-level `mcpServers` block. No model in the loop — use this for imperative, durable orchestration over vendor MCP servers (Jira, Notion, GitHub, etc.).

```yaml
mcpServers:
  mock:
    transport: stdio
    command: node
    args: ["./server/mock-mcp-server.js"]

nodes:
  - id: echo
    type: mcp
    with:
      server: mock
      tool: echo
      arguments:
        message: "{{ state.message }}"
      output: { to: echoed }
```

- `server` must match a key in `mcpServers`.
- Specify **one of** `tool` (with optional `arguments`) or `resource` (URI string, supports `{{ }}`).
- Emits `mcp.tool.call` / `mcp.tool.result` or `mcp.resource.read` events.
- Requires an `McpHub` at run time (CLI builds it automatically from `mcpServers`; programmatic runs pass `compileGraph({ mcp })`).

See `examples/mcp/` for a runnable walkthrough.

### `http` — make an outbound request

```yaml
- id: fetch-prs
  type: http
  with:
    method: GET
    url: "https://api.github.com/repos/{{ config.vars.repo }}/pulls?state=closed"
    headers:
      Authorization: "Bearer {{ secret.GITHUB_TOKEN }}"   # secrets via secret.* (redacted)
    query: { per_page: 100 }
    # body: { ... }          # for POST/PUT/PATCH; supports {{ }} interpolation
    expect: { status: [200] }            # assert; non-match ⇒ node error
    retry: { maxAttempts: 3, retryOn: [429, 502, 503] }
    output:
      map: { prs: "{{ result.body }}" }   # parse JSON by default; result.body/status/headers
```

### `webhook` — receive / wait for an inbound event

```yaml
- id: await-approval
  type: webhook
  with:
    mode: wait                   # wait (inbound) | emit (outbound notify)
    # In `wait` mode the node interrupts until an external system resumes
    # with a payload (durable via checkpointer). Resume via compiled.resume()
    # or `flowgraph resume --thread <id> --resume '{"approved":true}'`.
    timeout: 24h
    schema: { type: object, properties: { approved: { type: boolean } }, required: [approved] }
    output: { to: approval }
```

`webhook: wait` is built on the same interrupt/resume machinery as HITL ([07 §HITL](./07-runtime-and-execution.md#5-human-in-the-loop)). In `emit` mode the node POSTs to a configured URL (idempotent via `ctx.once`). In CI without a resume caller, behavior follows the `onInterrupt` policy.

---

## 5. `code` — typed inline/registered TS logic

The escape hatch for deterministic logic that does not warrant a full skill. References a **registered** TS function by name (not embedded source — keeps YAML safe and analyzable, per [Vision §Design principles](./00-vision.md#6-design-principles)).

```yaml
- id: dedupe-findings
  type: code
  with:
    fn: "dedupeFindings"          # resolved from the registered function table
    input: { findings: "{{ state.findings }}" }
    output: { to: findings }
```

```ts
// registered at compile time
registry.registerFunction("dedupeFindings", (input, ctx) => {
  const seen = new Set<string>();
  return { findings: input.findings.filter(f => !seen.has(f.id) && seen.add(f.id)) };
});
```

For substantial reusable logic, prefer a **skill** (portable, contract + env declared) over a `code` node.

---

## 6. `subgraph` — embed another graph

Composes a child graph as a single node. Enables modular libraries of graphs and the "fan out per task" software-factory pattern.

```yaml
- id: run-tests
  type: subgraph
  uses: tests                    # imported via imports[].subgraph
  input: { repo: "{{ state.repo }}", sha: "{{ state.sha }}" }
  with:
    output: { map: { testResults: "{{ result.summary }}" } }
    # state mapping between parent/child channels:
    stateMap:
      in:  { repo: repo, sha: sha }
      out: { summary: testResults }
```

The child graph runs with its own channels; `stateMap` projects parent state in and child state out. Child events are nested under the parent's span. The parent must use checkpointing (`runtime.checkpoint`) for nested HITL inside the child to pause and resume correctly — the child inherits the parent's LangGraph checkpointer.

On resume, the parent `subgraph` node re-executes from the top (recomputing `stateMap.in`). Side effects reached before a nested interrupt should use `ctx.once()` so they do not re-fire on replay (same pattern as top-level HITL nodes).

---

## 7. `map` — fan-out over a collection

Run a node/subgraph once per item in a collection, concurrently, then fan-in. (Sugar over LangGraph's parallel branches + reducers.)

```yaml
- id: implement-all
  type: map
  with:
    over: "{{ state.tasks }}"       # array
    as: task                        # each item bound as {{ item.task }}
    concurrency: 3                  # max parallel
    node:                           # the per-item node (any type, incl. subgraph)
      type: subgraph
      uses: implement-task
      input: { task: "{{ item.task }}" }
    collect:
      to: results                   # results array written via append reducer
```

---

## 8. `hitl` — human gates (approve / question / choice)

Deterministic pause points for human input. Unlike `wait` (duration/signal/condition), `hitl` is for explicit operator interaction with a typed resume value.

```yaml
- id: approve-deploy
  type: hitl
  with:
    mode: approve                    # approve | question | choice
    message: "Deploy {{ state.version }} to production?"
    output: { to: approval }

- id: clarify-repo
  type: hitl
  with:
    mode: question
    message: "Which repository should we target?"
    output: { to: repoAnswer }

- id: pick-strategy
  type: hitl
  with:
    mode: choice
    message: "How should we proceed?"
    choices: ["retry", "skip", "abort"]
    output: { to: strategy }
```

Each mode sets an interrupt **kind** (`approval`, `question`, `choice`) so the CLI and external GUIs know how to prompt and parse the resume value.

### `ask_human` tool (intelligent nodes)

Agents can ask clarifying questions mid-loop by opting into the built-in tool:

```yaml
- id: planner
  type: intelligent
  with:
    prompt: "{{ state.task }}"
    tools:
      - function: ask_human
```

The tool raises a `question` or `choice` interrupt; the answer is returned to the agent as `{ answer: "..." }`.

---

## 9. `wait` / `delay` — time & external gates

```yaml
- id: cool-down
  type: wait
  with:
    duration: 30s                   # fixed delay (in-process sleep)
    # or: until: "{{ state.ready }}"  (durable interrupt until condition is true on resume)
    # or: signal: deploy-finished    (durable interrupt until resumed with that signal)
    # optional on until/signal:
    timeout: 24h                    # informational deadline (see below)
```

### Modes

| Mode | Behavior | Survives process restart? |
|---|---|---|
| `duration` | In-process sleep for the given duration | No — same as any in-flight node |
| `until` | Interrupt if the guard is false; re-evaluate on resume | Yes (checkpointed interrupt) |
| `signal` | Interrupt until resumed with a payload for the named signal | Yes (checkpointed interrupt) |

### Observability

- **`duration`:** emits a `node.output` event before sleeping: `{ wait: { mode: "duration", durationMs, wakeAt } }`. Use `wakeAt` (ISO timestamp) in CLIs/TUIs to show when the run will continue.
- **`until` / `signal`:** optional `timeout` is included in the interrupt `data` payload (visible via `flowgraph resume --list --json`) so operators can see the intended deadline.

### `timeout` (informational only)

`timeout` on `until`/`signal` is **surfaced as metadata** on the interrupt payload but is **not enforced** by the runtime today. A durable, cross-restart deadline would require an external scheduler to resume or fail the run after the deadline (same class of feature as cron-driven resume). Until that exists, treat `timeout` as documentation for operators and external tooling.

`wait` for external signals/conditions uses interrupt/resume so it survives restarts.

---

## 9. Built-in node summary

| `type` | Purpose | Capabilities | Package |
|---|---|---|---|
| `intelligent` | Agent loop w/ tools (hub & spoke) | streaming, interruptible, side-effecting | core (+ provider pkg) |
| `skill` | Run a declared skill | varies by skill | core (+ `@veloxdevworks/flowgraph-skills`) |
| `router` | Choose next node(s) | routing | core |
| `http` | Outbound HTTP | side-effecting | core |
| `mcp` | MCP tool/resource call | side-effecting | core (+ `@veloxdevworks/flowgraph-mcp` at runtime) |
| `webhook` | Inbound wait / outbound emit | interruptible, side-effecting | core |
| `code` | Registered TS function | varies | core |
| `subgraph` | Embed a child graph | composite | core |
| `map` | Fan-out over a collection | composite, parallel | core |
| `hitl` | Human approve / question / choice gate | interruptible | core |
| `wait` | Delay / condition / signal gate | interruptible | core |

---

## 10. Custom node types (plugins)

Third parties extend the registry by publishing a node plugin package and importing it (`imports[].nodes`). A plugin exports `NodeFactory`s:

```ts
// @acme/flowgraph-nodes-aws
import { defineNode } from "@veloxdevworks/flowgraph-core";
import { z } from "zod";

export const s3Put = defineNode({
  type: "aws.s3.put",
  configSchema: z.object({
    bucket: z.string(),
    key: z.string(),
    body: z.string(),
  }),
  capabilities: { sideEffecting: true },
  build(ctx, config) {
    return {
      contract: { inputs: {/*...*/}, outputs: {/*...*/} },
      async run(state, runCtx) {
        const body = runCtx.render(config.body);          // evaluate {{ }} against state
        await runCtx.secrets.with("AWS_ACCESS_KEY_ID", /* ... */);
        // ... do the put ...
        return { update: { /* ... */ } };
      },
    };
  },
});

export default [s3Put];   // registered when the package is imported
```

Custom nodes get the full runtime treatment (events, hooks, tracing, retries) automatically. They should declare accurate `capabilities` (especially `sideEffecting`) so replay/retry stays safe. Where a node depends on environment/tools, prefer expressing those as a **skill** or documenting them so preflight can warn.
