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
      activeTtl: 7d                      # with deletion on: an active thread idle this long is treated as abandoned
      dedupeChannels: true               # store each channel version once
      vacuum: auto                       # sqlite incremental vacuum; "always" is a blocking VACUUM
```

Every superstep writes a checkpoint and its pending writes. Without a limit, a long-lived thread keeps that history forever, and sqlite repeats every channel value inside every checkpoint. `runtime.checkpoint.retention` bounds a thread this process runs. The default keeps the newest 40 checkpoints on each branch, plus up to 8 interrupt or resume points outside that window. `maxCheckpoints` must be a positive integer and `maxInterruptPoints` a non-negative integer; anything else is rejected. The leaf of a branch is always kept. Prune deletes only checkpoints it has already listed and chosen to drop, so pending writes for a checkpoint that is not stored yet stay. A run marks its thread active before it reads checkpoint state. A sweep skips a thread this process is still running or has parked at an interrupt, and on a shared database it deletes only when the thread row is still that finished record. If the process stops while the thread is marked active (a crash, a killed container), the row stays active until a sweep treats it as abandoned; see [Abandoned active threads](#abandoned-active-threads). `deleteThread()` always deletes, including a parked thread. One run finishing does not clear another run's parked interrupt. A resumed run releases the park from its earlier pause, so a thread that stops at several interrupts can be swept after the last run finishes. Resuming a checkpoint id that is not stored returns status `error` with `error.code` `CHECKPOINT_PRUNED`. When retention is on, the message says the checkpoint is missing or was pruned. That error does not change the thread's saved status. A run reads the thread's saved status and marks it active in one step, before it reads checkpoint state. If the run stops before it starts, it writes that status back only when the row is still the mark from that step, and it releases its guard token without parking. If the saved status was already active, that write-back does not happen. A status written after that step is left in place. Completed threads are not deleted unless `finishedTtl` or `maxFinishedThreads` is set. Paused, interrupted, aborted, and errored threads are never deleted. Threads this process did not record (older files, or a graph with `retention: false` sharing the database) are left in place. Set `retention: false` to keep the full history for that graph.

A graph's retention overrides the host default field by field. Host options: `createSqliteCheckpointer({ path, retention })`, `openSqliteBackend`, `createPostgresCheckpointer`, `openPostgresBackend`, `compileGraph(spec, { checkpointRetention })`, and on the server `checkpointRetention` / `FLOWGRAPH_CHECKPOINT_RETENTION`. On Postgres a run's active mark takes a transaction-scoped advisory lock on the schema and thread id (`activeMarkLockKey(schema, threadId)`, hashed with `hashtextextended`), so two marks on one thread serialize even before its row exists, and savers on different schemas of one database do not wait on each other. Postgres already versions channel blobs; retention deletes versions no remaining checkpoint references. Sqlite leaves values of 4 KB or less in the checkpoint row. A larger value is stored once in `fg_checkpoint_blobs` when a later checkpoint repeats that version, and that row is stamped `fg-checkpoint-v1`. Pending writes are kept on branch tips and interrupt pins. A checkpoint drops its writes only after a successor row is stored; writes flushed before that row lands stay, so resume can still read the interrupt and the agent replay snapshot stored on it. Deleting a finished thread removes its checkpoints and its `fg_memory_threads` binding. It leaves `fg_thread_owners`, `fg_memory_items`, and `fg_memory_ops` in place, so the thread id stays claimed by the principal that started it and memory replay records stay for the memory sweeper. Reads fill state back in even if dedupe or retention is later turned off. A stock saver or an older flowgraph fails that read instead of returning empty state. A checkpoint schema newer than this build is refused when the file is opened. `fg_memory_*` items are left alone; deleting a thread removes its `fg_memory_threads` binding.

`node scripts/checkpoint-growth-bench.mjs --runs 2000` runs the same small graph with and without retention and prints file size, row counts, and byte totals. Set `FLOWGRAPH_TEST_POSTGRES_URL` to include Postgres.

The adapter interface wraps LangGraph's `BaseCheckpointSaver` (`put`, `putWrites`, `getTuple`, `list`) so any LangGraph checkpointer is usable, and ours add lifecycle events (`checkpoint.write/load`) and the `checkpoint:beforeWrite` hook (for redaction/transform).

#### Abandoned active threads

With thread deletion on (`finishedTtl` or `maxFinishedThreads` set), a sweep treats an `active` thread row as abandoned once its last activity is older than `activeTtl` (default `7d`; a duration or milliseconds; `null` turns this off). Activity is the active mark a run takes at start and every checkpoint the run writes, so there is no heartbeat: a run that keeps checkpointing refreshes the row as it goes and is never abandoned, however long it runs in total. An abandoned row becomes a finished thread as of its last activity, and `finishedTtl` and `maxFinishedThreads` then decide when it is deleted (with the default `activeTtl` and `finishedTtl: 14d`, a crashed run's thread is deleted 14 days after its last checkpoint; with `finishedTtl: 3d` it is deleted at the first sweep after it has been idle for 7 days). The sweep runs when a saver opens (`prepare()` on sqlite, `setup()` on Postgres) and after finished runs, so a restarted host cleans up what a crashed one left.

The row records the run's own `activeTtl`, `finishedTtl`, and `maxFinishedThreads` when it is marked or checkpointed, so on a shared database another host applies the graph's policy, not its own. Rows stamped before checkpoint schema 4 have no recorded policy and use the sweeping host's. A sweep never reclaims a thread the sweeping process is running itself; the in-memory saver holds every run it has in flight, so there reclaiming only affects a row marked outside a run. Only `active` rows are reclaimed, so another host can see a run on a shared database as alive only through the row. While a run waits in process for an answer (`onInterrupt: "prompt"` or `"approve"` asking `resolveInterrupt`, at a node interrupt or a breakpoint), its row is stored `paused` under the run's own mark, so no host reclaims it however long the answer takes. When the answer comes, the row goes back to `active` with a fresh timestamp, but only if it is still that run's paused row. If the process stops while waiting, the row stays `paused`, like an interrupt with `onInterrupt: "fail"`: it is never deleted by retention and the thread can be resumed. Like a park, a wait pins the thread's head, so it takes one of the `maxInterruptPoints` pins. If the run cannot store the row as waiting, it stops with `error.code` `THREAD_WAIT_NOT_RECORDED` before asking, instead of waiting where another host could reclaim the thread; it does the same if it cannot store the row as active again after the answer. The stopped run then tries to park the row as `paused`. If that write also fails (the database is down), the row stays `active` and is reclaimed after `activeTtl` like a crashed run; the failed park is attached to the run error as `error.parkError`. If the row is no longer this run's when it starts waiting or when the answer comes (another run resumed the thread, a sweep reclaimed it, or it was deleted), the run stops with `error.code` `THREAD_MOVED_ON` without applying the answer and without writing its own status over the row. Neither error changes the checkpoints, so a thread that was not deleted can still be resumed. Nothing stops two hosts from resuming one thread at the same moment, so do not resume a `paused` thread elsewhere while a process may still be waiting on it. The update matches the row as the sweep listed it (status, timestamp, and mark), so a run that marked or checkpointed in the meantime keeps its row. A run that stopped and wakes up later cannot undo a newer run: its restore only matches its own mark and the time of that mark, and a checkpoint write keeps the current mark on an active row instead of clearing it. A row written after the mark is not rolled back; if that run never comes back, a later sweep reclaims it as abandoned. Schema 4 also adds a partial index on active rows' `updated_at`, and the sweep lists only active rows already past their limit, so it does not scan every thread row.

The trade-off: a run on another host whose single step runs longer than `activeTtl` without writing a checkpoint is indistinguishable from a crashed one. Its thread can be finished and, if the finished rules allow, deleted while that step is still running. Keep `activeTtl` well above your longest step (not your longest run), or set it to `null` and remove abandoned threads with `deleteThread`. Checkpoint schema 4 adds `active_ttl_ms` to `fg_checkpoint_threads` on sqlite and Postgres.

Upgrading a shared database: the first new host migrates it to schema 4 under the migration lock, and concurrent openers wait for it. An older flowgraph process that already had the database open keeps running and sweeping afterwards, because the new column is nullable and the new index does not change its queries. An older flowgraph that opens the database after the migration refuses it (`checkpoint schema version 4 is newer than this flowgraph supports`), so do not roll back by restarting old hosts against a migrated database. Until every host is upgraded, rows written by old hosts carry no recorded policy (the sweeping host's `activeTtl` applies), and an old host's run waiting for an answer in process keeps its row `active`, so a new host can reclaim it after `activeTtl`. Finish the rollout, or keep `activeTtl` above the longest human wait, while versions are mixed.

`openSqliteBackend`, `createSqliteCheckpointer`, `openPostgresBackend`, and `createPostgresCheckpointer` accept the same optional `clock` as the savers, for tests.

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
| `choice` | `hitl` choice mode, `ask_human` with choices | `{ choice: "..." }`, the choice string, or its 1-based index. A number (bare or as `choice`) is always an index; a string matches a choice first, then an index |
| `form` | `hitl` form mode | schema-validated object |
| `review` | `hitl` review mode | `{ decision, feedback? }` |
| `workshop` | `workshop` node | `{ output, transcript, coverage, endedReason }` (the node writes these plus `complete`) |
| `custom` | advanced / hook payloads | arbitrary JSON |

A falsy resume value (`false`, `null`, `0`, `""`) is applied as given, from `compiled.resume()`, the CLI's `--resume`, the server's resume endpoints, a webhook POST or `resolveInterrupt`: an approval records `approved: false`, and a choice re-prompts as invalid. With several interrupts pending, a falsy unkeyed value still answers each of them. A truthy unkeyed value is refused with `error.code` `RESUME_MAP_REQUIRED` so it cannot be applied to every gate; pass a map keyed by interrupt id instead. A missing answer is not a denial: `compiled.resume()` with no `resume` value (or `undefined`) while an interrupt is pending rejects with `error.code` `RESUME_VALUE_REQUIRED` and runs nothing, and the server answers a resume request without a `resume` key with 400 `RESUME_REQUIRED`. The same server endpoints answer a truthy unkeyed resume with 400 `RESUME_MAP_REQUIRED` when several interrupts are pending, and leave the thread interrupted.

Two limits apply to falsy answers:

- `resumeFrom()` keys a falsy answer by the interrupts pending at the latest point in the thread, not at the requested checkpoint. Resuming from a checkpoint whose interrupt was already answered replays the stored answer, whatever value you pass (truthy or falsy).
- A webhook POST answers only that webhook's own interrupt, whether the body is truthy or falsy.

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

When several interrupts are pending, a scalar or object whose keys are not interrupt ids is refused with `error.code` `RESUME_MAP_REQUIRED`. A map that includes a key that is not a pending interrupt id is refused with the same code, and the error names the unknown or extra id(s). The same rules apply to `flowgraph resume --resume`. Answering only a subset of the map leaves the remaining gates pending — they re-surface on the next `interrupt.raised` — and any in-process webhook URL for an unanswered gate stays listening. After a wait deadline has passed, a later `resume()` still applies the caller's answers for gates that are not overdue and times out only the overdue interrupt(s).

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
3. Resume programmatically: `flowgraph resume <graph> --thread <id> --resume '{"answer":"..."}'` (or a map keyed by interrupt id when several gates are pending)

The same flow is available via the programmatic API: `compiled.getState(threadId)` → read `interrupts` → `compiled.resume({ threadId, resume })`.

For `wait` nodes with `with.webhook: true`, the CLI instead keeps the process
listening for an inbound POST, including under `--on-interrupt fail`. A normal
`hitl` node with `onInterrupt: webhook` does not create an HTTP route. After a
restart against a durable checkpointer, `compiled.getState(threadId)` restores
that thread's pending webhook route. See [PLAT-278](./spikes/PLAT-278-webhook-resume.md)
for the verified restart procedure and current delivery/validation limitations.

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

A node `timeout` is not a cancel. The attempt fails with `Node timed out`, and the run fails unless a retry succeeds or `on.error` handles it, but for most node types the timed-out work keeps running in the background, and `ctx.signal` stays the run's own, so aborting it always means the run was cancelled. That keeps a timed-out `image` or `video` job alive for a retry to re-attach to, and a `service` able to finish a graceful stop.

A node type that can stop cleanly declares `capabilities.stopsOnTimeout`; today that is only `demo`. Its `ctx.signal` is per attempt and also aborts on timeout, with the timeout error as `signal.reason` (`isTimeoutError(reason)` tells it from a cancelled run). The engine waits up to 20 seconds for the attempt to stop before it retries or reports the failure, so the two don't overlap. Nothing retries once the run itself is cancelled.

## 6a. Node placement

A node with [`runsOn`](./02-graph-spec.md#runson-placement) can run on another machine. The machine that starts the run stays the **coordinator** for its whole life; a placed node is sent to a **worker** (any `flowgraph-server` with matching labels), which runs it and returns the result. Design and rationale: [ADR-0020](./adr/0020-node-placement.md).

**Resolution (at compile time, before any node runs).** For each placed top-level node:

1. If this host's labels satisfy `labels` (and `target` is unset or `local`), it runs in-process, exactly as without `runsOn`.
2. Otherwise the first topology target whose live labels match **and** whose worker preflight passes is chosen.
3. Otherwise `fallback: local` runs it in-process.
4. Otherwise `compileGraph` throws `PlacementUnsatisfiedError` (`PLACEMENT_UNSATISFIED`), naming the node, the labels it needed and what each candidate reported.

Without a `topology` and `transport` in `CompileOptions.placement`, only the local host is considered. `flowgraph run --targets <file>` supplies both ([09 — CLI](./09-cli.md#2-flowgraph-run--shipped)). A graph with no `runsOn` does none of this.

**What runs remotely.** A `subgraph` runs as its child graph (`uses:` children are inlined as `spec:`), seeded from `stateMap.in` and merged back through `stateMap.out` and the parent's reducers, exactly as in-process. Any other node runs as a one-node graph: it receives its resolved `input`, and its `outputs.<id>` result is written back through the node's own `output` (auto-save, `to`, `map`). Templates in such a node's `with` can read its `input` but not other parent state; group the node with what it needs in a subgraph if it must see more. `map` and `router` nodes cannot be placed directly; place a subgraph that contains them.

**Child thread id and reconnect.** The child run's thread id is `{parentThreadId}/{nodeId}/{attempt}` (attempt is the 1-based retry attempt). An id over 234 characters fails the node with `PLACEMENT_THREAD_ID_TOO_LONG` before anything is sent. The `{ target, childThreadId }` pair is recorded with `ctx.once` before dispatch; a node that runs again finds the record and **attaches** to the child instead of dispatching again, and a dispatch the worker answers with "already exists" also attaches. The same child id is never dispatched twice. Each retry is a new attempt and so a new child id.

**Events.** The child's events are forwarded into the parent stream nested under the placed node (`scope.parentSpanId` is the node id, as for in-process subgraphs). The child's own `run.*` and interrupt events are not forwarded, and for a non-subgraph node neither are the wrapper node's start/end events, which the parent already emits. Every forwarded event, and the placed node's own `node.start` / `node.end`, carries `scope.placement = { target, childThreadId }`.

**Outcomes.**

| Child ends | Node fails with | Notes |
|---|---|---|
| `completed` | n/a | Final state is merged as above |
| `error` | `REMOTE_NODE_FAILED` | Message names the target and includes the child's error. Normal `retry` applies |
| transport failure (unreachable, stream lost past its reconnects) | `REMOTE_NODE_FAILED` | The next attempt matches that node again and may pick another target |
| `cancelled`, not by this run | `REMOTE_NODE_CANCELLED` | |
| `interrupted` (a gate inside the child) | `PLACEMENT_GATE_UNSUPPORTED` | The paused child is cancelled. Not retried |

**Artifacts.** State holds `Artifact` records ([05](./05-state-and-data.md)), never bytes, so the files move separately, addressed by `sha256` (ADR-0020 section 10). Only artifacts that cross the boundary move; files a node writes and does not return stay on the worker.

- **Stage in (coordinator, before dispatch).** Every `Artifact` record anywhere in the child's input (the seeded child input of a subgraph; the node's resolved input for a wrapped node) is resolved in the coordinator workspace, hashed if it has no `sha256` (streamed), and checked with `HEAD /worker/artifacts/:sha256`. Missing blobs are streamed up with `PUT`; blobs the worker already has are not sent again. The dispatched input carries a **staged reference** instead of the record: `{ ...record, path: "fg-staged:<sha256>/<basename>", staged: true, sha256 }`. Nothing is sent to the worker until every file is resolved, so a missing file fails the node first. A reconnect to a recorded dispatch stages nothing.
- **Materialization (worker, when the run starts).** The server copies each referenced blob to `<workspace>/.flowgraph/artifacts/<childThreadId>/staged/<sha256>/<basename>` and hands the nodes an ordinary record with that workspace-relative `path`. A sha the worker lacks refuses the start (422 `ARTIFACT_NOT_STAGED`), which surfaces as `REMOTE_NODE_FAILED`.
- **Stage out (coordinator, after `completed`).** `Artifact` records in what flows back into the parent (the values `stateMap.out` selects, the merge-back for a subgraph without it, `output.to` / `output.map` results, or `outputs.<nodeId>` for a wrapped node) are downloaded with `GET /worker/runs/:childThreadId/artifacts/:sha256` into `<workspace>/.flowgraph/artifacts/<parentThreadId>/<nodeId>/<basename>`, the sha-256 verified while streaming (written to a temp file, renamed on a match). A file of that name that already holds the same content is reused without a download; different content gets `name-1.ext`, `name-2.ext`. A record that was staged in and comes back unchanged keeps its original coordinator path. The record's `path` is rewritten (workspace-relative, with `/`), and so are the legacy absolute `path` and `extra[].path` of a `demo`-style output that lists the record under `artifacts`.
- **Not staged.** `meta.thumbnail` (a path on the other machine) is dropped on both crossings. Bare path strings and `{ path }` values that are not `Artifact` records are passed as-is. Artifacts in the child's state that do not flow back are never fetched.

| Code | When |
|---|---|
| `ARTIFACT_MISSING` | A record in the input names a file that does not exist in the coordinator workspace, is not a regular file, or resolves outside the workspace (records are graph data, so they cannot be used to upload arbitrary host files). Raised before dispatch; not retried. |
| `ARTIFACT_STAGE_IN_FAILED` | An upload or `HEAD` failed, or the worker refused the bytes (hash mismatch, size limit). The next attempt matches the node again. |
| `ARTIFACT_STAGE_OUT_FAILED` | A download failed, the bytes did not hash to the record's `sha256`, or the record has no `sha256`. The child has already run, so a node `retry` runs it again. |
| `ARTIFACT_NOT_STAGED` | (worker, HTTP 422) A staged reference names a sha the worker does not hold. |

**Abort and timeout.** Aborting the run, or a node `timeout`, cancels the child on the worker if its outcome is not yet known and stops attaching. Placed nodes declare `stopsOnTimeout` so the engine waits for that stop before retrying.

**Phase 1 limits.** Gates inside a placed subgraph are not forwarded (`flowgraph validate` warns `PLACEMENT_GATE_PHASE2`; at run time the node fails as above). `runsOn.wait` is rejected at compile time (it arrives in phase 2). Artifact staging is by `sha256` over HTTP only: uploads are not resumable and there is no shared store (`ArtifactStore`, `uri` references), so a coordinator with a short-lived workspace is not supported yet. Only `Artifact` records are staged; a bare path string that crosses the boundary is passed as-is. The parent node holds one long step while the child runs; the coordinator must stay up. Re-matching after a transport failure does not honor `fallback: local`.

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

After retries and `node:error` hooks, `on.error: fail` (the default) fails the run. `continue` and `ignore` record an issue, produce no node result, and follow normal successors while siblings finish. `route:<nodeId>` selects only the recovery path. A hook route is also exclusive. For maps, failed items have no collected value; admitted siblings finish before the map's recovery route runs. Inner item policies override the map's policy.

`runtime.recursionLimit` bounds supersteps per invocation, including parallel bookkeeping. Its default is 1,000; choose a smaller positive value for a tighter guard. Resume/continue starts a new invocation and a new counter; this is not a lifetime thread budget. Limit errors use code `RECURSION_LIMIT` and name the graph, pending nodes, and the YAML setting. `retry.retryOn` matches exact error `code`/`status`/`statusCode` values or complete message tokens (`code 7` does not match `code 75`).

| Failure | Default behavior | Configurable |
|---|---|---|
| Node throws after retries | `run.error`, non-zero exit, last checkpoint retained | `on.error: continue/route/fail` |
| Skill preflight unmet | fail before running (no side effects) | error vs warn for `optional` deps |
| Provider/tool error | counts as node error (subject to retry) | per-node retry |
| Budget exceeded | `interrupt`/`fail`/`warn` | `runtime.budget.onExceed` |
| Interrupt unresolved (CI) | `status: interrupted`, exit code reserved for it | `onInterrupt` policy |
| Sink/hook (observe) error | isolated; logged as internal diagnostic | `hooks.onError: isolate/fail` |

Deterministic, documented exit codes (see [09 — CLI](./09-cli.md#5-exit-codes)) make flowgraph safe to gate CI on.
