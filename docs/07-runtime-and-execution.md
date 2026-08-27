# 07 — Runtime & Execution

This doc covers what happens when a compiled graph runs: compilation handoff, checkpointing, durability, human-in-the-loop (HITL), retries/timeouts, secrets, and the CI-vs-desktop split. The runtime stays thin over LangGraph.js, adding the cross-cutting machinery from [06 — Events & Hooks](./06-events-and-hooks.md).

## 1. From compiled graph to run

`compileGraph()` returns a `CompiledGraph`. Execute it with **`compiled.run`** (there is no `runGraph` helper):

```ts
const result = await compiled.run({
  input: { issue },             // initial state (validated against channels)
  threadId: "issue-123",        // checkpoint/resume key; auto-generated if omitted
  signal,                       // AbortSignal → run.aborted
  onInterrupt: "prompt",        // override env policy for this run
});
// result: { state, status: "completed" | "interrupted" | "paused" | "error", interrupts?, runId, durationMs }
```

Under the hood flowgraph calls LangGraph's `invoke`/`stream` with `{ configurable: { thread_id } }`, wraps each node in the middleware stack, and translates LangGraph stream chunks into flowgraph events.

## 2. Execution modes

| Mode | API | Use |
|---|---|---|
| **invoke** | `compiled.run(...)` → final result | CI jobs, scripts: run to completion (or first interrupt) |
| **stream** | `compiled.stream(...)` → async iterable of events | live UIs, CLI TTY rendering, progress |
| **resume** | `compiled.resume({ threadId, resume })` | answer a HITL interrupt |
| **continue** | `compiled.continueRun({ threadId })` | continue a paused/checkpointed thread (not HITL) |
| **step** | *planned* (`CompiledGraph.step`) | advance one superstep (debugging, time-travel) |

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

Pass a LangGraph `BaseCheckpointSaver` instance into `compileGraph({ checkpointer })`. YAML `backend: sqlite|postgres` **does not** construct a saver — compile **throws** unless an instance is injected (the CLI injects SQLite) or you pass `checkpointer: "none"` (subgraph embedding). `checkpoint.write` / `checkpoint.load` are reserved `EventType`s and are **not emitted** today. The `checkpoint:beforeWrite` hook exists for redaction/transform.

### Time travel & inspection

Because every superstep is checkpointed, the runtime exposes:

```ts
const history = await compiled.getStateHistory(threadId);   // list of StateSnapshots
const snap = await compiled.getState(threadId);
// resumeFrom(checkpointId) is planned — not shipped
```

CLI resume is `flowgraph resume --thread <id>`, which calls `compiled.resume`.

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
5. **Service tools** — agents discover and manage background services in the current thread (`list_services`, `service_status`, `start_service`, `stop_service`, `restart_service`). Services started via tools share the same registry/cleanup as the `service` node.
6. **`wait` nodes** — durable pauses for time, signals, conditions, or inbound webhooks (`webhook: true`).

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
const result = await compiled.resume({
  threadId: "release-42",
  resume: { approved: true, editedNotes: "..." },   // becomes the interrupt()'s return value
});
```

When several branches interrupt in the same superstep, `result.interrupts` lists every pending gate. Resume with a **map keyed by interrupt id** (the `id` on each `InterruptInfo`) so each `interrupt()` call receives its own value:

```ts
const result = await compiled.resume({
  threadId: "fan-out-1",
  resume: {
    [interrupts[0].id]: { approved: true },
    [interrupts[1].id]: { answer: "option B" },
  },
});
```

A scalar / object resume (anything whose keys are not interrupt ids) is broadcast the same way a single-interrupt resume is. Answering only a subset of the map leaves the remaining gates pending — they re-surface on the next `interrupt.raised`.

Static breakpoints (`runtime.hitl.breakpoints.before` / `after`) pause with a synthetic `breakpoint:…` interrupt and no `interrupt()` call. `compiled.resume()` continues past those with LangGraph's null input; the resume payload is ignored.

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

`compiled.run({ signal })` wires an `AbortSignal` through nodes (`ctx.signal`), provider calls, and HTTP. On abort: in-flight side-effecting nodes get the signal, a checkpoint is written when a saver is attached, and `run.aborted` is emitted. `Ctrl-C` in the CLI maps to this. `pauseSignal` yields `status: "paused"` so `continueRun` can pick up the thread.

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
compiled.run()
  ├─ emit run.start
  ├─ CLI: skill/agent preflight before compile      [skill.preflight when a skill runs]
  ├─ LangGraph loads checkpoint if a saver + threadId exist
  ├─ for each superstep (LangGraph drives):
  │    ├─ for each active node:
  │    │     hooks(node:before) → [retry/timeout] → hooks(node:after)
  │    │     emit node.start / node.output / node.end (or node.error)
  │    │     apply state update via reducers
  │    │     LangGraph writes a checkpoint when a saver is attached
  │    ├─ evaluate edges/branches                     [router.decision when a router runs]
  │    └─ if interrupt raised → persist + surface     [interrupt.raised] → return interrupted
  └─ emit run.end (or run.error / run.aborted / run.paused)
```

Reserved event types that are **not emitted** today: `state.update`, `edge.taken`, `checkpoint.write`, `checkpoint.load`. Planned is fine; do not subscribe as if they fire. OTel spans are **not** opened by the CLI — attach `otelSink()` from `@veloxdevworks/flowgraph-observability-otel` yourself (`--otel` is unwired).

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
