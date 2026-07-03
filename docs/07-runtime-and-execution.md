# 07 — Runtime & Execution

This doc covers what happens when a compiled graph runs: compilation handoff, checkpointing, durability, human-in-the-loop (HITL), retries/timeouts, secrets, and the CI-vs-desktop split. The runtime stays thin over LangGraph.js, adding the cross-cutting machinery from [06 — Events & Hooks](./06-events-and-hooks.md).

## 1. From compiled graph to run

`compileGraph()` returns a `CompiledGraph` (a LangGraph `StateGraph.compile()` result plus flowgraph metadata). `runGraph()` executes it:

```ts
const result = await runGraph(compiled, {
  input: { issue },             // initial state (validated against channels)
  threadId: "issue-123",        // checkpoint/resume key; auto-generated if omitted
  config: { /* per-run overrides */ },
  signal,                       // AbortSignal → run.aborted
  onInterrupt: "prompt",        // override env policy for this run
});
// result: { state, status: "completed" | "interrupted" | "error", interrupts?, usage, runId }
```

Under the hood flowgraph calls LangGraph's `invoke`/`stream` with `{ configurable: { thread_id } }`, wraps each node in the middleware stack, and translates LangGraph stream chunks into flowgraph events.

## 2. Execution modes

| Mode | API | Use |
|---|---|---|
| **invoke** | `runGraph(...)` → final result | CI jobs, scripts: run to completion (or first interrupt) |
| **stream** | `runGraph.stream(...)` → async iterable of events | live UIs, CLI TTY rendering, progress |
| **step** | `runGraph.step(...)` | advance one superstep (debugging, time-travel) |

All three share the same compiled graph and emit the same events.

## 3. Checkpointing & durability

Checkpointing is **first-class in v1**. A checkpointer persists graph state at every superstep (LangGraph's model), keyed by `thread_id`, enabling resume, time-travel, fault tolerance, and HITL.

### Backends

| Backend | Package | Use |
|---|---|---|
| `memory` | core (`MemorySaver`) | tests, ephemeral CI runs |
| `sqlite` | `@veloxdevworks/flowgraph-checkpoint-sqlite` | desktop/local, single-machine CI artifact (a `.db` file) |
| `postgres` | `@veloxdevworks/flowgraph-checkpoint-postgres` | shared/durable, multi-worker (later milestone) |
| custom | implement `CheckpointerAdapter` | bring your own (Redis, S3, etc.) |

```yaml
runtime:
  checkpoint:
    enabled: true
    backend: sqlite
    path: ".flowgraph/checkpoints.db"
    namespace: "{{ metadata.name }}"     # default
```

The adapter interface wraps LangGraph's `BaseCheckpointSaver` (`put`, `putWrites`, `getTuple`, `list`) so any LangGraph checkpointer is usable, and ours add lifecycle events (`checkpoint.write/load`) and the `checkpoint:beforeWrite` hook (for redaction/transform).

### Time travel & inspection

Because every superstep is checkpointed, the runtime exposes:

```ts
const history = await getStateHistory(compiled, { threadId });   // list of StateSnapshots
await resumeFrom(compiled, { threadId, checkpointId });          // fork/replay from a point
```

This powers `flowgraph run --resume`, debugging, and "what if I re-run from here" flows.

## 4. Retries, timeouts, idempotency

Each node is wrapped with retry/timeout policy (graph default, overridable per node):

```yaml
runtime: { retry: { maxAttempts: 2, backoff: exponential, baseMs: 500 }, timeoutDefault: 300s }
# per node:
- id: fetch
  type: http
  retry: { maxAttempts: 5, retryOn: [429, 503] }
  timeout: 30s
```

- **Backoff:** `fixed | linear | exponential` with jitter; `baseMs`, `maxMs`, `factor`.
- **retryOn:** error classes / HTTP statuses; non-matching errors fail immediately.
- **Idempotency:** nodes declare `sideEffecting`. On resume after an interrupt, LangGraph **re-runs the interrupted node from its start**, so side-effecting nodes must be idempotent or guarded. The runtime helps via an optional **idempotency key** (`ctx.once(key, fn)` runs `fn` at most once per key per thread, recorded in the checkpoint) so a "create ticket" doesn't double-fire on resume.

## 5. Human-in-the-loop

HITL is built on LangGraph's `interrupt()` + `Command({ resume })` + checkpointer model (verified against current LangGraph.js docs). Three ways a graph pauses:

1. **Dynamic interrupt** — a node (or hook) calls `ctx.interrupt({ reason, kind?, data? })`. Execution suspends; state is checkpointed; the payload surfaces to the caller under the interrupt result.
2. **Static breakpoints** — `interruptBefore` / `interruptAfter` a node, set at compile or per-run (great for debugging / approval gates).
3. **`hitl` nodes** — first-class approve / question / choice gates in the graph topology.
4. **`ask_human` tool** — intelligent agents ask clarifying questions mid-loop (opt-in via `tools: [{ function: ask_human }]`).
5. **`webhook: wait` / `wait` nodes** — durable pauses for external input.

### Interrupt kinds

Each interrupt carries a **kind** so operators know how to answer:

| Kind | Used by | Resume value shape |
|---|---|---|
| `approval` | `hitl` approve mode, tool gates, `permission: ask` | `{ approved: true \| false }` |
| `question` | `hitl` question mode, `ask_human` | `{ answer: "..." }` |
| `choice` | `hitl` choice mode, `ask_human` with choices | `{ choice: "..." }` |
| `custom` | advanced / hook payloads | arbitrary JSON |

```yaml
- id: approve-release
  type: hitl
  with:
    mode: approve
    message: "Approve release notes before publishing?"
    output: { to: approval }
```

### Resuming

```ts
// later (could be days later, after process restart) — same threadId
const result = await resumeGraph(compiled, {
  threadId: "release-42",
  resume: { approved: true, editedNotes: "..." },   // becomes the interrupt()'s return value
});
```

A `thread_id` + durable checkpointer is what makes "interrupt for approval and resume days later" work ([Vision success criteria](./00-vision.md#7-success-criteria)).

### Interrupt policy per environment

The **same** interrupting graph behaves differently by environment via `onInterrupt`:

| Policy | Behavior | Where |
|---|---|---|
| `prompt` | ask interactively (CLI prompt) and resume inline | desktop |
| `fail` | stop with `status: interrupted`, exit non-zero | CI default |
| `approve` | auto-approve with a default/derived value (use carefully) | trusted CI |
| `webhook` | persist + emit `interrupt.raised`; an external system resumes via API/CLI later | async/CI + ops |

This is set in `runtime.hitl.onInterrupt`, overridable by `--on-interrupt` and per-run options. The graph author writes the interrupt **once**; operators choose how it resolves per environment.

### GUI / service integration

External systems complete HITL without a terminal prompt:

1. Run the graph with `--on-interrupt fail` (or `webhook`) so it pauses and exits with `status: interrupted`.
2. Poll pending interrupts: `flowgraph resume <graph> --thread <id> --list --json`
3. Resume programmatically: `flowgraph resume <graph> --thread <id> --resume '{"answer":"..."}'`

The same flow is available via the programmatic API: `compiled.getState(threadId)` → read `interrupts` → `compiled.resume({ threadId, resume })`.

```json
{
  "threadId": "release-42",
  "interrupts": [
    {
      "id": "…",
      "kind": "question",
      "reason": "Which Jira project?",
      "choices": null,
      "payload": { "reason": "Which Jira project?", "kind": "question", "data": { "question": "Which Jira project?" } }
    }
  ]
}
```

## 6. Concurrency & parallelism

- LangGraph executes fan-out branches concurrently within a superstep; reducers merge fan-in ([05 §2](./05-state-and-data.md#2-reducers)).
- `map` nodes bound parallelism via `concurrency`.
- A global `runtime.concurrency` caps simultaneous node executions (protects rate limits / resources).
- Intelligent-node tool calls run within the node; their concurrency is provider-governed.

## 7. Abortion & cancellation

`runGraph({ signal })` wires an `AbortSignal` through nodes (`ctx.signal`), provider calls, and HTTP. On abort: in-flight side-effecting nodes get the signal, a checkpoint is written (so the run is resumable), and `run.aborted` is emitted. `Ctrl-C` in the CLI maps to this.

## 8. Secrets & redaction

- Secrets come from a `SecretProvider` (default: env vars; pluggable: file/keychain/vault). Accessed via `ctx.secrets.get(name)` or `secret.NAME` in expressions.
- Secrets are **never** written to state, checkpoints, events, or logs. A **redaction layer** (a default hook + sink filter) masks known secret values and fields matching configured patterns (`*_TOKEN`, `*_KEY`, `authorization` headers, etc.).
- Skills/nodes declare which secrets they need (`env.vars[].secret`); preflight verifies availability without printing values.

```yaml
runtime:
  secrets:
    provider: env                 # env | dotenv | keychain | <custom>
    redact:
      patterns: ["(?i)token", "(?i)secret", "(?i)password"]
      headers: ["authorization", "cookie"]
```

## 9. Run lifecycle (sequence)

```
runGraph()
  ├─ emit run.start; open root OTel span
  ├─ deep preflight (skills env; fail fast)         [skill.preflight]
  ├─ load checkpoint if threadId exists             [checkpoint.load]
  ├─ for each superstep (LangGraph drives):
  │    ├─ for each active node:
  │    │     hooks(node:before) → [retry/timeout]{ span: node.run } → hooks(node:after)
  │    │     emit node.start / node.output / node.end (or node.error)
  │    │     apply state update via reducers         [state.update]
  │    │     write checkpoint                         [checkpoint.write]
  │    ├─ evaluate edges/branches                     [edge.taken / router.decision]
  │    └─ if interrupt raised → persist + surface     [interrupt.raised] → return interrupted
  ├─ emit usage totals
  └─ emit run.end (or run.error / run.aborted); close span
```

## 10. Failure semantics

| Failure | Default behavior | Configurable |
|---|---|---|
| Node throws after retries | `run.error`, non-zero exit, last checkpoint retained | `on.error: continue/route/fail` |
| Skill preflight unmet | fail before running (no side effects) | error vs warn for `optional` deps |
| Provider/tool error | counts as node error (subject to retry) | per-node retry |
| Budget exceeded | `interrupt`/`fail`/`warn` | `runtime.budget.onExceed` |
| Interrupt unresolved (CI) | `status: interrupted`, exit code reserved for it | `onInterrupt` policy |
| Sink/hook (observe) error | isolated; logged as internal diagnostic | `hooks.onError: isolate/fail` |

Deterministic, documented exit codes (see [09 — CLI](./09-cli.md#5-exit-codes)) make flowgraph safe to gate CI on.
