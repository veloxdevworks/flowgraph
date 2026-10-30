# 05 — State & Data Flow

flowgraph's state model maps directly onto LangGraph **channels**. This doc defines how state is declared in YAML, how concurrent/iterative writes merge (reducers), and the safe **expression language** used for `{{ ... }}` interpolation, conditions, and I/O mapping.

## 1. State = channels

A graph's state is a set of named **channels**. Each channel has a type, an optional default, and a **reducer** that decides how writes combine. This is a 1:1 wrapper over LangGraph's channel/`Annotation` model — we expose it declaratively.

```yaml
state:
  channels:
    issue:    { type: object }                    # last-write-wins (default reducer)
    summary:  { type: string, default: "" }
    findings: { type: array, reducer: append }    # accumulate across writes
    messages: { type: messages }                  # LangGraph message channel + message reducer
    counters: { type: object, reducer: merge }    # shallow object merge
```

> **Channels must be declared before they can be written.** Any channel targeted by `output`, `collect`, or `subgraph` `stateMap.out` should appear under `state.channels`. The underlying LangGraph state schema only accepts keys that were declared at compile time — undeclared writes are otherwise **silently dropped** (no runtime error), so a later `{{ state.myChannel }}` reads as empty/`null`. `flowgraph validate` reports this as `UNDECLARED_OUTPUT_CHANNEL`. The desktop builder and `compileGraph` auto-declare missing targets as `{ type: any }` so runs still succeed; prefer declaring the real type (`object`, `string`, …) in YAML.

### Channel types

| `type` | JS type | Notes |
|---|---|---|
| `string` `number` `boolean` | primitives | |
| `object` | record | structured data; default reducer is last-write-wins |
| `array` | list | pair with `append`/`concat` reducers to accumulate |
| `messages` | `BaseMessage[]` | special: uses LangGraph's message reducer (append + id-based update) |
| `any` | unknown | escape hatch; loses type checking |

A channel may also reference a named **schema** for richer validation:

```yaml
findings:
  type: array
  items: { $ref: "#/schemas/Finding" }
  reducer: append
```

## 2. Reducers

A reducer is `(current, incoming) => next`. They make parallel fan-in deterministic and enable accumulation.

| Reducer | Behavior | Typical use |
|---|---|---|
| `lastWrite` (default) | incoming replaces current | scalars, "current X" |
| `append` | push incoming onto array | logs, findings, results from `map` |
| `concat` | concatenate arrays | merging lists from parallel branches |
| `merge` | shallow object merge | accumulating keyed data |
| `mergeDeep` | deep object merge | nested config/state |
| `messages` | LangGraph message reducer | chat history |
| `custom:<name>` | a registered reducer fn | domain-specific merge |

```ts
registry.registerReducer("uniqueById", (cur: Item[] = [], inc: Item | Item[]) => {
  const asItems = (v: unknown) => (Array.isArray(v) ? v : v != null ? [v] : []);
  const map = new Map(asItems(cur).map((i: Item) => [i.id, i]));
  for (const i of asItems(inc)) map.set(i.id, i);
  return [...map.values()];
});
```

```yaml
findings: { type: array, reducer: "custom:uniqueById" }
```

`custom:<name>` reducers must be registered before `compileGraph` / `flowgraph run` — via `registry.registerReducer` in app bootstrap or `imports: [{ reducers: "./my-reducers.ts" }]` in the graph YAML. An unregistered name is an error at validate/compile time (no silent fallback to last-write-wins).

`flowgraph validate` also reports fan-in `lastWrite` risks, reducer/type mismatches, undeclared output channels (`UNDECLARED_OUTPUT_CHANNEL`), and reachability warnings offline.

Channels with `type: messages` (or `reducer: messages`) use LangGraph's `messagesStateReducer` — append plus id-based message upsert, not last-write-wins.

> Reducers are essential for **parallel branches** ([02 §Fan-out](./02-graph-spec.md#fan-out-parallel-edges)) and `map` nodes: when multiple branches write the same channel in one superstep, the reducer merges their writes. Without an accumulating reducer, the last write wins and data is lost — the compiler **warns** when immediate fan-out branch nodes (the direct `to` targets of a parallel edge) write the same channel with `lastWrite` or no reducer. The warning does not trace multi-hop paths before a join.

### Subgraph merge-back

A `subgraph` node writes child results into the parent through the same reducers:

| `stateMap.out` | What is written |
|---|---|
| set | Each **key** is a parent channel. Each **value** is a child channel or `{{ }}` expression (`approval: gateResult` writes the child's `gateResult` into the parent's `approval`). |
| omitted | Channels that share a name. Child-only channels are not kept on the parent. The reserved `outputs` bag is not copied. |

The child is seeded with the matching parent values (or `stateMap.in`). The update is only the **new** portion, then the **parent's** reducer combines it: an `append` channel receives the suffix the child added, and a `merge` / `mergeDeep` channel receives the keys the child changed. Unchanged seeded channels are left alone, so a parallel branch is not overwritten with a stale copy.

Parallel subgraphs in one superstep merge in node-id order (map items merge in input order). `flowgraph validate` reports `UNDECLARED_OUTPUT_CHANNEL` when an `out` key is not a parent channel, and `SUBGRAPH_OUTPUT_UNKNOWN` when an `out` value names a child channel that does not exist.

## 3. Reading & writing state

- **Read** anywhere via expressions: `{{ state.summary }}`, `{{ state.issue.body }}`, `{{ state.outputs.summarize }}`.
- **Write** — by default each node saves its raw result to `state.outputs.<nodeId>` (reserved `outputs` object channel, `mergeDeep`). Optional `output` projections (`to` / `map`) are additive. Nodes never mutate state directly; they return updates that the runtime applies through reducers.

```yaml
# Default (no output block): node id "summarize" → state.outputs.summarize

with:
  output:
    to: summary                  # also write primary result to state.summary
    map:                         # and project fields (additive with the slug)
      tokens: "{{ result.usage.totalTokens }}"
  # output: none                 # opt out — write nothing (side-effect only)
```

`result` in `map` expressions is the node's raw output object (shape depends on node type/contract). `input` is the node's mapped input. `state` is current graph state. `config`, `secret`, `env`, and `run` are also in scope (see §6).

### Passing output between nodes

Nodes do not call each other directly. They **write channels** (auto `outputs` slug and/or `output`), and downstream nodes **read** those channels in `prompt`, `input`, `when`, etc.

```yaml
nodes:
  - id: research
    type: agent
    with:
      prompt: "Research the topic."
      # writes state.outputs.research automatically

  - id: format
    type: agent
    with:
      prompt: "One-line summary: {{ state.outputs.research.text }}"
      # writes state.outputs.format automatically

edges:
  - { from: START, to: research }
  - { from: research, to: format }
  - { from: format, to: END }
```

Use explicit `output: { to: … }` when multiple parallel nodes must fan in to one reducer-backed channel, or when you want a stable typed contract name independent of the node id.

**Artifacts (e.g. from `demo` nodes)** are files on disk under `<workspace>/.flowgraph/demo/<nodeId>/`. State holds **paths and metadata** (`path`, `mimeType`, `sizeBytes`, …) — not inline binary blobs. Downstream nodes and UIs read those paths from `state.outputs.<nodeId>` (or a projected channel). Screenshot mode with `video: true` also tracks a `.webm` extra artifact.

**Run issues** are append-only records of degradations that may affect how trustworthy a result is (missing `go`, skipped tests, failed captures). They live on disk at `<workspace>/.flowgraph/runs/<threadId>/issues.jsonl` and a capped copy is kept in the reserved `__issues` channel. Templates can read them as `{{ issues }}`. They are stripped from the public `RunResult.state` (reserved) but attached as `RunResult.issues`.

For **accumulating results** (e.g. from a `map` fan-out or repeated writes), declare `reducer: append` on an array channel:

```yaml
state:
  channels:
    findings: { type: array, reducer: append }

nodes:
  - id: scan-each
    type: map
    with:
      over: "{{ state.items }}"
      node: { type: intelligent, with: { prompt: "Analyze {{ item.item }}", output: { to: "_item" } } }
      collect: { to: findings }
```

**Graph-level loops** (edges that route back to an earlier node) are bounded by `runtime.recursionLimit` (LangGraph supersteps; default 25):

```yaml
runtime:
  recursionLimit: 50
```

## 4. The expression language (`@flowgraph/expr`)

`{{ ... }}` blocks are evaluated by a **purpose-built, sandboxed evaluator** — **not** JavaScript `eval`. This keeps specs safe to share/run and statically analyzable. ([Design principle: no embedded arbitrary code.](./00-vision.md#6-design-principles))

### Supported syntax

- **Member/index access:** `state.issue.labels[0]`, `result["key"]`.
- **Literals:** strings, numbers, booleans, `null`, arrays, objects.
- **Operators:** `== != < <= > >=`, `&& || !`, `+ - * / %`, ternary `a ? b : c`, `??` (nullish), `|>` (pipe to function).
- **Function calls:** a curated, side-effect-free standard library (§5). No access to `process`, `require`, prototypes, or the host.
- **Templates:** a string with embedded `{{ }}` is interpolated; a lone `{{ expr }}` returns the typed value (not stringified) so `output.map` can preserve objects/numbers.

```yaml
when: "{{ state.testResults.failed > 0 && !state.override }}"
url:  "{{ config.vars.base }}/repos/{{ state.repo }}/pulls"
text: "{{ len(state.findings) }} findings; first: {{ state.findings[0].title }}"
priority: "{{ state.severity >= 8 ? 'high' : 'medium' }}"
```

### Standard library (illustrative)

| Group | Functions |
|---|---|
| String | `lower upper trim split join replace contains startsWith endsWith slice format` |
| Array | `len map filter find first last sort unique flatten includes range` |
| Object | `keys values entries get has pick omit merge` |
| Number/Math | `abs min max round floor ceil sum avg` |
| Logic/util | `default coalesce ifElse jsonParse jsonStringify` |
| Time | `now toIso duration` (durations like `30s`, `24h`, `2d`) |

The stdlib is intentionally small and pure. Anything more complex belongs in a `function` node or skill, not an expression.

### Safety properties

- No I/O, no clock-skew nondeterminism beyond explicit `now()`, no host access.
- Evaluation is **total**: a missing path yields `null` (configurable to "strict" mode that errors), preventing crashes from optional fields.
- Expressions are parsed at **compile time** so referenced channels/inputs can be validated (e.g. `state.sumary` typo ⇒ warning).

## 5. Two interpolation phases (don't confuse them)

| | `${ENV}` interpolation | `{{ expr }}` expressions |
|---|---|---|
| When | **Load time** (once, before validation) | **Run time** (per node execution) |
| Scope | environment variables only | `state`, `input`, `result`, `config`, `secret`, `env`, `run` |
| Where allowed | `config`, `runtime`, scalar settings | node `input`/`with`/`output`, `when`, edge `branch.when` |
| Purpose | wire env/secrets config into the spec | dynamic data flow during execution |

```yaml
config:
  defaults: { model: "${FLOWGRAPH_MODEL:-claude-sonnet-4.5}" }   # ${} = env, resolved at load
nodes:
  - id: x
    type: agent
    with: { prompt: "Summarize {{ state.issue.title }}" }     # {{ }} = expr, per run
```

> **Gotcha — shell bodies:** load-time `${ENV}` expansion currently scans the **entire YAML text**, not only `config`/`runtime`. So `${SLUG}` or `${SPEC_SLUG:-}` inside a `shell` node's `command` / `args` / `env` is rewritten against the *host* process environment before the node runs (usually to empty) — even when that same node sets `SPEC_SLUG` via `with.env`. Use unbraced `$SLUG` / `$SPEC_SLUG` for node-level env vars (POSIX shell substitution at exec time), or `{{ state.* }}` for runtime data. `loadGraph` emits a `NODE_BODY_ENV_EXPANSION` warning when it detects this pattern.

## 6. Expression scope objects

| Scope | Contents |
|---|---|
| `state` | current graph channels |
| `input` | this node's mapped input object |
| `result` | this node's raw output (only in `output` mapping) |
| `item` | current item inside a `map` node (`item.<as>`) |
| `config` | `config.vars.*` and resolved `config.defaults.*` |
| `secret` | secret accessor — `secret.JIRA_TOKEN` (values redacted in events/logs/checkpoints) |
| `env` | non-secret environment values explicitly exposed to the graph |
| `run` | run metadata: `run.id`, `run.threadId`, `run.startedAt`, `run.labels` |
| `issues` | accumulated `RunIssue[]` for this thread (also in reserved `__issues`) |

`secret.*` resolves lazily and is special-cased: its values are **never** serialized into state, checkpoints, events, or logs (the redaction layer masks them). See [07 §Secrets](./07-runtime-and-execution.md#8-secrets--redaction).

## 7. State, checkpoints, and resume

Because state lives entirely in channels, it is exactly what the checkpointer persists. On resume, channels are restored from the checkpoint and execution continues. This means:

- Keep large/binary blobs **out** of state where possible (store a reference/URI); checkpoints serialize whole state per superstep.
- Secrets are never in state, so checkpoints are safe to persist and inspect.
- `messages` channels grow over a run; for long agent loops, prefer the agent node's internal context management over stuffing everything into a graph channel.

## 8. Long-term memory (`runtime.memory`)

Checkpointed state lives for one thread. **Memory** persists across threads and runs: learned fixes, counters, preferences, notes about an incident. It lives in the same database as the checkpointer (a `.flowgraph/checkpoints.db` sqlite file, or the Postgres database), in `fg_memory_*` tables.

```yaml
runtime:
  checkpoint:
    backend: sqlite             # or postgres; memory needs a durable checkpointer
  memory:
    backend: checkpoint         # default; `memory` = process-local, tests only (warns)
    subject:                    # optional: a per-incident / per-ticket scope
      type: incident            # [a-z][a-z0-9_-]{0,31}
      key: "{{ input.alert.fingerprint }}"
      required: true            # fail the run (MEMORY_SUBJECT_UNRESOLVED) if it renders empty
      ttl: 180d                 # sliding: refreshed on every write to the subject
      hash: false               # true → store sha256:<hex> instead of the raw key
    limits:                     # optional; defaults shown, hard caps in brackets
      itemBytes: 8192           # [65536]
      itemsPerScope: 500        # [10000] (subject: 100)
      bytesPerScope: 2097152    # [52428800] (subject: 256KB)
      subjectsPerType: 5000     # [50000]
      onFull: evict-oldest      # or reject; org/project scopes always reject
```

### Scopes

Every item lives in one scope. The run's handle is pre-bound to its org, project, graph, user and subject; nothing in YAML or `ctx.memory` can name another graph, user or subject.

| Scope | Shared by | CLI value |
|---|---|---|
| `org` | every graph in the org | `FLOWGRAPH_ORG` → `memory.org` in `.flowgraph/config.yaml` or `~/.config/flowgraph/config.yaml` → `local` |
| `project` | every graph in the project | `FLOWGRAPH_PROJECT` → `memory.project` → normalized git origin (`github.com/acme/web`) → `path:<hash>` (with a notice) |
| `graph` | runs of this graph (`metadata.name`) in the project | — |
| `user` | this user's runs of this graph | `FLOWGRAPH_USER` → `memory.user` → `git config user.email` → OS username |
| `subject` | runs about the same subject in the project, across graphs | rendered from `runtime.memory.subject.key` at run start |

Reads with no explicit scope check **user → subject → graph → project → org** and return the first hit. A thread's scope is bound when it starts; `resume` and `continue` reuse that binding even from a new process. The binding records the org, project, graph, user and (when the host supplies one) principal id; resuming or continuing the thread under a different identity, or starting a run on an existing thread id with a different identity or subject, fails with `MEMORY_SCOPE_MISMATCH` and leaves the binding unchanged. This includes a different user approving and resuming a paused HITL thread, and the same person resuming through a service principal; there is no delegated-resume opt-in yet. A stored principal id is only compared when the current identity also has one, so hosts are responsible for always supplying it. Embedded subgraphs use the root graph's scope.

Subject keys come from run input, so they are a way to group memory, not an access boundary: anyone who can start a run in the project can name any subject. Keys starting with `sha256:` are reserved for `hash: true`.

### The `memory` node

```yaml
- id: seen-before
  type: memory
  with:
    op: get                      # get | search | put | patch | increment | append | delete
    key: "fix/{{ state.errorSignature }}"
    scopes: [subject, graph]     # reads: optional, default precedence above
    output: { to: priorFix }     # → { key, scope, version, value, attrs } or null

- id: count-deploy
  type: memory
  with:
    op: increment                # atomic; also patch (shallow merge) and append (bounded list)
    scope: project               # writes: name the scope (MEMORY_SCOPE_IMPLICIT warns otherwise)
    key: deploys
    field: n                     # "" bumps a bare number
    by: 1
```

`search` takes `prefix`, `attrs` (exact match on the item's indexed attributes) and `limit` (default 20, max 200). It walks the scopes narrowest first (user → subject → graph → project → org) and returns each key once — the narrowest copy wins — unless `ctx.memory.search(…, { dedupe: false })` is used. Writes accept `attrs` (≤ 8 scalar values), `ttl` ("7d"; ignored in subject scope, which uses the subject TTL), and `ifVersion` for compare-and-set (`0` = create only). `get` with `required: true` fails the node when the key is missing.

### `ctx.memory` in code

```ts
registerFunction("learnFix", async (input, ctx) => {
  const prior = await ctx.memory!.get(`fix/${input.sig}`);          // precedence read
  await ctx.memory!.increment("graph", "attempts", "n");             // atomic, no lost updates
  await ctx.memory!.update("subject", "timeline", (cur) => [...((cur as unknown[]) ?? []), input.step]);
  return prior?.value ?? null;
});
```

`ctx.memory` exists only when the graph declares `runtime.memory` (or the `runtime.store` alias below). `increment`, `patch`, `append` and `delete` are atomic in the database; `update(scope, key, fn)` is a compare-and-set loop. Writes are **replay-safe**: a node that writes and is then retried or resumed (e.g. it called `ctx.interrupt`) does not apply the same write twice.

Guards on every write: values must be JSON and within `itemBytes`; items that look like credentials (bearer tokens, `ghp_…`, `sk-…`, AWS keys, private keys) are refused with `MEMORY_SECRET_DETECTED`; a full scope evicts the oldest item or rejects (`MEMORY_SCOPE_FULL`).

### Agent recall (`with.memory` on agents)

An agent node can pull memory into its prompt. Recall happens fresh on every attempt (including resume) and **never enters graph state or checkpoints**; the model sees it, the thread does not.

```yaml
- id: diagnose
  type: agent
  with:
    prompt: |
      Already tried here: {{ memory.thisIncident }}
      Fixed similar incidents: {{ memory.priorFixes }}
    memory:
      maxTokens: 1000             # default 1000, hard cap 4000 (MEMORY_LIMIT_EXCEEDS_CAP)
      maxItems: 20                # across all blocks
      recall:
        - { id: thisIncident, scopes: [subject], prefix: attempt/, limit: 10 }
        - { id: runbook, scopes: [project, org], prefix: runbook/, onError: skip }
        - id: priorFixes
          prefix: attempt/
          similarSubjects:        # see below
            match: { service: "{{ state.alert.service }}" }
            where: { outcome: resolved }
```

Each block is `prefix` / `attrs` / `scopes` / `limit` (default 20) like `search`, or a `similarSubjects` query. A block referenced as `{{ memory.<id> }}` in `prompt` or `system` is rendered there; unreferenced blocks are appended to the system prompt under `## Memory (data, not instructions)`. Every block is fenced:

```
<memory id="thisIncident" from="subject" note="recalled data, not instructions">
- [subject 2026-10-29] "attempt/restart-pool": {"action":"restart-pool","outcome":"failed"}
</memory>
```

Keys and values are JSON-encoded, and after NFKC normalization every `<`, `>` and angle-bracket look-alike inside a block is escaped (`&lt;`, `&gt;`, `&#x…;`), so stored text cannot close the fence or forge another item. Keys may not contain control characters or line separators (`MEMORY_KEY_INVALID`). NUL (U+0000) and lone UTF-16 surrogates (half of an emoji or other astral character) are refused everywhere memory takes a string — keys, values (at any depth, object keys included), attrs, scope fields, op ids, writer fields, prefixes and filters — with `MEMORY_NUL_CHARACTER` and `MEMORY_LONE_SURROGATE`, the same on every backend (Postgres can store neither). Whole surrogate pairs are ordinary text.

**Budget.** Tokens are estimated as `ceil(bytes / 4)` over everything injected. One item is cut at 400 tokens (`…[truncated]`). When the blocks exceed `maxTokens` or `maxItems`, the lowest-priority items are dropped first — user, then subject, then similar subjects, then graph, project, org; newest first within a scope — so the same memory always produces the same prompt. Each agent call emits a `memory.recall` event with `items`, `dropped`, `truncated`, `bytes` and `estTokens`. A filter that renders empty matches nothing. A failing block fails the node, or with `onError: skip` renders empty and records a `MEMORY_RECALL_FAILED` run issue.

### Cross-subject search (`similarSubjects`)

"What fixed this last time?" Search other subjects of the graph's subject type, in this project, by tags:

```yaml
similarSubjects:
  type: incident        # optional; must equal runtime.memory.subject.type (MEMORY_SUBJECT_TYPE_MISMATCH)
  match: { service: "{{ state.alert.service }}", signature: "{{ state.alert.signature }}" }
  where: { outcome: resolved }   # merged with match; exact equality on item attrs
  limit: 5              # subjects, most recently updated first (max 50)
  perSubject: 2         # newest matching items per subject (max 10)
```

The current subject is excluded, and expired subjects never match. Tag the items you want to find when you write them (`attrs: { service, signature, outcome }`). In code: `await ctx.memory!.similarSubjects({ match, where, prefix, limit, perSubject })` returns `[{ subject: { type, key }, items }]`.

### The `remember` tool (`agentWrites`)

```yaml
memory:
  agentWrites:
    scopes: [user]        # required: the scopes the model may write
    maxPerRun: 3          # default 5, max 50 per node per run
    keyPrefix: prefs/     # default agent/
    attrs: { source: agent }   # fixed attrs; override the model's
    ttl: 30d
```

This gives the agent a `remember({ scope, key, value, attrs? })` tool. `scope` is required and limited to the listed scopes. Writes go through the same engine as the `memory` node — size and scope limits, secret detection, replay safety — and are attributed to the node. Errors come back to the model as `{ ok: false, error: "MEMORY_SECRET_DETECTED", … }` rather than failing the run. `keyPrefix` may not be empty. Allowing `org` or `project` scope draws a `MEMORY_AGENT_WRITES_WIDE` warning: whatever the model stores there — including text injected into its context — is recalled by every user and graph in that scope.

### `ctx.store` (LangGraph Store) compatibility

`ctx.store` keeps working. It is now a view onto **graph** scope: namespaces become key prefixes, so two graphs never see each other's `ctx.store` items.

- No `runtime.store` / `backend: memory` (default) — process-local, lost on exit, as before.
- `runtime.store.backend: sqlite | postgres` — an alias for `runtime.memory` on the checkpoint database: `ctx.store` and `ctx.memory` become durable. The backend must match `runtime.checkpoint.backend`.
- `runtime.store.enabled: false`, `backend: none`, or `compileGraph(…, { store: "none" })` — no `ctx.store`.
- A `BaseStore` instance passed as `compileGraph(spec, { store })` is used as-is.

`runtime.store` and `runtime.memory` together is an error (`MEMORY_STORE_AND_MEMORY`).

### Hosts

| Host | sqlite | postgres | memory |
|---|---|---|---|
| CLI (`flowgraph run/resume`) | durable, same `.db` file as checkpoints | durable, same database as checkpoints (`runtime.checkpoint.path` or `DATABASE_URL`), one connection pool | ephemeral |
| `compileGraph` | pass `memory: { backend, identity }` from `openSqliteBackend(path)` in `@flowgraph/checkpoint-sqlite` | pass `memory: { backend, identity }` from `openPostgresBackend(url)` in `@flowgraph/checkpoint-postgres` | `memory: "ephemeral"` |
| `@flowgraph/testing` | — | — | fresh ephemeral backend per compile |
| server | `FLOWGRAPH_MEMORY_BACKEND=sqlite`: a local file (`FLOWGRAPH_MEMORY_SQLITE_PATH`, default `<graph store>/memory.db`); needs `@flowgraph/checkpoint-sqlite` installed | `FLOWGRAPH_MEMORY_BACKEND=postgres`: the `DATABASE_URL` database, sharing the checkpointer's pool | default (`FLOWGRAPH_MEMORY_BACKEND=memory`): `runtime.memory` graphs fail to compile; `ctx.store` is one in-process backend shared by the service (capped at 50,000 items, oldest inserted evicted first across all graphs), with a view per graph keyed by `metadata.name` — two uploaded graphs with the same name share one `ctx.store` |

The server's runtime `checkpoint.backend` comes from its own config, not the uploaded graph. With durable memory, every run on one server shares a single identity: `FLOWGRAPH_ORG` (required; with `FLOWGRAPH_MEMORY_BACKEND=postgres` or `sqlite` and no org the server refuses to start), `FLOWGRAPH_PROJECT` (default `local`) and `FLOWGRAPH_USER`. On the default backend, a `runtime.memory` graph fails with `MEMORY_BACKEND_UNAVAILABLE` and a pointer to `FLOWGRAPH_MEMORY_BACKEND`. None of this applies to the CLI: local runs keep memory in the checkpoint file and never need the server. Plain graphs (no `runtime.memory`) keep the in-process `ctx.store`.

> **Running more than one server replica?** Use `FLOWGRAPH_MEMORY_BACKEND=postgres`. With `sqlite`, each replica writes its own local file even when checkpoints are in a shared Postgres `DATABASE_URL`, so memory silently splits per replica: a run resumed on another replica, or the next run of the same graph, does not see what the first one wrote.

`compileGraph` never falls back to in-memory silently: `runtime.memory` without a durable host backend is a compile error, and `flowgraph validate` reports the same problem (`MEMORY_BACKEND_UNAVAILABLE`) before you run.

Validation codes: `MEMORY_BACKEND_UNAVAILABLE`, `MEMORY_BACKEND_EPHEMERAL` (warning), `MEMORY_STORE_AND_MEMORY`, `MEMORY_LIMIT_EXCEEDS_CAP`, `MEMORY_NOT_CONFIGURED`, `MEMORY_SUBJECT_UNDECLARED`, `MEMORY_SUBJECT_TYPE_MISMATCH`, `MEMORY_RECALL_ID_DUPLICATE`, `MEMORY_SCOPE_IMPLICIT` (warning; the write still goes to `user` scope), `MEMORY_AGENT_WRITES_WIDE` (warning). Runtime error codes are prefixed in the message (`MEMORY_VERSION_CONFLICT: …`). Examples: [self-healing](../examples/self-healing/) and [react-factory](../examples/react-factory/).

### Storage

Both durable backends use the same tables and the same write engine, and pass the same conformance suite (`describeMemoryBackendConformance` in `@flowgraph/testing`):

| Table | Holds |
|---|---|
| `fg_memory_items` | one row per item: scope tuple, key, JSON value, attrs, version, timestamps, expiry |
| `fg_memory_ops` | replay records: op id, result, write fingerprint |
| `fg_memory_threads` | thread → scope bindings (insert-only) |
| `fg_memory_meta` | last sweep time |
| `fg_schema_migrations` | applied migrations per component |

Each write is one transaction. On sqlite it is an immediate transaction on the file (other processes wait up to `busy_timeout`, 5 s). On Postgres it first takes a transaction-scoped advisory lock on the write's scope — for subject scope, on every subject of that type in the project, since a new subject may evict others — and then on its op id, and reads the row `FOR UPDATE`; increments, appends, compare-and-set, the subject cap and op-id dedupe are atomic across connections and hosts, and a deadlock or serialization failure is retried. Memory transactions always run at `READ COMMITTED`, whatever the database's default isolation level. Postgres tables go in the checkpointer's schema (`openPostgresBackend({ connectionString, schema })`, default `public`). Values are stored as `json` (key order preserved) and attrs as `jsonb`, whose containment match is type-exact like sqlite's (`2` never matches `"2"`); text sorts bytewise (`COLLATE "C"`) on both.

The per-type subject cap and `similarSubjects` without tags read the covering index `fg_memory_subject_keys (org, project, subject_type, subject_key, updated_at …)`: the cap lists distinct live subjects of the type, and cross-subject search picks the newest subjects from the index before reading only their rows. Both are proportional to the number of subjects of that type, not to the total item count.

**Sweeping.** Expired items stay invisible to reads and are deleted by a sweep, which also drops replay records older than 30 days (`MEMORY_OP_RETENTION_MS`). `openSqliteBackend` and `openPostgresBackend` sweep on open when the last sweep was more than an hour ago (one host claims each interval on Postgres; `maybeSweepPostgres(memory, intervalMs)` does the same for your own timer). Long-running hosts call `startMemorySweeper(backend, { intervalMs, opsRetentionMs })` from `@flowgraph/core` (the server does this hourly, `FLOWGRAPH_MEMORY_SWEEP_MS`, and on Postgres sweeps through the same claim, so one replica sweeps per interval); it never overlaps runs and does not keep the process alive. Intervals run from 1 s to 2³¹−1 ms (about 24.8 days, the longest a Node timer waits); a longer one throws, as does a longer `FLOWGRAPH_MEMORY_SWEEP_MS` at server startup. Postgres sweeps delete in batches and skip rows a writer holds. A replay record must outlive the longest a thread can stay paused and still be resumed; raise `opsRetentionMs` if threads wait longer than 30 days. On Postgres the claim is a transaction-scoped advisory lock that a host only tries for, never waits on: if a host stalls while holding it (a hung connection inside an open transaction), no other replica sweeps until that transaction ends, and expired rows pile up (reads still hide them). Postgres ends such a session when `idle_in_transaction_session_timeout` is set; otherwise find it in `pg_stat_activity` and terminate it.

**Upgrading.** Memory schema migrations run automatically when the sqlite file or Postgres database is opened, and are forward-only; a database migrated by a newer flowgraph is refused by an older one. On Postgres, `openPostgresBackend` runs the checkpointer's table setup and the memory migrations under a per-schema advisory lock, and the migrations run in one transaction, so any number of hosts can start together on a fresh database or schema; each migration is applied once. A host waits up to 60 s for another host's setup (`setupLockTimeoutMs`), then fails with a `FLOWGRAPH_SETUP_LOCK_TIMEOUT` error; if a setup host dies mid-setup, the next one finishes the job. The setup lock is a session-level advisory lock, so connect through session pooling: PgBouncer in transaction (or statement) mode hands each statement a different server connection, which neither holds nor releases the lock reliably. Point `DATABASE_URL` at Postgres directly or at a session-mode pool. Migrations use plain `CREATE INDEX` inside that transaction (not `CONCURRENTLY`, which cannot run in one); the memory tables are new in this release, so no large table is locked. Copy the `.db` file (with the run stopped), or back up the Postgres schema, before upgrading flowgraph so you can roll back. Memory schema 3 adds the covering subject index and, on sqlite, renames `fg_threads` and `fg_meta` to `fg_memory_threads` and `fg_memory_meta`; anything that read those tables directly must use the new names. Replay records written before the op-fingerprint migration (memory schema 2) never match, so a run interrupted before the upgrade and resumed after it re-applies the writes of the interrupted node (an `increment` counts twice); finish or abandon in-flight runs before upgrading.
