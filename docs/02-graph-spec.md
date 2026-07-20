# 02 — Graph Specification (YAML)

This is the heart of the low-code layer: the declarative document that describes a graph. It is validated by a Zod schema in `@veloxdevworks/flowgraph-spec`, from which a JSON Schema is generated for editor autocomplete/validation.

> **Status:** target design. The schema below is the contract we are building toward; specifics (field names) are stable enough to author against and may receive additive, backward-compatible changes pre-1.0.

## 1. Document shape

A graph file is a single YAML document:

```yaml
apiVersion: flowgraph/v1        # required — versioned contract
kind: Graph                 # required — Graph | Skill | Subgraph
metadata: { ... }           # name, labels, description
triggers: [ ... ]           # optional — host-interpreted auto-start conditions
imports: [ ... ]            # optional — reusable subgraphs/skills/node packages
config: { ... }             # optional — graph-level config/defaults
state: { ... }              # required — channel (state) definitions
inputs: [ ... ]             # optional — typed run parameters (collected before start)
input: { ... }              # optional — default seed values for a run
nodes: [ ... ]              # required — the node list
edges: [ ... ]              # required — static + conditional edges
runtime: { ... }            # optional — checkpoint/HITL/retry/observability defaults
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

`metadata.name` becomes the root OTel span name and the default checkpoint namespace.

## 2a. `triggers` (auto-start conditions)

Optional list of **host-interpreted** conditions that should start a run of this graph. The engine validates and round-trips the field but does **not** schedule or listen for these itself — desktop/server hosts own execution. Missed schedules while a host is offline are not replayed (Flowgraph is not a durable DAG/ETL scheduler).

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
- Programmatic / desktop: values are passed as `run({ input: { … } })` and validated against `inputs` inside `compiled.run()`.
- Graphs without an `inputs` array keep the previous free-form `input:` / `--input` behavior (no validation).

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
    retry: { maxAttempts: 3, backoff: exponential }   # optional; overrides runtime default
    timeout: 120s                 # optional
    when: "{{ state.issue != null }}"                  # optional; guard (skip if false)
    on:                           # optional; per-node hook bindings (see docs/06)
      error: continue             # continue | fail | route:<nodeId>
```

Full per-type configuration is documented in [03 — Node Types](./03-node-types.md).

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

### Fan-out (parallel) edges

Listing multiple `to` targets (or multiple edges from the same node) fans out to parallel branches, which LangGraph executes concurrently and merges via channel reducers.

```yaml
edges:
  - { from: plan, to: [impl-a, impl-b, impl-c] }   # parallel fan-out
  - { from: impl-a, to: gather }
  - { from: impl-b, to: gather }
  - { from: impl-c, to: gather }                    # fan-in; reducers merge writes
```

> `flowgraph validate` checks schema errors, unknown edge refs, duplicate node ids, reachability from `START`, paths to `END`, reducer/type pairing, unregistered `custom:*` reducers, and parallel fan-in `lastWrite` risks on immediate branch nodes. Conditional branch targets must reference real nodes.

## 7. `config`

Graph-level configuration and reusable values. Supports environment interpolation and references.

```yaml
config:
  defaults:
    provider: claude              # default provider for agent nodes
    model: "${FLOWGRAPH_MODEL:-claude-sonnet-4.5}"   # env interpolation w/ fallback
  vars:                           # author-defined constants, referenced as {{ config.vars.* }}
    jiraProject: "PLAT"
```

Environment interpolation (`${VAR}` / `${VAR:-default}`) happens at load time for `config`/`runtime` scalars. Runtime expressions (`{{ ... }}`) are evaluated per-node-execution against live state. The two are distinct — see [05](./05-state-and-data.md).

## 8. Input / output mapping

To keep nodes reusable, a node declares **what it reads** (`input`) and optionally **where else it writes** (`output`), instead of hard-coding channel names inside logic.

**Default:** every node auto-saves its raw result to `state.outputs.<nodeId>` (a reserved object channel with `mergeDeep`). LangGraph forbids a channel name equal to a node id, so results live under the `outputs` bag. No `output` block is required for the common case — downstream nodes read `{{ state.outputs.summarize }}`, etc. The `outputs` channel is auto-declared at compile time when needed.

```yaml
nodes:
  - id: summarize
    type: agent
    input:
      text: "{{ state.issue.title }} — {{ state.issue.body }}"   # map state → node input
    with:
      prompt: "Summarize: {{ input.text }}"
      # omitted output → writes state.outputs.summarize automatically
      # optional projections (additive with the slug):
      # output:
      #   to: summary              # also write full result to state.summary
      #   map:
      #     tokens: "{{ result.usage.totalTokens }}"
      # opt out of any state write (pure side-effect):
      # output: none               # or { none: true }
```

| Form | Effect |
|------|--------|
| omitted / `{}` | Write `{ outputs: { [nodeId]: rawResult } }` |
| `output: none` or `{ none: true }` | Write nothing (side-effect-only nodes) |
| `{ to: X }` and/or `{ map: {…} }` | Apply those projections **and** still write `state.outputs.<nodeId>` |

- `input:` builds an `input` object available to the node's `with` expressions (and to skills as their declared inputs).
- `to` / `map` are optional overrides for shared/typed/reducer-backed channels (e.g. parallel fan-in into one `append` channel) or field projection.
- **Exception — `subgraph`:** when `output` is omitted, the child graph's state is **merged** into the parent (transparent passthrough). Use `output: none` to suppress that, or `to`/`map`/`stateMap.out` for explicit projection.
- Prefer not to declare your own `outputs` channel unless you intend to override its `mergeDeep` semantics.

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
  services:
    terminateOnEnd: true          # stop non-keepAlive `service` processes on completed/error (default)
  hitl:
    onInterrupt: prompt           # prompt | fail | approve | webhook  (per-environment overridable)
  retry:
    maxAttempts: 2
    backoff: exponential
  timeoutDefault: 300s
  recursionLimit: 50            # max supersteps for graph-level loops (default: 25)
  concurrency: 4                # max parallel branches per superstep
  hooks:
    - on: agent:beforeToolCall
      where: { tool: fs_write }
      do: interrupt
  observability:
    otel: { enabled: true }
    logs: { level: info, format: auto }   # auto = pretty on TTY, json otherwise
```

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
  defaults: { provider: claude, model: "${FLOWGRAPH_MODEL:-claude-sonnet-4.5}" }
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
  hitl: { onInterrupt: prompt }
  observability: { otel: { enabled: true } }
```

## 11. Validation & diagnostics

`flowgraph validate ./triage.graph.yaml` runs the offline pipeline and reports diagnostics with file/line context. Categories:

| Severity | Examples |
|---|---|
| **error** (blocks) | unknown `apiVersion`/`type`; duplicate node `id`; edge references missing node; unreachable node; contract/type mismatch between mapped output and channel; skill missing required env var declaration; cyclic `imports` |
| **warning** | node with no inbound edge except `START` paths; deprecated field; unused channel; missing `description` on a published skill |
| **info** | suggestions (e.g. "consider a `router` node instead of N conditional branches") |

The same diagnostics power editor squiggles via the JSON Schema + a future Language Server (post-1.0).

## 12. Versioning the spec

- `apiVersion: flowgraph/v1` is the stable contract. Breaking changes ⇒ `flowgraph/v2` with a documented migration and an optional `flowgraph migrate` codemod.
- Additive fields ship within `v1` and are reflected in the JSON Schema.
- `@veloxdevworks/flowgraph-spec` is independently versioned; the `apiVersion` token is decoupled from the package's semver.
