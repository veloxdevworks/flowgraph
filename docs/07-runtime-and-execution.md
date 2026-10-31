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
| `sqlite` | `@flowgraph/checkpoint-sqlite` | desktop/local, single-machine CI artifact (a `.db` file) |
| `postgres` | `@flowgraph/checkpoint-postgres` | shared/durable, multi-worker (later milestone) |
| custom | pass a `BaseCheckpointSaver` instance to `compileGraph` | bring your own (Redis, S3, etc.) |

`runtime.checkpoint.backend` must be `memory`, `sqlite`, or `postgres`; anything else is a load-time schema error. `sqlite` and `postgres` need the host to supply a saver (the CLI does this); `compileGraph` without one throws instead of falling back to memory. Long-term memory (`runtime.memory`, and `runtime.store.backend: sqlite|postgres`) lives in the checkpoint database and follows the same rule; the CLI supplies it for sqlite (see [05 — State and data §8](./05-state-and-data.md)).

```yaml
runtime:
  checkpoint:
    enabled: true
    backend: sqlite
    path: ".flowgraph/checkpoints.db"
    namespace: "{{ metadata.name }}"     # default
    retention:
      maxCheckpoints: 40                 # positive integer; newest checkpoints kept on each branch
      maxInterruptPoints: 8              # non-negative integer; extra interrupt/resume points outside that window
      finishedTtl: null                  # opt-in: delete completed threads after this
      maxFinishedThreads: null           # opt-in: cap how many completed threads are kept
      dedupeChannels: true               # store each channel version once
      vacuum: auto                       # sqlite incremental vacuum; "always" is a blocking VACUUM
```

Every superstep writes a checkpoint and its pending writes. Without a limit, a long-lived thread keeps that history forever, and sqlite repeats every channel value inside every checkpoint. `runtime.checkpoint.retention` bounds a thread this process runs. The default keeps the newest 40 checkpoints on each branch, plus up to 8 interrupt or resume points outside that window. `maxCheckpoints` must be a positive integer and `maxInterruptPoints` a non-negative integer; anything else is rejected. The leaf of a branch is always kept. Prune deletes only checkpoints it has already listed and chosen to drop, so pending writes for a checkpoint that is not stored yet stay. A run marks its thread active before it reads checkpoint state. A sweep skips a thread this process is still running or has parked at an interrupt, and on a shared database it deletes only when the thread row is still that finished record. If the process stops after the active mark and before the checkpoint row is written, the thread stays active and is not swept until a later run updates it or `deleteThread` is called. `deleteThread()` always deletes, including a parked thread. One run finishing does not clear another run's parked interrupt. A resumed run releases the park from its earlier pause, so a thread that stops at several interrupts can be swept after the last run finishes. Resuming a checkpoint id that is not stored returns status `error` with `error.code` `CHECKPOINT_PRUNED`. When retention is on, the message says the checkpoint is missing or was pruned. That error does not change the thread's saved status. Completed threads are not deleted unless `finishedTtl` or `maxFinishedThreads` is set. Paused, interrupted, aborted, and errored threads are never deleted. Threads this process did not record (older files, or a graph with `retention: false` sharing the database) are left in place. Set `retention: false` to keep the full history for that graph.

A graph's retention overrides the host default field by field. Host options: `createSqliteCheckpointer({ path, retention })`, `openSqliteBackend`, `createPostgresCheckpointer`, `openPostgresBackend`, `compileGraph(spec, { checkpointRetention })`, and on the server `checkpointRetention` / `FLOWGRAPH_CHECKPOINT_RETENTION`. Postgres already versions channel blobs; retention deletes versions no remaining checkpoint references. Sqlite leaves values of 4 KB or less in the checkpoint row. A larger value is stored once in `fg_checkpoint_blobs` when a later checkpoint repeats that version, and that row is stamped `fg-checkpoint-v1`. Pending writes are kept on branch tips and interrupt pins. A checkpoint drops its writes only after a successor row is stored; writes flushed before that row lands stay, so resume can still read the interrupt and the agent replay snapshot stored on it. Deleting a finished thread removes its checkpoints and its `fg_memory_threads` binding. It leaves `fg_thread_owners`, `fg_memory_items`, and `fg_memory_ops` in place, so the thread id stays claimed by the principal that started it and memory replay records stay for the memory sweeper. Reads fill state back in even if dedupe or retention is later turned off. A stock saver or an older flowgraph fails that read instead of returning empty state. A checkpoint schema newer than this build is refused when the file is opened. `fg_memory_*` items are left alone; deleting a thread removes its `fg_memory_threads` binding.

`node scripts/checkpoint-growth-bench.mjs --runs 2000` runs the same small graph with and without retention and prints file size, row counts, and byte totals. Set `FLOWGRAPH_TEST_POSTGRES_URL` to include Postgres.

The adapter interface wraps LangGraph's `BaseCheckpointSaver` (`put`, `putWrites`, `getTuple`, `list`) so any LangGraph checkpointer is usable, and ours add lifecycle events (`checkpoint.write/load`) and the `checkpoint:beforeWrite` hook (for redaction/transform).

### Time travel & inspection

Because every superstep is checkpointed, the runtime exposes:

```ts
const history = await compiled.getStateHistory(threadId);                  // list of StateSnapshots
await compiled.resumeFrom({ threadId, checkpointId, resume: true });       // fork/replay from a point
await compiled.step({ threadId });                                         // run exactly one superstep, then pause
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
3. **`hitl` nodes** — first-class approve / question / choice / form / review gates in the graph topology.
4. **`workshop` nodes** — one-shot facilitated session contract (agenda + output schema); the client owns the conversation (voice, text, or form) and resumes with `{ output, transcript, coverage, endedReason }`.
5. **`ask_human` tool** — intelligent agents ask clarifying questions mid-loop (opt-in via `tools: [{ function: ask_human }]`).
6. **Service tools** — agents discover and manage background services in the current thread (`list_services`, `service_status`, `start_service`, `stop_service`, `restart_service`). Services started via tools share the same registry/cleanup as the `service` node.
7. **`wait` nodes** — durable pauses for time, signals, conditions, or inbound webhooks (`webhook: true`).

### Interrupt kinds

Each interrupt carries a **kind** so operators know how to answer:

| Kind | Used by | Resume value shape |
|---|---|---|
| `approval` | `hitl` approve mode, tool gates, `permission: ask` | `{ approved: true \| false }` |
| `question` | `hitl` question mode, `ask_human` | `{ answer: "..." }` |
| `choice` | `hitl` choice mode, `ask_human` with choices | `{ choice: "..." }` |
| `form` | `hitl` form mode | schema-validated object |
| `review` | `hitl` review mode | `{ decision, feedback? }` |
| `workshop` | `workshop` node | `{ output, transcript, coverage, endedReason }` |
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

### Invalid answers: re-prompt, don't brick

LangGraph persists every value a task's `interrupt()` calls consumed and replays them in order when the node re-runs. A node that **throws** after a bad answer would therefore replay that bad answer on every later resume and the thread would be stuck.

`hitl` (choice / form / review) and `workshop` nodes instead validate inside a re-prompt loop (`interruptUntilValid` in `@flowgraph/core`):

1. A resume value that fails validation (JSON Schema, unknown review decision, unknown choice) re-issues the **same** interrupt (same interrupt id, so map-keyed resumes keep working) with extra fields in `payload.data` and on `InterruptInfo`: `validationError`, `attempt` (rejected answers so far), `maxAttempts`. The run returns `status: "interrupted"` as usual; the CLI prints `Previous answer rejected (attempt n of N): …` before prompting again.
2. After `with.maxResumeAttempts` rejected answers (default **3**) the interrupt is raised once more with `exhausted: true`. The engine reports the run as `status: "error"` with a `ResumeAttemptsExhaustedError` (`code: "RESUME_ATTEMPTS_EXHAUSTED"`), emits `node.error` + `run.error`, and returns the pending `interrupts`.
3. The thread is **not** corrupted: `getState(threadId)` still lists the node in `next` and the exhausted interrupt (with its last `validationError`) in `interrupts`. A later valid `resume` — from the same process or after a restart against a durable checkpointer — completes the node. Each further invalid answer fails the run again the same way.

Sibling interrupts are independent: in a `map` fan-out, a bad answer for one item re-prompts only that item; valid answers for other items in the same id-keyed resume are kept.

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
