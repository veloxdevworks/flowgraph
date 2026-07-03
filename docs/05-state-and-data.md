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

`flowgraph validate` also reports fan-in `lastWrite` risks, reducer/type mismatches, and reachability warnings offline.

Channels with `type: messages` (or `reducer: messages`) use LangGraph's `messagesStateReducer` — append plus id-based message upsert, not last-write-wins.

> Reducers are essential for **parallel branches** ([02 §Fan-out](./02-graph-spec.md#fan-out-parallel-edges)) and `map` nodes: when multiple branches write the same channel in one superstep, the reducer merges their writes. Without an accumulating reducer, the last write wins and data is lost — the compiler **warns** when immediate fan-out branch nodes (the direct `to` targets of a parallel edge) write the same channel with `lastWrite` or no reducer. The warning does not trace multi-hop paths before a join.

## 3. Reading & writing state

- **Read** anywhere via expressions: `{{ state.summary }}`, `{{ state.issue.body }}`.
- **Write** via a node's `output` mapping (declarative) — nodes never mutate state directly; they return updates that the runtime applies through reducers.

```yaml
with:
  output:
    to: summary                  # shorthand: write primary result to one channel
    # — or —
    map:                         # structured: write multiple channels from the result
      summary: "{{ result.text }}"
      tokens:  "{{ result.usage.totalTokens }}"
```

`result` is the node's raw output object (shape depends on node type/contract). `input` is the node's mapped input. `state` is current graph state. `config`, `secret`, `env`, and `run` are also in scope (see §6).

### Passing output between nodes

Nodes do not call each other directly. They **write channels** via `output`, and downstream nodes **read** those channels in `prompt`, `input`, `when`, etc.

```yaml
state:
  channels:
    answer: { type: object }
    formatted: { type: string, default: "" }

nodes:
  - id: agent
    type: intelligent
    with:
      prompt: "Research the topic."
      output: { to: answer }          # writes agent result → state.answer

  - id: format
    type: intelligent
    with:
      prompt: "One-line summary: {{ state.answer.text }}"
      output: { to: formatted }       # reads state.answer, writes state.formatted

edges:
  - { from: START, to: agent }
  - { from: agent, to: format }
  - { from: format, to: END }
```

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

## 4. The expression language (`@veloxdevworks/flowgraph-expr`)

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

The stdlib is intentionally small and pure. Anything more complex belongs in a `code` node or skill, not an expression.

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
    type: intelligent
    with: { prompt: "Summarize {{ state.issue.title }}" }     # {{ }} = expr, per run
```

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

`secret.*` resolves lazily and is special-cased: its values are **never** serialized into state, checkpoints, events, or logs (the redaction layer masks them). See [07 §Secrets](./07-runtime-and-execution.md#8-secrets--redaction).

## 7. State, checkpoints, and resume

Because state lives entirely in channels, it is exactly what the checkpointer persists. On resume, channels are restored from the checkpoint and execution continues. This means:

- Keep large/binary blobs **out** of state where possible (store a reference/URI); checkpoints serialize whole state per superstep.
- Secrets are never in state, so checkpoints are safe to persist and inspect.
- `messages` channels grow over a run; for long agent loops, prefer the agent node's internal context management over stuffing everything into a graph channel.

## 8. Long-term memory (Store)

For data that must persist **across** threads/runs (user preferences, learned facts), LangGraph's **Store** is exposed via `runtime.store`. Nodes, skills, and registered `code` functions access it via `ctx.store`. This is distinct from checkpointed thread state.

```yaml
runtime:
  store:
    enabled: true      # default: true
    backend: memory    # default: memory; durable backends via CompileOptions.store instance
```

```ts
// In a registered code function or tool handler:
registerFunction("rememberAnswer", async (input, ctx) => {
  const key = String(input.questionKey);
  const cached = await ctx.store?.get(["answers"], key);
  if (cached?.value) return cached.value;

  // ... ask_human or other logic to obtain answer ...

  await ctx.store?.put(["answers"], key, { answer: input.answer });
  return { answer: input.answer };
});
```

By default a process-local `InMemoryStore` is attached when `runtime.store.enabled` is not `false`. Pass a shared `BaseStore` instance to `compileGraph(spec, { store })` for tests or custom backends. Durable Postgres store integration is planned for a later milestone (see [10 — Roadmap](./10-roadmap.md)).
