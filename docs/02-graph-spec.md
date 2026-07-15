# 02 — Graph Specification (YAML)

This is the heart of the low-code layer: the declarative document that describes a graph. It is validated by a Zod schema in `@veloxdevworks/flowgraph-spec`, from which a JSON Schema is generated for editor autocomplete/validation.

> **Status:** target design. The schema below is the contract we are building toward; specifics (field names) are stable enough to author against and may receive additive, backward-compatible changes pre-1.0.

## 1. Document shape

A graph file is a single YAML document:

```yaml
apiVersion: flowgraph/v1        # required — versioned contract
kind: Graph                 # required — Graph | Skill | Subgraph
metadata: { ... }           # name, labels, description
imports: [ ... ]            # optional — reusable subgraphs/skills/node packages
config: { ... }             # optional — graph-level config/defaults
state: { ... }              # required — channel (state) definitions
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

To keep nodes reusable, a node declares **what it reads** (`input`) and **where it writes** (type-specific `output`), instead of hard-coding channel names inside logic.

```yaml
nodes:
  - id: summarize
    type: agent
    input:
      text: "{{ state.issue.title }} — {{ state.issue.body }}"   # map state → node input
    with:
      prompt: "Summarize: {{ input.text }}"
      output:
        to: summary                # write the node's primary output to state.summary
        # or structured mapping:
        # map:
        #   summary: "{{ result.text }}"
        #   tokens:  "{{ result.usage.totalTokens }}"
```

- `input:` builds an `input` object available to the node's `with` expressions (and to skills as their declared inputs).
- `output:` declares how the node's `result` is written back into state channels.
- This indirection is what lets the same skill/node be dropped into different graphs with different channel names.

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
