# 02 — Graph Specification (YAML)

This is the heart of the low-code layer: the declarative document that describes a graph. It is validated by a Zod schema in `@flowgraph/spec`, from which a JSON Schema is generated for editor autocomplete/validation.

> **Status:** target design. The schema below is the contract we are building toward; specifics (field names) are stable enough to author against and may receive additive, backward-compatible changes pre-1.0.

## 1. Document shape

A graph file is a single YAML document:

```yaml
apiVersion: flowgraph/v1        # required — versioned contract
kind: Graph                 # required — only Graph is accepted
metadata: { ... }           # name, labels, description
triggers: [ ... ]           # optional — host-interpreted auto-start conditions
imports: [ ... ]            # optional — reusable subgraphs/skills/node packages
config: { ... }             # optional — graph-level config/defaults
secrets: [ ... ]            # optional — host environment variables the graph may read
state: { ... }              # optional — channel (state) definitions
inputs: [ ... ]             # optional — typed run parameters (collected before start)
input: { ... }              # optional — default seed values for a run
nodes: [ ... ]              # required — the node list
edges: [ ... ]              # required — static + conditional edges
runtime: { ... }            # optional — checkpoint/retry/hook defaults
```

`apiVersion` pins the schema contract. The loader rejects unknown major versions and warns on unknown minor fields (forward-compatible).

## 2. `metadata`

```yaml
metadata:
  name: triage-issue              # required; kebab-case; unique within a project
  description: "Triage inbound GitHub issues into Jira."
  version: 0.1.0                  # optional; semver of this graph
  labels:                         # optional; free-form for filtering/observability
    team: platform
    domain: github
```

`metadata.name` becomes the root OTel span name.

## 2a. `triggers` (auto-start conditions)

Optional list of **host-interpreted** conditions that should start a run of this graph. The engine validates and round-trips the field but does **not** schedule or listen for these itself — Flowgraph Desktop interprets them. The CLI, the server, and `compiled.run()` emit a `TRIGGERS_HOST_UNSUPPORTED` warning and ignore them. Missed schedules while a host is offline are not replayed (Flowgraph is not a durable DAG/ETL scheduler).

```yaml
triggers:
  - id: nightly
    type: cron
    schedule: "0 2 * * *"          # minute hour day-of-month month day-of-week
    timezone: America/Denver       # optional IANA tz
  - id: poll
    type: interval
    every: 15
    unit: minutes                  # seconds | minutes | hours
  - id: boot
    type: startup                  # when the host app starts
  - id: after-ingest
    type: flow-complete
    graph: ingest-pipeline         # other graph's metadata.name
  - id: on-ingest-fail
    type: flow-failed
    graph: ingest-pipeline
  - id: hook
    type: webhook
    path: /hooks/trig-graph        # optional; hosts may derive from metadata.name
  - id: watch-inbox
    type: file-watch
    path: ./inbox
    events: [create, change]       # optional; create | change | delete
```

| Field | Description |
|-------|-------------|
| `id` | Stable id within this graph. Required. |
| `type` | `cron` \| `interval` \| `startup` \| `flow-complete` \| `flow-failed` \| `webhook` \| `file-watch`. |
| `enabled` | When `false`, hosts ignore the trigger. Default `true`. |
| `schedule` | Cron only — 5-field cron expression. |
| `timezone` | Cron only — optional IANA timezone. |
| `every` / `unit` | Interval only. |
| `graph` | Flow-complete / flow-failed — target graph `metadata.name` (kebab-case). |
| `path` | Webhook (URL path) or file-watch (filesystem path). |
| `events` | File-watch only — subset of `create` / `change` / `delete`. |

Hosts typically guard against a graph triggering itself via `flow-complete` / `flow-failed`. Cascade depth beyond that simple self-loop check is host-defined.

## 2b. `inputs` (run parameters)

Declare typed parameters that must be supplied **before** a run starts. These are distinct from mid-run `hitl` interrupts: they do not create a checkpoint, do not pause a thread, and work for headless/CLI/webhook triggers.

```yaml
inputs:
  - key: prospectName
    label: Prospect Name
    type: string          # string | text | number | boolean | select
    required: true
  - key: prospectDescription
    label: Description
    type: text
    description: "What the prospect does / why they matter"
  - key: jiraTicketId
    label: Jira Ticket ID
    type: string
    required: true
  - key: priority
    type: select
    options: [low, medium, high]
    default: medium
```

| Field | Description |
|-------|-------------|
| `key` | Written into the initial run input / state under this name. Required. |
| `label` | Human-readable name for forms and CLI errors. |
| `type` | `string` (single-line), `text` (multi-line), `number`, `boolean`, or `select`. Default: `string`. |
| `required` | When `true`, the run fails fast if the value is missing and no `default` is set. |
| `default` | Applied when the caller omits the key. |
| `options` | Required for `type: select` — allowed string values. |
| `description` | Optional help text for UIs. |

**Runtime behavior:**

- CLI: `flowgraph run … --input prospectName=Acme --input jiraTicketId=PROJ-1`. Missing required keys exit `1` with a list of issues (no interactive prompt).
- Programmatic / desktop: values are passed as `run({ input: { … } })` and validated against `inputs` inside `compiled.run()`, `compiled.stream()` and `compiled.prepare({ mode: "start" })`. A missing required key or a value of the wrong type rejects with `InputValidationError` (code `INPUT_INVALID`) before anything runs.
- Every entry point resolves input the same way (`resolveGraphInput(spec, provided)`): the graph's `input:` seed values, overlaid by the caller's values, then `inputs` defaults, coercion and required checks. The CLI and the server use the same function.
- Graphs without an `inputs` array keep the previous free-form `input:` / `--input` behavior (no validation); the graph's `input:` values are still merged under the caller's.

Do **not** use a leading `hitl` node for call parameters — reserve HITL for mid-run approvals and clarifying questions that depend on something computed during execution.

## 3. `imports`

Imports make graphs composable and skills/nodes reusable. Each import is resolved at compile time.

```yaml
imports:
  - skill: "@acme/skills/post-to-slack"     # a published or local skill (by package or path)
    as: notify
  - agent: "./agents/code-reviewer"         # reusable AGENT.md system prompt
    as: reviewer
  - subgraph: "./subgraphs/run-tests.graph.yaml"
    as: tests
  - nodes: "@acme/flowgraph-nodes-aws"          # a node plugin package registering custom types
  - reducers: "./reducers/unique-by-id.ts"     # registers custom state reducers (custom:<name>)
```

- `skill:` — import a skill so nodes can reference it as `uses: notify`.
- `agent:` — import an agent definition so agent nodes can reference it as `with.agent: reviewer`. See [16 — Agents](./16-agents.md).
- `subgraph:` — import another graph to embed via a `subgraph` node.
- `nodes:` — load a plugin package that registers custom node `type`s into the registry.
- `reducers:` — load a module that registers custom state reducers (`custom:<name>`). The module may call `registry.registerReducer` on load, or `export default` a record of `{ [name]: (cur, inc) => next }` (or an array of `{ name, reducer }`).

`flowgraph validate` reads every import but does not load `nodes`, `providers` or `reducers` modules. Those modules load when the graph runs. A node type that is not already registered is an error (`UNKNOWN_NODE_TYPE`). Once the graph declares a `nodes` import, that same type — including a typo — is a warning, `PLUGIN_TYPE_UNRESOLVED`, because validate does not load the module and cannot tell a plugin type from a misspelling. A `custom:` reducer is an error unless the graph declares a `reducers` import, in which case it is a warning, `UNREGISTERED_REDUCER`. `flowgraph validate --strict` treats those warnings as errors.

Resolution order for path/package specifiers: relative path → workspace alias → node module. See [04 — Skills](./04-skills.md) for skill resolution details and [16 — Agents](./16-agents.md) for agent definitions.

## 4. `state`

State is the shared data the graph reads/writes — backed directly by LangGraph **channels**. See [05 — State & Data Flow](./05-state-and-data.md) for full semantics (reducers, defaults, typing).

```yaml
state:
  channels:
    issue:
      type: object               # string|number|boolean|object|array|messages|any
      description: "The inbound issue payload."
    summary:
      type: string
      default: ""
    findings:
      type: array
      reducer: append             # how concurrent/iterative writes merge
    messages:
      type: messages              # special channel using LangGraph's message reducer
```

If `state` is omitted, a default single `messages` channel is assumed (chat-style graph).

A `messages` channel appends messages and updates or deletes them by id. A `RemoveMessage` whose id is not in the channel does nothing — it used to throw — and the run emits a warning log. An id added earlier in the same write still counts, so `[m3, Remove(m3)]` removes `m3`. A repeated removal of an id that is already gone is ignored.

## 5. `nodes`

Each node has a stable `id`, a `type` (resolved via the registry), and type-specific config under `with`. Common fields apply to every node regardless of type.

```yaml
nodes:
  - id: summarize                 # required; unique; referenced by edges
    type: intelligent             # required; must resolve in the Node Registry
    name: "Summarize issue"       # optional; human label (UI/traces)
    description: "..."            # optional
    provider: claude              # type-specific top-level fields (see node docs)
    input:                        # optional; declarative input mapping (see §8)
      issue: "{{ state.issue }}"
    with:                         # type-specific config block (validated per type)
      prompt: "Summarize:\n{{ input.issue.body }}"
      output: { to: summary }
    retry: { maxAttempts: 3, backoff: exponential }   # optional; overrides runtime.retry
    timeout: 120s                 # optional; overrides runtime.timeoutDefault
    when: "{{ state.issue != null }}"                  # optional; guard (skip if false)
    on:                           # optional; per-node hook bindings (see docs/06)
      error: continue             # continue | fail | route:<nodeId>
```

Full per-type configuration is documented in [03 — Node Types](./03-node-types.md).

### `runsOn` (placement)

`runsOn` declares what a node needs from the machine that runs it. It is optional and valid on every node type except `hitl`, `workshop` and `wait`.

```yaml
nodes:
  - id: character
    type: subgraph
    uses: ./cc5-character.graph.yaml
    runsOn: [os:windows, app:cc5]        # shorthand: all of these labels
    with:
      stateMap:
        in:  { brief: characterBrief }
        out: { characterFbx: fbx }

  - id: upscale
    type: shell
    runsOn:
      labels: [gpu:nvidia]               # required, at least one
      target: render-01                  # optional: pin to one named target
      fallback: local                    # optional: error (default) | local
    with: { command: ./upscale.sh }
```

- A label is `namespace:value`, for example `os:windows`, `app:cc5`, `plugin:@acme/cc5-nodes`, `flowgraph:0.42`. The namespace starts with a lowercase letter; the value starts with a letter, digit or `@`.
- `labels` is all-of. The graph never names hosts or URLs; `target` is a name that the host's topology resolves.
- `runsOn` on `hitl`, `workshop` or `wait` is an error (`PLACEMENT_NOT_ALLOWED`): gates run on the coordinator, and a gate inside a placed subgraph is forwarded to it.
- A subgraph with `runsOn` may not contain a node with `runsOn`, inline or through `uses:` (`PLACEMENT_NESTED`).
- Only top-level nodes are placed. `runsOn` on a node inside an unplaced subgraph (inline, through `uses:`, or a `map` inner node) is an error (`PLACEMENT_NOT_TOP_LEVEL`): it would be ignored and the node run on the coordinator. Set `runsOn` on the top-level subgraph node instead.
- Two directly connected nodes with the same labels and `target` produce the warning `PLACEMENT_ADJACENT_HOPS`: each is its own round trip through the coordinator, so group them in a subgraph.

A node whose labels the local host satisfies runs in-process as usual. Otherwise the engine dispatches it to a matching worker from the host's topology, or fails before the run starts with `PLACEMENT_UNSATISFIED`. How placed nodes are resolved, named, reconnected and reported is in [07 — Runtime §6a](./07-runtime-and-execution.md#6a-node-placement); the design is [ADR-0020](./adr/0020-node-placement.md). `runsOn.wait` is rejected: queueing for a matching worker is not available. Gates inside a placed subgraph are not forwarded (`PLACEMENT_GATE_NOT_FORWARDED` warns), and artifacts are not staged.

## 6. `edges`

Edges define control flow. Two forms: **static** and **conditional**. `START` and `END` are reserved node ids (mapped to LangGraph's `START`/`END`).

### Static edges

```yaml
edges:
  - { from: START, to: summarize }
  - { from: summarize, to: classify }
```

### Conditional edges

Conditional edges branch based on an expression evaluated against state. Prefer these for forks off ordinary nodes (e.g. HITL approve/deny). For a dedicated router node, put the conditions in `with.routes` instead — the router returns `Command{ goto }` and does not need a matching `branch` edge.

```yaml
edges:
  - from: classify
    branch:
      # evaluated top-to-bottom; first match wins; `default` is the fallback
      - { when: "{{ state.label == 'bug' }}",     to: file-bug }
      - { when: "{{ state.label == 'feature' }}",  to: file-feature }
      - { default: true,                           to: needs-human }
```

A guard that evaluates to false moves on to the next entry, and the `default` entry (or `END` when there is none) is taken when nothing matches. A guard that cannot be evaluated at run time, for example one that calls an unknown function, fails the run with error code `EDGE_GUARD_ERROR`. The run does not fall through to `default` or `END`. The error names the edge and the expression, and the run records an `EDGE_GUARD_ERROR` issue (severity `error`, `detail: { from, to, when }`). A path that does not exist, such as `state.review.approved` before `review` is written, evaluates to null and does not raise this error. `flowgraph validate` reports expressions that do not parse (`EXPR_PARSE_ERROR`) before the run starts.

### Fan-out (parallel) edges

Listing multiple `to` targets (or multiple edges from the same node) fans out to parallel branches, which LangGraph executes concurrently and merges via channel reducers.

```yaml
edges:
  - { from: plan, to: [impl-a, impl-b, impl-c] }   # parallel fan-out
  - { from: impl-a, to: gather }
  - { from: impl-b, to: gather }
  - { from: impl-c, to: gather }                    # fan-in; reducers merge writes
```

Separate inbound edges fire the target once for each predecessor that finishes. When those predecessors are the same number of hops from `START`, they finish together and the target runs once. When the branches have different lengths, the target runs again for each later arrival.

A static `from` list is a barrier. The target runs once, after every listed source has finished:

```yaml
edges:
  - { from: START, to: split }
  - { from: split, to: short }          # 2 hops from START
  - { from: split, to: mid }
  - { from: mid, to: long }             # long is 3 hops from START
  - { from: [short, long], to: join }   # join runs once, after both
  - { from: join, to: END }
```

`from` must be a node id or a list of at least two distinct node ids. The same syntax is in [examples/join-barrier](../examples/join-barrier/uneven-join.graph.yaml). A barrier cannot target `END`, cannot list `END` or `START` as a source, and cannot list its own target in `from` (`BARRIER_SELF_SOURCE`): the join would wait for itself to finish. Every source must be reachable by static edges. A source that can only be reached through a conditional branch, a router, or a `hitl` node that declares `with.routes` is an error (`BARRIER_CONDITIONAL_SOURCE`): the join waits for every listed source, so a path that is skipped would leave it waiting. Edges out of those nodes are not static. The compiler follows the declared route and does not install their `to` edges.

A node listed in `from` cannot carry a recovery route (`BARRIER_RECOVERY_SOURCE`). That is `on.error: route:...` on the node, the same field on a `map` item, or a hook whose `do` is `route:...`. If that node failed, the barrier would still see it finish, and the join would run at the same time as the recovery route.

A recovery route on a node that is not itself a barrier source stays allowed. Its ordinary `to` edges still run when the node succeeds. If that node fails before a downstream barrier source is reached, the source never finishes, so the join does not run. The run still reports completed when the recovery route reaches the end of the graph.

Plain multi-inbound edges are unchanged. `flowgraph validate` warns (`UNEVEN_FAN_IN`) when a node has several plain inbound edges from parallel branches of uneven length and is not using a barrier. Exclusive routes are not parallel branches, so that warning does not apply to them.

A loop that runs only some of the listed sources again does not release the barrier a second time. The join runs again only after every listed source has finished again.

> `flowgraph validate` checks schema errors, unknown edge refs, duplicate node ids, reachability from `START`, paths to `END`, reducer/type pairing, unregistered `custom:*` reducers, parallel fan-in `lastWrite` risks on immediate branch nodes, and uneven fan-in that is not a barrier. Conditional branch targets must reference real nodes.

## 7. `config`

Graph-level configuration and reusable values. Supports interpolation of declared secrets and references.

```yaml
secrets: [JIRA_TOKEN]
config:
  defaults:
    provider: claude              # default provider for agent nodes
    model: claude-sonnet-4.5
  vars:                           # author-defined constants, referenced as {{ config.vars.* }}
    jiraProject: "PLAT"
    jiraToken: "${JIRA_TOKEN}"    # expanded at load because JIRA_TOKEN is declared; redacted like any secret
```

`config.defaults` may set `provider` and `model` for agent nodes. Retry and timeout are not set here: the graph defaults are `runtime.retry` and `runtime.timeoutDefault`, and a node's own `retry` / `timeout` override those. `config.defaults.retry` and `config.defaults.timeout` are rejected, with an error that names the field to use instead.

Environment interpolation (`${VAR}` / `${VAR:-default}`) happens at load time for `config`/`runtime` scalars, and only for names the graph lists under its top-level `secrets:` ([§7a](#7a-secrets-declared-credentials)):

- A placeholder whose name is not declared is left as written and reported as `SECRET_UNDECLARED`, with its path and the name to add, by `loadGraph` / `flowgraph validate`. A `:-default` does not make an undeclared name optional.
- `compileGraph` checks any spec itself, whether loaded, copied, bundled, parsed by the server or built in code: it refuses an unexpanded `${NAME}` in `config` or `runtime` (or an inline subgraph's) whose name that graph does not declare. `validateSpec` reports the same diagnostics. Only `loadGraph` expands placeholders, so in a spec built in code a declared `${NAME}` stays literal and `$${NAME}` stays as written.
- An inline subgraph `spec:` and a file subgraph each expand only the names in their own `secrets:` list.
- A declared name behaves as before: its value, else the `:-default`, else an empty string.
- `$${VAR}` escapes a placeholder; the result is the literal text `${VAR}`, which is neither read nor checked, including by `compileGraph`. Each escape counts on its own: in `"$${X}${X}"` the second placeholder is still reported when `X` is undeclared.
- A value read from the environment this way is a secret and shows as `[REDACTED]` wherever it appears in results, events, logs and checkpoints. When a graph compiles, a declared name's host value is registered for redaction if it appears in a `config` or `runtime` string of that graph (or of the inline subgraph that declares it), so this holds for any copy of a loaded spec. A value under 8 characters is not redacted, so `true`, `1` or `default` never masks ordinary text. A `:-default` written in the graph is not redacted either. `{{ secret.NAME }}` reads are redacted when read, whatever their length. Write settings that should stay readable, such as a model name, as plain values.

Expansion runs after YAML parsing, so environment values cannot inject YAML structure. Node bodies, inputs, state defaults, metadata and keys remain literal; shell `${VAR}` syntax is left for the child shell and its allowed environment. Runtime expressions (`{{ ... }}`) are evaluated per-node-execution against live state. `state` in an expression never includes the engine's own channels (names starting with `__`): `{{ state }}`, `keys(state)` and `state['_' + '_x']` all leave them out; `__` keys inside your own channels are still readable. The two are distinct — see [05](./05-state-and-data.md).

## 7a. `secrets` (declared credentials)

`secrets` lists the host environment variables the graph may read as credentials. The host supplies the values; the graph only names them.

```yaml
secrets: [GITHUB_TOKEN, JIRA_TOKEN]

providers:
  openai: { kind: langchain, vendor: openai, apiKeyEnv: OPENAI_KEY_TEAM_A }   # needs OPENAI_KEY_TEAM_A in secrets

nodes:
  - id: fetch
    type: http
    with:
      url: https://api.github.com/user
      headers: { Authorization: "Bearer {{ secret.GITHUB_TOKEN }}" }
```

- Each entry is an environment variable name (letters, digits and `_`, not starting with a digit). A name listed twice is an error.
- `{{ secret.NAME }}` reads only a declared name. `flowgraph validate` and `compileGraph` report `SECRET_UNDECLARED` for any literal `secret.NAME` / `secret["NAME"]` in a node or an `mcpServers` entry that the list does not name. A computed name (`secret[state.key]`) is checked when it is read, and the node fails with the same message. A declared name the host has not set renders as an empty string.
- A provider `apiKeyEnv` must be declared. A provider with a `baseUrl` but no `apiKeyEnv` would send the vendor's default key (for example `OPENAI_API_KEY`) to that endpoint, so that default key must be declared too. A provider without `apiKeyEnv` or `baseUrl` reads its vendor's default key as before, without a declaration.
- A `command` skill's `env.vars` entry marked `secret: true` reaches the skill's process only when the graph declares it; a required one that is not declared fails the skill, an `optional: true` one is left out.
- `${NAME}` in `config` and `runtime` expands only a declared name ([§7](#7-config)); an undeclared one is reported as `SECRET_UNDECLARED`.
- An inline subgraph `spec:` and a file subgraph (`uses: ./child.graph.yaml`) each have their own `secrets` list. A child never reads a name only its parent declares, through `{{ secret.X }}` or `${X}`.
- `http`, `webhook`, `demo`, `service`, `shell`, `script`, skills and `mcpServers` all read `{{ secret.X }}` through the same declared list. A `demo` capture that reads an undeclared name fails the node rather than reporting `not_captured`.
- Declaring a name does not pass it to child processes. `shell`, `script`, `service` and command skills start from a small default allowlist (`PATH`, `HOME`, temp and locale variables); pass a secret explicitly, for example `env: { TOKEN: "{{ secret.GITHUB_TOKEN }}" }`.
- `secrets:` controls what templates and provider settings read; it is **not** an isolation boundary for `shell`, `script`, skill or `service` nodes. A shell `with.inheritEnv` entry, a skill's non-secret `env.vars`, and anything those processes read from their parent environment or the file system can still carry a host value that is not declared. Run graphs you do not trust under a node policy that blocks those node types.

## 8. Input / output mapping

To keep nodes reusable, a node declares **what it reads** (`input`) and optionally **where else it writes** (`output`), instead of hard-coding channel names inside logic.

**Default:** every node auto-saves its raw result to `state.outputs.<nodeId>` (a reserved object channel keyed by node id). Each run of a node **replaces** its whole previous entry: a node that returned `{ count: 1, approved: true }` and then `{ count: 2 }` leaves `state.outputs.<nodeId>` as `{ count: 2 }`, so downstream nodes never see a field the latest run did not produce. LangGraph forbids a channel name equal to a node id, so results live under the `outputs` bag. No `output` block is required for the common case — downstream nodes read `{{ state.outputs.summarize }}`, etc. The `outputs` channel is auto-declared at compile time when needed.

```yaml
nodes:
  - id: summarize
    type: agent
    input:
      text: "{{ state.issue.title }} — {{ state.issue.body }}"   # map state → node input
    with:
      prompt: "Summarize: {{ input.text }}"
      # omitted output → writes state.outputs.summarize automatically
      # optional projections (written alongside the slug):
      # output:
      #   to: summary              # also write full result to state.summary
      #   map:
      #     tokens: "{{ result.usage.totalTokens }}"
      #   raw: false               # keep only the projections, not state.outputs.summarize
      # opt out of any state write (pure side-effect):
      # output: none
```

| Form | Effect |
|------|--------|
| omitted / `{}` | Write `{ outputs: { [nodeId]: rawResult } }` |
| `output: none` | Write nothing (side-effect-only nodes) |
| `{ to: X }` and/or `{ map: {…} }` | Apply those projections **and** still write `state.outputs.<nodeId>` |
| `{ to: X }` and/or `{ map: {…} }` with `raw: false` | Apply only those projections; `state.outputs.<nodeId>` is not written |

- `input:` builds an `input` object available to the node's `with` expressions as `{{ input.* }}`. It is also the payload the node executes with: a skill gets it as its declared inputs, a `function` handler and a `script` get it as their argument, and a `shell` command gets it as `FLOWGRAPH_INPUT` and stdin. For `function`, `script` and `shell`, an explicit `with.input` replaces it (and can read it through `{{ input.* }}`).
- `to` / `map` are optional overrides for shared/typed/reducer-backed channels (e.g. parallel fan-in into one `append` channel) or field projection.
- **Exception — `subgraph`:** when `output` and `stateMap.out` are both omitted, channels that **share a name** merge back and the parent's reducer combines only the child's new values. Use `output: none` to write nothing, `output.to` / `output.map` for a normal node projection, or `stateMap.out` (`parentChannel: childChannel`) for an explicit mapping. See [05 — Subgraph merge-back](./05-state-and-data.md#subgraph-merge-back).
- `raw: false` keeps large or sensitive results out of state and checkpoints while still passing on the fields you project. It needs `to` or `map`; to write nothing, use `output: none`. Anything that reads `state.outputs.<nodeId>` (for example a gate's `round`) then sees no previous value.
- `none` cannot be combined with `to` / `map`, and a `none` key inside an output object is not supported, whatever its value (for example `{ none: true }`); write `output: none`.
- Prefer not to declare your own `outputs` channel. If you do, its declared reducer is used as written (for example `mergeDeep` to deep-merge successive results).

## 9. `runtime` (graph-level defaults)

Defaults for execution behavior; overridable per-node and via CLI flags. Full semantics in [07 — Runtime](./07-runtime-and-execution.md).

```yaml
runtime:
  checkpoint:
    enabled: true
    backend: sqlite               # memory | sqlite | postgres | <custom>
    path: ".flowgraph/checkpoints.db"
  webhookServer:                  # embedded HTTP ingress for wait.webhook
    host: "127.0.0.1"             # default
    port: 8878                    # default; 0 = ephemeral; EADDRINUSE → ephemeral fallback
    # token: "${FLOWGRAPH_WEBHOOK_TOKEN}" # optional shared secret for GET/POST; list FLOWGRAPH_WEBHOOK_TOKEN under secrets:
  services:
    terminateOnEnd: true          # stop non-keepAlive `service` processes on completed/error (default)
  hitl:
    breakpoints: { before: [publish] }   # static pause points
  retry:                          # default for every node that omits retry
    maxAttempts: 2
    backoff: exponential
  timeoutDefault: 300s            # default for every node that omits timeout
  recursionLimit: 50            # max supersteps for graph-level loops (default: 25)
  concurrency: 4                # max parallel branches per superstep
  hooks:
    - on: agent:beforeToolCall
      where: { tool: fs_write }
      do: interrupt
```

Some settings belong to the host running the graph, not the graph, and are rejected here with a message that names the replacement:

| Field | Set it in the host instead |
|---|---|
| `runtime.hitl.onInterrupt` | CLI `--on-interrupt`, or `onInterrupt` in `run()` / `resume()` options. The default is `fail`. |
| `runtime.observability` | `FLOWGRAPH_LOG_LEVEL`, event sinks, and `@flowgraph/observability-otel`. |
| `runtime.secrets.provider` | List names under the top-level `secrets:`; the host supplies their values. |
| `runtime.checkpoint.namespace` | Not needed: checkpoints are kept per thread. |

## 10. Full example

```yaml
apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: triage-issue
  description: Triage inbound issues, classify, and file the right ticket.
  labels: { team: platform }

imports:
  - skill: ./skills/create-jira-bug
    as: file-bug
  - skill: ./skills/create-jira-feature
    as: file-feature
  - skill: "@acme/skills/post-to-slack"
    as: notify

config:
  defaults: { provider: claude, model: claude-sonnet-4.5 }
  vars: { jiraProject: "PLAT" }

state:
  channels:
    issue:   { type: object }
    summary: { type: string, default: "" }
    label:   { type: string, default: "" }
    ticket:  { type: object }

nodes:
  - id: summarize
    type: agent
    input: { text: "{{ state.issue.title }}\n{{ state.issue.body }}" }
    with:
      prompt: "Summarize this issue in 2 sentences for triage:\n{{ input.text }}"
      output: { to: summary }

  - id: classify
    type: agent
    with:
      prompt: |
        Classify the issue as exactly one of: bug, feature, question.
        Issue summary: {{ state.summary }}
      schema:                     # structured output contract
        type: object
        properties: { label: { type: string, enum: [bug, feature, question] } }
        required: [label]
      output: { map: { label: "{{ result.label }}" } }

  - id: file-bug
    type: skill
    uses: file-bug
    input: { project: "{{ config.vars.jiraProject }}", summary: "{{ state.summary }}" }
    with: { output: { to: ticket } }

  - id: file-feature
    type: skill
    uses: file-feature
    input: { project: "{{ config.vars.jiraProject }}", summary: "{{ state.summary }}" }
    with: { output: { to: ticket } }

  - id: needs-human
    type: skill
    uses: notify
    input: { channel: "#triage", text: "Needs manual triage: {{ state.summary }}" }

  - id: announce
    type: skill
    uses: notify
    input: { channel: "#triage", text: "Filed {{ state.ticket.key }} for: {{ state.summary }}" }

edges:
  - { from: START, to: summarize }
  - { from: summarize, to: classify }
  - from: classify
    branch:
      - { when: "{{ state.label == 'bug' }}",     to: file-bug }
      - { when: "{{ state.label == 'feature' }}",  to: file-feature }
      - { default: true,                           to: needs-human }
  - { from: file-bug,     to: announce }
  - { from: file-feature, to: announce }
  - { from: announce,     to: END }
  - { from: needs-human,  to: END }

runtime:
  checkpoint: { enabled: true, backend: sqlite, path: ".flowgraph/checkpoints.db" }
```

## 11. Validation & diagnostics

`flowgraph validate ./triage.graph.yaml` runs the offline pipeline and reports diagnostics with file/line context. Categories:

| Severity | Examples |
|---|---|
| **error** (blocks) | unknown `apiVersion`/`type`; duplicate node `id`; edge references missing node; unreachable node; contract/type mismatch between mapped output and channel; skill missing required env var declaration; cyclic `imports` |
| **warning** | reachable node with no path to `END`; deprecated field; unused channel; missing `description` on a published skill |
| **info** | suggestions (e.g. "consider a `router` node instead of N conditional branches") |

Unknown keys are an error. The graph root, every node, and every inline subgraph `spec:` accept only the fields defined in this document; anything else is reported as `UNKNOWN_FIELD`, one diagnostic per key, with a path such as `nodes.character.runOn`. When the key is within two edits of a real one the message adds `Did you mean "runsOn"?`. Free-form blocks (`metadata`, `with`, `config`, `runtime`) are not affected. The check exists so an engine never silently drops a field it does not understand: a graph that uses a newer field (for example `runsOn`) must fail on an older engine instead of running without it.

The same diagnostics power editor squiggles via the JSON Schema + a future Language Server (post-1.0).

## 12. Versioning the spec

- `apiVersion: flowgraph/v1` is the stable contract. Breaking changes ⇒ `flowgraph/v2` with a documented migration and an optional `flowgraph migrate` codemod.
- Additive fields ship within `v1` and are reflected in the JSON Schema. Because the graph root and nodes reject unknown keys (§11), a graph that uses a new field requires an engine that knows it; older engines report `UNKNOWN_FIELD` rather than ignoring the field.
- `@flowgraph/spec` is independently versioned; the `apiVersion` token is decoupled from the package's semver.

## File resolution and static validation

Relative graph references and each child graph's module imports resolve against the YAML file that declares them, independently of the working directory and `runtime.workspace`. Child execution inherits the parent's workspace; a child's explicit `runtime.workspace` resolves relative to that inherited workspace. Subgraph aliases declared in `imports` are honored by load, preflight, and execution. Import cycles (including symlink cycles) are rejected with `SUBGRAPH_CYCLE`; sharing a child between DAG branches is supported. Missing relative imports are reported even when their aliases are unused.

Validation checks router and hook route targets, unreachable nodes, channel default types, and expression builtin names. Nodes referenced as agent tools or declared hook targets need no dummy inbound edges. Expression validation is bounded at 256 nesting levels and 2,048 tokens per expression and reports the field path; repeated invalid templates produce at most 50 expression diagnostics per graph. The CLI's ASCII and Mermaid topology includes declared router and HITL routes.
