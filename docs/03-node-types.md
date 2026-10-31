# 03 — Node Types

A node is a unit of work. Every node resolves through the **Node Registry** ([Architecture §3](./01-architecture.md#3-the-node-registry)) from its `type` string to a `NodeFactory`. This doc specifies the built-in node types and the contract for custom ones.

## 0. Common node contract

Regardless of type, every node:

- has a unique `id`, optional `name`/`description`, and optional `notes` (freeform markdown for authors; ignored by the engine);
- may declare an `input` mapping (state → node input object) and a `when` guard;
- **auto-saves its result to `state.outputs.<nodeId>`** unless `with.output` is `none` (see [02 §8](./02-graph-spec.md#8-input--output-mapping)); optional `output.to` / `output.map` are additive projections for shared/typed channels;
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

## 1. `agent` — LLM agent node (hub & spoke)

An LLM-driven agent that runs a tool-calling loop. **This is the hub in hub-and-spoke**: other nodes and skills are exposed to it as callable tools (spokes). It decides which to call, loops until done, then writes its result back to state. Backed by a pluggable **provider** (see [08 — Providers](./08-providers.md)).

```yaml
- id: implement
  type: agent
  provider: claude                 # claude | cursor | langchain | <registered>  (defaults from config)
  model: claude-sonnet-4.5         # optional; provider-specific
  input:
    task: "{{ state.currentTask }}"
  with:
    # Reusable agent definition (AGENT.md) — body becomes the system prompt.
    # Optional; see [16 — Agents](./16-agents.md). Node-level `system` is appended after it.
    agent: ./agents/code-reviewer   # or an imports alias
    system: "Also prefer short answers."   # optional extra instructions
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

    # output omitted → writes state.outputs.implement automatically
    # output: { to: implementation }   # optional shared/typed channel (additive)
    # output: none                     # side-effect only; write nothing
```

### Hub & spoke semantics

- The agent runs **inside a single graph node**. Its internal tool-calls do **not** create graph edges; they are intra-node steps. This keeps the graph topology readable while allowing rich agent behavior.
- A tool that is a **skill** or **node** is invoked through flowgraph's runtime, so tool-calls still emit events/traces (nested spans under the agent span) and respect contracts.
- A `node` tool may be any node type except `map` (a map is expanded into the graph when it is compiled; put it in a `subgraph` and expose that instead). The model's arguments become the node's input. An interrupt anywhere below a node tool (an asking agent, a `hitl` node, a node inside a subgraph or map item it runs, or a node tool it calls in turn) saves the replay entries of the whole top-level node, so on resume every model turn and tool result already produced is reused and only the approved call runs. A reused tool result must have been recorded for the same tool name and arguments; if the model asks for a different call at that point the run fails with `REPLAY_MISMATCH` rather than reusing it.
- `permission: ask` raises a **HITL interrupt before every tool call** on that node. `permission: deny` blocks all tool calls. `permission: auto` (default) allows tools unless a hook vetoes or interrupts.
- Per-tool gates use `runtime.hooks` on `agent:beforeToolCall` (e.g. require approval only for `fs_write`). See [11 — Local Tools](./11-local-tools.md).
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

A node whose job is to **choose the next node(s)** based on state/output. Routing can be rule-based (expressions) or model-based (an LLM picks among labeled routes). The router's `with.routes` is the source of truth: at runtime it returns a `Command{ goto }` that jumps to the matched target. You do **not** need a duplicate `branch` edge in `edges` for the router to work (and any static fan-out from a router is ignored so it cannot race the decision).

```yaml
nodes:
  - id: route-by-result
    type: router
    with:
      mode: rules                    # rules | model
      input: "{{ state.testResults }}"
      routes:
        passed:  { when: "{{ state.testResults.failed == 0 }}", to: open-pr }
        failed:  { when: "{{ state.testResults.failed > 0 }}",  to: fix-loop }
        flaky:   { when: "{{ state.testResults.flaky }}",       to: rerun-tests }
        default: { default: true, to: needs-human }

edges:
  - { from: START, to: route-by-result }
  # No outgoing edge from route-by-result — destinations come from with.routes.
  - { from: open-pr, to: END }
  - { from: fix-loop, to: END }
  - { from: rerun-tests, to: END }
  - { from: needs-human, to: END }
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
      default:   { default: true, to: fallback }
```

- A router may target **multiple** routes (fan-out) by returning more than one match (configurable: `firstMatch` vs `allMatches`).
- Model-based routers are constrained to emit one of the declared route keys (enforced via structured output), so routing is always valid.
- Routers are `routing: true` capability; they return a `Command{ goto }` rather than a state update.
- In the desktop builder, dragging from a router node adds a route (not a parallel edge), and the canvas draws dashed edges from `with.routes`.

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

### `webhook` — outbound HTTP notification

```yaml
- id: notify-slack
  type: webhook
  with:
    url: "https://hooks.example.com/notify"
    method: POST
    body: { event: "started", runId: "{{ run.runId }}" }
    output: { to: notifyResult }
```

Outbound only — POSTs to a configured URL (idempotent via `ctx.once`). For **inbound** waits (pause until an external system POSTs a payload), use `wait` with `webhook: true` (see §9).

---

## 5. `shell` — run a local command

The primary escape hatch for custom logic: run any CLI, script, or shell pipeline without registering TypeScript. Prefer this over `function` for new graphs.

**Two modes:**

| Config | How it runs | Use when |
|---|---|---|
| `args` set | `execFile(command, args)` — no shell, argv-safe | You have a discrete binary + arguments |
| `args` omitted | OS shell (`/bin/sh -c` / `cmd.exe`) | You need pipes, `&&`, globs, or shell builtins |

```yaml
# Safe argv mode (recommended)
- id: greet
  type: shell
  with:
    command: echo
    args: ["Hello, {{ input.name }}!"]
    output: { to: message }

# Shell-string mode (pipes / chaining)
- id: build
  type: shell
  with:
    command: "npm run build && npm test"
    cwd: "{{ state.repoDir }}"
    timeout: 5m
    env: { CI: "1" }
    expect: { exitCode: [0] }
    output:
      map:
        log: "{{ result.stdout }}"
```

**Result shape** written via `output`:

```ts
{ stdout: string; stderr: string; exitCode: number; json?: unknown }
```

`json` is set when `stdout` parses as JSON.

**Input:** optional `with.input` is rendered, JSON-stringified into the `FLOWGRAPH_INPUT` env var, and also written to the child's stdin — same convention as skill `kind_of: command` handlers.

**Defaults:** timeout `30s`, `maxBuffer` 10MB, allowed exit codes `[0]`. Non-matching exit codes fail the node (include the code in `expect.exitCode` to allow it).

Declare toolchains with `requires` so missing binaries are caught at preflight and (optionally) skipped instead of failing the run:

```yaml
- id: verify
  type: shell
  with:
    command: go
    args: [test, ./...]
    requires: [{ bin: go, version: ">=1.22" }]
    onMissingTool: skip     # fail (default) | skip
```

`onMissingTool: skip` returns `{ ok: false, skipped: true }` and records a `TOOL_NOT_FOUND` run issue so later agents can see that verification never ran. Even in `fail` mode, a missing binary (ENOENT / exit 127) is reported as `TOOL_NOT_FOUND` rather than a raw spawn error.

**Injection caveat:** shell-string mode interpolates templates into the command line. Treat untrusted state values the same way you would for `http` URL/body templates — prefer argv mode (`args`) when values come from external input.

**Load-time `${ENV}` gotcha:** do **not** write braced `${MY_VAR}` / `${MY_VAR:-default}` inside `command`, `args`, or `env` values when `MY_VAR` comes from this node's own `with.env`. Graph load rewrites those against the host process environment *before* the node runs (often to empty), so a script that does `BRANCH="plan/${SLUG}"` becomes `BRANCH="plan/"` even when `env.SLUG` is set correctly. Use unbraced `$MY_VAR` instead:

```yaml
- id: materialize
  type: shell
  with:
    env:
      SLUG: "{{ state.specsDraft.slug }}"
    # GOOD — $SLUG expands when the shell runs
    command: |
      BRANCH="plan/$SLUG"
      git worktree add -b "$BRANCH" ".worktrees/$SLUG"
    # BAD — ${SLUG} is stripped at graph-load time → BRANCH="plan/"
    # command: |
    #   BRANCH="plan/${SLUG}"
```

See [05 — State & Data §Two interpolation phases](./05-state-and-data.md#5-two-interpolation-phases-dont-confuse-them).

---

## 5a. `service` — long-running background process

Start (and later stop) a long-running local process that **persists across multiple graph nodes** within a run — e.g. a Vite frontend, API server, or local database. Unlike `shell` (which blocks until the command exits), `service` returns once the process is spawned and (optionally) ready, so downstream nodes can use it.

```yaml
nodes:
  - id: start-vite
    type: service
    with:
      name: vite                    # stable id within the run/thread
      command: npx
      args: ["vite", "--port", "5173"]
      cwd: "{{ state.appDir }}"
      ready: { port: 5173 }         # or { url: "http://127.0.0.1:5173/" } or { log: "ready" }
      readyTimeout: 30s
      # keepAlive: true             # skip auto-stop at run end for this service

  - id: prove-ui
    type: demo
    with:
      screenshot:
        url: "http://localhost:{{ state.outputs.start-vite.port }}/"

  - id: stop-vite                   # optional explicit stop mid-graph
    type: service
    with:
      name: vite
      action: stop                  # start | stop | restart | status (default: start)

runtime:
  services:
    terminateOnEnd: true            # default — stop non-keepAlive services on completed/error
```

### Lifecycle

| Event | Behavior |
|---|---|
| `action: start` | Spawn the process. Same `(threadId, name)` already running → **no-op** (idempotent). |
| `action: stop` / `restart` / `status` | Operate on the named service for this thread. |
| HITL interrupt / pause | Services **keep running** (so an approver can still hit the UI). |
| Run `completed` or `error` | Auto-stop every non-`keepAlive` service when `runtime.services.terminateOnEnd` is true (default). |
| Host process exit (Ctrl-C) | Best-effort `SIGKILL` of still-tracked children. |

Services are **process-scoped** (like the embedded webhook server): a process restart loses the registry. Prefer an explicit `action: stop` (or rely on auto-cleanup) rather than assuming durability across host restarts.

### Readiness (`with.ready`)

Exactly one of:

| Probe | Ready when |
|---|---|
| `{ port: N }` | TCP connect to `127.0.0.1:N` succeeds |
| `{ url: "…", status?: [200] }` | GET returns an allowed status (default `[200,201,202,204]`) |
| `{ log: "regex" }` | Combined stdout+stderr matches the regex |

Defaults: `readyTimeout` `30s`, `readyInterval` `300ms`. Failure kills the child and fails the node.

### Result shape

```ts
{
  name: string;
  action: "start" | "stop" | "restart" | "status";
  status: "running" | "stopped" | "not_found";
  keepAlive: boolean;
  pid?: number;
  port?: number;
  url?: string;
  startedAt?: string;
  stoppedAt?: string;
  exitCode?: number | null;
}
```

**vs `shell`:** use `shell` for commands that finish; use `service` when the process must stay up for later nodes (and be cleaned up at run end).

---

## 5a2. `port` — allocate a free TCP port at runtime

Avoid hardcoding ports that may already be in use. The node probes the OS for free TCP port(s), returns them into state, then releases the probe listeners so a downstream `service` (or anything else) can bind.

```yaml
- id: alloc-ports
  type: port
  with:
    count: 2
    preferred: [5173, 4000]   # try these first; fall back to OS-assigned if taken
    # host: "127.0.0.1"       # default
    output: { to: ports }

- id: start-vite
  type: service
  with:
    name: vite
    command: npx
    args: ["vite", "--port", "{{ state.ports.ports[0] }}"]
    ready: { port: "{{ state.ports.ports[0] }}" }   # string templates are coerced to numbers
```

### Result shape

```ts
{ port: number; ports: number[]; host: string }   // `port` === ports[0]
```

**Caveat (TOCTOU):** this is probe-and-release. Between the node returning and the real process binding, another process could theoretically grab the port. In practice this is rare on a dedicated run machine; prefer `preferred` when you care about a specific port and accept the fallback when it is taken.

---

## 5b. `function` — registered TypeScript (legacy)

Legacy escape hatch for programmatic embedders — prefer [`shell`](#5-shell--run-a-local-command) for new graphs; see [14 — Programmatic API](./14-programmatic-api.md). References a **registered** TS function by name (not embedded source — keeps YAML safe and analyzable, per [Vision §Design principles](./00-vision.md#6-design-principles)).

```yaml
- id: dedupe-findings
  type: function
  with:
    fn: "dedupeFindings"          # resolved from the registered function table
    input: { findings: "{{ state.findings }}" }
    output: { to: findings }
```

```ts
// registered at compile time
import { registerFunction } from "@flowgraph/core";

registerFunction("dedupeFindings", (input, ctx) => {
  const seen = new Set<string>();
  return { findings: input.findings.filter(f => !seen.has(f.id) && seen.add(f.id)) };
});
```

For substantial reusable logic, prefer a **skill** (portable, contract + env declared) over a `function` node.

---

## 5c. `script` — sandboxed inline Node.js

Run inline Node.js (ESM) source without registering TypeScript or dropping into a shell. Prefer this over `shell` when the logic is pure JS data transformation / Node-builtin I/O and you want a real editor (Monaco) + sandbox rather than a shell string.

The script **must** `export default` an async (or sync) function:

```js
export default async function (input, ctx) {
  // input  — rendered with.input object
  // ctx    — { nodeId, runId, threadId }
  return { greeting: `Hello, ${input.name}!` };
}
```

```yaml
- id: greet
  type: script
  with:
    code: |
      export default async function (input) {
        return { greeting: `Hello, ${input.name}!` };
      }
    input:
      name: "{{ state.name }}"
    timeout: 30s
    # Optional: widen the sandbox (denied by default)
    # permissions:
    #   fsRead: ["/path/to/data"]
    #   fsWrite: ["/path/to/out"]
    #   childProcess: false
    #   workerThreads: false
    # env:
    #   MARK: "1"                 # opt-in; host process.env is NOT inherited
    output: { to: greet }
```

### How it runs

1. The engine writes your `code` to a temp `script.mjs` plus a thin `entry.mjs` wrapper.
2. It spawns `node --permission … entry.mjs` in that temp directory (no `node_modules` on the resolution path).
3. The wrapper calls your default export with the rendered `input` and writes the JSON-serialized return value to a result file, which is mapped via `output`.

**Defaults:** timeout `30s`, stdout/stderr capped at 10MB. Non-zero exit, timeout, or a missing/invalid result file fail the node (stderr excerpt included).

### Sandbox (Node permission model)

| Capability | Default | Opt-in |
|---|---|---|
| Read/write the temp sandbox dir | Allowed (needed to load the script + write the result) | — |
| `fs` read outside sandbox | Denied | `permissions.fsRead: [paths]` |
| `fs` write outside sandbox | Denied | `permissions.fsWrite: [paths]` |
| `child_process` | Denied | `permissions.childProcess: true` |
| `worker_threads` | Denied | `permissions.workerThreads: true` |
| Third-party npm packages | Unreachable (no `node_modules`) | Not supported |
| `node:*` builtins | Available (subject to the rows above) | — |

Directory grants should end with `/` (or omit the trailing slash — the engine normalizes directories). Host `process.env` is **not** inherited; pass values explicitly via `with.env` (including secrets via `{{ secret.X }}` templates).

**Network caveat:** Node's permission model has **no** `--allow-net` flag. Scripts can open sockets / `fetch` unless the host environment (container network policy, OS firewall) blocks them. Treat network restriction as a deploy-time concern, same class of trust as `shell`.

**vs `shell` / `function`:** use `script` for self-contained JS with a sandbox and a real editor; use `shell` for CLIs, pipes, and language-agnostic tools; use `function` only when embedding a pre-registered TypeScript handler in a programmatic host.

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

Provide **exactly one** of:

- `uses:` — path or `imports[].subgraph` alias (resolved from the graph's working directory at run time)
- `spec:` — an inline child `GraphSpec` (produced by `bundleGraphForRemote` for remote portability; the engine compiles it via `compileGraphForEmbedding` without reading the filesystem)

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

Each mode sets an interrupt **kind** (`approval`, `question`, `choice`, `form`, `review`) so the CLI and external GUIs know how to prompt and parse the resume value.

**Invalid answers re-prompt.** If a resume value fails validation (unknown choice, unknown review decision, or a `form`/`review` answer that fails `with.schema`), the node re-issues its interrupt with `validationError`, `attempt` and `maxAttempts` attached instead of failing. After `with.maxResumeAttempts` rejected answers (default `3`) the run reports `status: "error"` (`ResumeAttemptsExhaustedError`) but the interrupt stays pending, so the thread can still be inspected and resumed with a valid answer. See [07 — Invalid answers](./07-runtime-and-execution.md#invalid-answers-re-prompt-dont-brick).

```yaml
- id: intake
  type: hitl
  with:
    mode: form
    message: "Describe the request"
    schema: { type: object, required: [title], properties: { title: { type: string } } }
    maxResumeAttempts: 5            # default 3
    output: { to: intake }
```

### `ask_human` tool (agent nodes)

Agents can ask clarifying questions mid-loop by opting into the built-in tool:

```yaml
- id: planner
  type: agent
  with:
    prompt: "{{ state.task }}"
    tools:
      - function: ask_human
```

The tool raises a `question` or `choice` interrupt; the answer is returned to the agent as `{ answer: "..." }`.

### Service tools (agent nodes)

Agents can discover **and** start/stop background services in the current run/thread. Services started via tools share the same process-scoped registry as the `service` node — idempotent by name, survive HITL pauses, and auto-stop on run `completed`/`error` unless `keepAlive` or `runtime.services.terminateOnEnd: false`.

```yaml
- id: planner
  type: agent
  with:
    prompt: "Spin up a local preview if needed, then continue."
    tools:
      - function: list_services
      - function: service_status
      - function: start_service
      - function: stop_service
      # - function: restart_service
```

| Tool | Args | Returns |
|---|---|---|
| `list_services` | (none) | `{ services: ServiceInfo[], count: number }` for this thread |
| `service_status` | `{ name }` | One `ServiceInfo` (`status` is `running` \| `stopped` \| `not_found`) |
| `start_service` | `{ name, command, args?, cwd?, env?, ready?, readyTimeout?, readyInterval?, stopSignal?, stopTimeout?, keepAlive? }` | `ServiceInfo` for the started (or already-running) service |
| `stop_service` | `{ name }` | `ServiceInfo` (`stopped` or `not_found`) |
| `restart_service` | same as `start_service` | `ServiceInfo` after stop+start |

**Governance:** spawning arbitrary commands via `start_service` is the same trust boundary as the `shell` / `service` nodes. Gate it with `permission: ask` or a `runtime.hooks` entry on `agent:beforeToolCall` (e.g. `where: { tool: start_service }`, `do: interrupt`) — see [08 — Providers](./08-providers.md).

---

## 8a. `workshop` — facilitated agenda session

A specialized HITL node for a **bounded conversation** that produces a structured deliverable. Unlike `hitl` (one question, one resume), `workshop` raises a single interrupt whose payload is a **session contract**: agenda, output schema, primed context, facilitator prompt, and optional voice hints. The client (CLI, desktop, or a phone web app) facilitates the conversation and resumes once with:

```ts
{ output, transcript, coverage, endedReason }
```

`output` is validated against `with.schema` before the node completes. An invalid output re-issues the workshop interrupt with `validationError` / `attempt` / `maxAttempts` so the client can show the error and try again; after `with.maxResumeAttempts` rejections (default `3`) the run fails with `ResumeAttemptsExhaustedError` while the interrupt stays pending and resumable (see [07](./07-runtime-and-execution.md#invalid-answers-re-prompt-dont-brick)). Voice, text chat, and a plain JSON form are all valid facilitators of the same contract — that is what keeps CI honest.

```yaml
- id: feature-workshop
  type: workshop
  with:
    message: "Workshop {{ state.packet.title }}"
    agenda:
      - scope
      - risks
      - { id: gtm, title: "Go-to-market", description: "Who ships this and when?" }
    schema:
      type: object
      properties:
        title: { type: string }
        acceptance: { type: array, items: { type: string } }
      required: [title]
    context: "{{ state.packet }}"
    facilitator: "Cover every agenda item. Do not invent requirements."
    voice:
      provider: xai
      model: grok-voice-latest
      voice: eve
    fallback: form                 # form | text | json
    limits: { maxMinutes: 30 }
    maxResumeAttempts: 3           # invalid outputs re-prompt this many times (default 3)
    output: { to: brief }
```

The interrupt payload (`payload.data`) is typed as `WorkshopContract` in `@flowgraph/spec` (re-exported by `@flowgraph/workshop-session`): `mode`, `agenda`, `fallback`, optional `schema` / `context` / `facilitator` / `voice` / `limits`, `artifactRefs` (rendered `with.artifacts`), and `diff` / `diffStat`. A git diff failure is reported on `diff.error` (no `diffStat`); patches over 256 KiB are cut and marked `diff.truncated: true`.

`limits` are enforced by the client, not the engine (the node is a single interrupt): `WorkshopSession` closes the session and fires `onTimeLimit` after `limits.maxMinutes` (default 30). `maxTurns` is advisory. The facilitator tools are `update_draft`, `cover_agenda_item`, `add_risk`, and `finish`; `read_artifact` is only advertised when the client opts in with `READ_ARTIFACT_TOOL` and serves it in `onToolCall`.

The node is **interrupt-and-map only** — no side effects. Research belongs in a prior `prepare` agent node; writing plans/tickets belongs in a later `post` node. Headless: `--on-interrupt fail` then `flowgraph resume` with the output JSON, or paste the output object at the CLI prompt.

`voice` is a hint for the client. When a client asks `@flowgraph/server` for a voice token (`POST /voice/client-secrets`), the server only mints for models in its allowlist (`FLOWGRAPH_VOICE_ALLOWED_MODELS`, default each provider's default model) and refuses while REST auth is off unless `FLOWGRAPH_VOICE_ALLOW_UNAUTHENTICATED=1` is set. See the [server README](../packages/server/README.md#voice-tokens-post-voiceclient-secrets).

Prefer cheap `hitl` `approve` / `review` when a single decision is enough. Use `workshop` when the human and facilitator need to think together against an agenda.

---

## 9. `wait` / `delay` — time & external gates

```yaml
- id: cool-down
  type: wait
  with:
    duration: 30s                   # fixed delay (in-process sleep)
    # or: until: "{{ state.ready }}"  (durable interrupt until condition is true on resume)
    # or: signal: deploy-finished    (durable interrupt until resumed with that signal)
    # or: webhook: true              (durable interrupt; embedded HTTP listener resumes)
    # optional on until/signal/webhook:
    timeout: 24h                    # informational deadline (see below)
```

Inbound webhook example:

```yaml
- id: await-approval
  type: wait
  with:
    webhook: true
    # or: webhook: { schema: { type: object, required: [approved], properties: { approved: { type: boolean } } } }
    timeout: 24h
    output: { to: approval }
```

When a `webhook` wait interrupts, the runtime starts (or reuses) an embedded HTTP server and attaches a generated URL on the interrupt payload as `data.webhookUrl` (e.g. `http://127.0.0.1:8878/webhooks/<threadId>/<nodeId>`). `POST` JSON to that URL to resume; `GET` returns `{ waiting: true }`. Configure host/port via `runtime.webhookServer` (default `127.0.0.1:8878`; on `EADDRINUSE` falls back to an ephemeral port). **No auth in v1** — local / trusted-network only. Routes are in-memory and one-shot; a process restart loses pending registrations until the node is hit again.

### Modes

| Mode | Behavior | Survives process restart? |
|---|---|---|
| `duration` | In-process sleep for the given duration | No — same as any in-flight node |
| `until` | Interrupt if the guard is false; re-evaluate on resume | Yes (checkpointed interrupt) |
| `signal` | Interrupt until resumed with a payload for the named signal | Yes (checkpointed interrupt) |
| `webhook` | Interrupt until inbound HTTP POST resumes (schema-validated) | Interrupt yes; listening URL requires the owning process |

### Observability

- **`duration`:** emits a `node.output` event before sleeping: `{ wait: { mode: "duration", durationMs, wakeAt } }`. Use `wakeAt` (ISO timestamp) in CLIs/TUIs to show when the run will continue.
- **`until` / `signal` / `webhook`:** optional `timeout` is included in the interrupt `data` payload (visible via `flowgraph resume --list --json`) so operators can see the intended deadline.
- **`webhook`:** interrupt `data` also includes `mode: "webhook"` and `webhookUrl`.

### `timeout` (informational only)

`timeout` on `until`/`signal`/`webhook` sets `deadlineAt` on the interrupt. It is enforced two ways, both best-effort and in-process: (1) when a run returns `interrupted` under `onInterrupt: fail` or `webhook`, the compiled graph arms a timer that resumes the thread with `{ timedOut: true }` at the deadline (pass `onWaitTimeout(result)` to `compileGraph` to receive that background run's result; failures are also emitted as `run.error`); (2) any later resume after the deadline receives `{ timedOut: true }`. Timers do not survive a process restart, so a durable cross-restart deadline still needs an external scheduler (same class of feature as cron-driven resume).

`wait` for external signals/conditions/webhooks uses interrupt/resume so the pause survives restarts (the HTTP listener itself does not).

---

## 9b. `demo` — best-effort artifact capture

Capture a small artifact that demonstrates what a pipeline produced — an API request/response transcript, a web screenshot, a short page-load video, a mobile-simulator recording, or an attached file/document. Modes are **explicit** (no auto-detection of "is this a web app"). Interactive flows (login, click-through) still belong in a prior `shell`/`script` node (or Playwright MCP), with `demo` attaching the resulting file via `file` mode. Simulator screenshot/video capture **is** in-scope.

**Exactly one** of `http`, `screenshot`, `file`, `video`, or `simulator` must be set.

```yaml
# API request/response transcript
- id: prove-api
  type: demo
  with:
    label: "health check"
    http:
      method: GET
      url: "http://localhost:{{ state.port }}/health"
      headers:
        Authorization: "Bearer {{ secret.API_TOKEN }}"
    # output omitted → state.outputs.prove-api

# Web screenshot (requires optional peer `playwright`)
- id: prove-ui
  type: demo
  with:
    screenshot:
      url: "http://localhost:{{ state.port }}/"
      waitFor: "main"          # CSS selector, or a duration like "2s"
      video: false             # optional short page-load recording
      viewport: { width: 1280, height: 720 }

# Attach a file produced earlier in the pipeline
- id: attach-report
  type: demo
  with:
    file:
      path: "{{ state.outputs.build.reportPath }}"

# Web video (requires optional peer `playwright`)
- id: prove-ui-video
  type: demo
  with:
    video:
      url: "http://localhost:{{ state.port }}/"
      duration: 5s
      waitFor: "main"
      scroll: true

# iOS Simulator recording (requires Xcode `xcrun simctl`)
- id: prove-mobile
  type: demo
  with:
    simulator:
      platform: ios
      device: "iPhone 15"
      app: com.example.app
      capture: video
      duration: 15s
```

### Modes

| Mode | What it does | Extra deps |
|---|---|---|
| `http` | Re-issues the request; writes a JSON transcript (redacted headers) under `.flowgraph/demo/<nodeId>/` | none |
| `screenshot` | Headless Chromium via Playwright; PNG screenshot (+ tracked `.webm` extra when `video: true`) | optional peer `playwright` (+ `npx playwright install chromium`) |
| `video` | Headless Chromium page recording; `.webm` is the primary artifact | optional peer `playwright` |
| `simulator` | iOS (`xcrun simctl`) or Android (`adb`) screenshot / `recordVideo` / `screenrecord` | Xcode CLT or Android SDK platform-tools |
| `file` | Copies an existing path into the demo artifact dir | none |

### Best effort vs `strict`

By default, capture failures (Playwright missing, DNS error, source file not found, …) **do not fail the run**. The node returns `{ ok: false, kind, reason, capturedAt }` and logs a warning so the rest of the pipeline can continue. Set `with.strict: true` to throw on those same failures when the artifact is required.

### Result shape

```ts
{
  ok: boolean;
  kind: "http" | "screenshot" | "file" | "video" | "simulator";
  path?: string;         // artifact file path when ok
  mimeType?: string;
  sizeBytes?: number;
  reason?: string;       // when ok: false
  capturedAt: string;
  label?: string;
  extra?: Array<{ path, mimeType, kind, sizeBytes? }>; // e.g. screenshot + video
  // http mode also includes request/response summaries (headers redacted)
}
```

Artifacts are **files on disk** (paths in state), not inline binary data. See [05 — State & Data](./05-state-and-data.md).

### Artifact manifest (run-scoped tracking)

Every `demo` capture (success or best-effort failure) appends one JSON line to:

```
<workspace>/.flowgraph/demo/runs/<threadId|runId>/manifest.jsonl
```

The key prefers `threadId` so captures before and after a HITL pause land in the same file. This fires whether `demo` runs as a normal graph step or as an agent tool call (tool results do not write graph state, but the disk side effect + manifest entry still persist). Desktop uses this manifest for the run-summary report and the Run History artifact list.

### Exposing `demo` as an agent tool

To let an LLM decide **how many** artifacts to capture and of **what kind**, author several single-purpose `demo` instances that template their variable fields from `{{ input.* }}`, then expose them as tools on an `agent` node. Use top-level `description` and `toolInput` (JSON Schema) so the model knows what arguments each tool accepts:

```yaml
nodes:
  - id: screenshot-tool
    type: demo
    description: "Capture a screenshot of a web page URL"
    toolInput:
      type: object
      properties:
        url: { type: string, description: "Page URL to open" }
        label: { type: string, description: "Short artifact label" }
        waitFor: { type: string, description: "CSS selector or duration (e.g. main, 2s)" }
      required: [url]
    with:
      label: "{{ input.label }}"
      screenshot:
        url: "{{ input.url }}"
        waitFor: "{{ input.waitFor }}"

  - id: http-transcript-tool
    type: demo
    description: "Hit an HTTP endpoint and save a request/response transcript"
    toolInput:
      type: object
      properties:
        url: { type: string }
        method: { type: string, enum: [GET, POST, PUT, PATCH, DELETE] }
        label: { type: string }
      required: [url]
    with:
      label: "{{ input.label }}"
      http:
        method: "{{ input.method }}"
        url: "{{ input.url }}"

  - id: demo-director
    type: agent
    with:
      prompt: >
        Capture 1–4 demo artifacts for the app at {{ state.baseUrl }}.
        Prefer screenshots of key screens and an API health transcript when useful.
      tools:
        - node: screenshot-tool
        - node: http-transcript-tool
```

The agent may call each tool zero or more times with different arguments. Each call runs the `demo` node with those args as `input`; files land under `.flowgraph/demo/<nodeId>/` and are tracked in the run manifest. Tool return values stay intra-agent (they do not overwrite `state.outputs.<nodeId>`).

### Compose for anything harder

Need to log in, click through a flow, or drive a custom mobile script? Do that in a `shell`/`script` node (or Playwright MCP), then attach the resulting file with `demo` `file` mode. Simulator screenshot/video capture is in-scope for `demo`; arbitrary interactive flows are not.

---

## 9c. `worktree` — isolated git worktrees

Creates, removes, or lists `git worktree`s so parallel branches (e.g. a `map` of agents) each get their own checkout.

```yaml
- id: isolate
  type: worktree
  with:
    action: add                # add (default) | remove | status
    branch: "farm/{{ state.item.id }}"
    path: ".worktrees/{{ state.item.id }}"   # relative to runtime.workspace
    # repo: ../other-repo      # git repo root; default runtime.workspace
    # reset: false             # add only: allow resetting an EXISTING branch to HEAD
    output: { to: worktree }   # { path, branch, head, action }
```

Safety rules (enforced at run time; violations fail the node with a clear error):

- **Branch names** must pass `git check-ref-format --branch` unchanged; names starting with `-`, containing whitespace, or using `@{…}` are rejected.
- **Paths** must resolve strictly inside the worktree root (`runtime.worktrees.root`, absolute or workspace-relative; default `runtime.workspace`), also after resolving symlinks. Values starting with `-` are rejected, and paths are passed to git after `--`.
- **Existing branches are never moved silently.** `add` uses `git worktree add -b`; if the branch already exists the node fails unless `reset: true` is set (then `-B`, which resets the branch to HEAD).
- **`remove`** uses `--force` only for a worktree this thread's own `worktree` nodes created (tracked in the reserved `__worktrees` channel). Any other worktree is removed without `--force`, so git refuses if it has uncommitted changes.

`runtime.worktrees.cleanupOnEnd: true` force-removes the thread's own worktrees when the graph completes (not on a HITL pause).

```yaml
runtime:
  worktrees:
    root: .worktrees        # optional
    cleanupOnEnd: true
```

---

## 9. Built-in node summary

| `type` | Purpose | Capabilities | Package |
|---|---|---|---|
| `agent` | Agent loop w/ tools (hub & spoke) | streaming, interruptible, side-effecting | core (+ provider pkg) |
| `skill` | Run a declared skill | varies by skill | core (+ `@flowgraph/skills`) |
| `router` | Choose next node(s) | routing | core |
| `http` | Outbound HTTP | side-effecting | core |
| `demo` | Best-effort artifact capture (HTTP / screenshot / video / simulator / file) | side-effecting | core (+ optional `playwright`; simulators need Xcode/adb) |
| `mcp` | MCP tool/resource call | side-effecting | core (+ `@flowgraph/mcp` at runtime) |
| `webhook` | Outbound HTTP notify | side-effecting | core |
| `shell` | Run a local command / shell string | side-effecting | core |
| `service` | Start/stop long-running background processes | side-effecting | core |
| `port` | Allocate free TCP port(s) at run time | — | core |
| `script` | Sandboxed inline Node.js (ESM) | side-effecting | core |
| `function` | Registered TS function (legacy) | varies | core |
| `subgraph` | Nested / embed a child graph | composite | core |
| `map` | Fan-out over a collection | composite, parallel | core |
| `hitl` | Human approve / question / choice gate | interruptible | core |
| `wait` | Delay / condition / signal / inbound webhook gate | interruptible | core |
| `workshop` | Facilitated agenda session (human answers per item) | interruptible | core |
| `worktree` | Add / remove / list isolated git worktrees | side-effecting | core |

---

## 10. Custom node types (plugins)

Third parties extend the registry by publishing a node plugin package and importing it (`imports[].nodes`). A plugin exports `NodeFactory`s:

```ts
// @acme/flowgraph-nodes-aws
import { defineNode } from "@flowgraph/core";
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
