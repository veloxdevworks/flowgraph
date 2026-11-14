# PLAT-281 — progress event verification

Verified on November 13, 2026 with Node v25.2.1 on macOS arm64, using the built
packages and actual child processes / HTTP clients. No model keys or external
services are required by the end-to-end harness.

The runtime now emits `state.update` for applied public channel changes and
`edge.taken` for selected transitions. See the [event contract](../06-events-and-hooks.md#state-and-transition-progress-plat-281)
for reducer, baseline, scope, and dispatch semantics.

## End-to-end evidence

Run after building:

```sh
pnpm build
node scripts/verify-progress-events.mjs
```

[Captured JSON evidence](./PLAT-281-progress-events.json) comes from that script.
It asserts each scenario and exits nonzero on a failed assertion or deadline.
Temporary graph stores / SQLite files are removed and all local HTTP readers and
servers close at the end.

| Surface | Verified behavior |
| --- | --- |
| Built programmatic API / `CompiledGraph.stream` | Two parallel nodes append to one channel. Exactly one state update carries the combined post-reducer result; all four selected edges appear, events carry the correct thread, and the stream delivers `run.end` and closes. A second stream reuses the same graph/thread, pauses its consumer until execution ends, then receives only its own queued progress and terminal event without replaying the first invocation. |
| Real CLI JSONL | The zero-key quickstart runs in a child process. Its two public state changes and all three graph transitions appear on stdout; initial input is not re-emitted, and the process exits 0 naturally. |
| Durable CLI resume | One CLI process runs to a signal interrupt and exits 3 with SQLite checkpoints. A different CLI process resumes it and exits 0. The completed predecessor's state and START edge are not replayed; only the resumed gate's change and outgoing END transition appear. |
| Authenticated HTTP + SSE | POST a graph through REST, observe its initial progress through SSE, resume the signal gate through REST, and observe its final progress and terminal event on the same SSE connection. |
| Replay / journal | Reconnect with `Last-Event-ID`; the replay exactly matches the journal after that sequence. Progress events from the journal match the live SSE events, and final state contains the resumed answer. |

SSE attaches with `Last-Event-ID: -1` initially so events emitted between the
start response and connection establishment are replayed. The ordinary REST SSE
endpoint is intentionally long-lived; the harness cancels its readers after the
expected terminal event rather than expecting that endpoint to close itself.
The compiled API stream is separately verified to close on completion.

## Regression validation

- Root `pnpm build`: 16 successful tasks.
- Root `pnpm typecheck`: 30 successful tasks.
- Core: 1,169 passed, 5 skipped, one pre-existing macOS failure below.
- CLI: 86 passed, 1 skipped.
- Server: earlier full pass of 293 passed, 9 skipped (including database-gated integration tests). A final contended rerun and its focused successful retry are recorded below.
- New focused progress suite: 18 passed.
- End-to-end harness: all four scenarios passed against the rebuilt packages.
- An independent code review identified a message serialization mismatch; the
  corrected implementation and AIMessage/Buffer regression were reviewed again
  with no remaining actionable findings.

The new focused tests cover parallel append reducers, no-op / initial-input /
reserved-state suppression, hook-transformed writes, failed attempts, signal
interrupt/resume, static breakpoints, concurrent thread attribution, actual
conditional/router/hook dispatch, loop iterations, joins, skipped/failed nodes,
map internals, child graph scope, stream termination, canonical message/Buffer
serialization, and top-level / nested partially completed supersteps.

The only full-core failure is the previously recorded
`packages/core/src/worktree.test.ts:129`, `honors runtime.worktrees.root`
(expected `completed`, received `error`). It is unrelated to progress events and
also occurs on the parent checkout. The full suite therefore exits nonzero; it
is not reported as a completely green run. Postgres integration and the
Node 22/Linux CI matrix are not claimed as locally verified by this report.

A final server-suite rerun after the last baseline/serialization changes took
420.93 seconds under severe shared-host contention (the earlier run took 28.30
seconds). It ended with 282 passed, 9 skipped, and 11 tests failing at their
existing five-second deadlines; one timed-out shutdown case also reported a
teardown `ENOTEMPTY`. No assertion failure was reported. A focused retry of all
five affected suites with one worker passed **53 tests, 2 skipped**:

```sh
pnpm --filter @flowgraph/server exec vitest run \
  src/run-service-host-exec.test.ts src/run-service-identity.test.ts \
  src/run-service-shutdown.test.ts src/run-service.test.ts \
  src/worker-placement.test.ts --maxWorkers=1
```

The final rebuilt HTTP/SSE/journal end-to-end harness also passed after the last
source corrections. The focused retry resolves the affected suite failures;
the contended broad run is not represented as green.

## Stream lifecycle follow-up

The initial implementation exposed existing event-stream bugs: a reader could
hang after replaying an already-completed buffer, completion during a slow
consumer's buffered replay could be missed, and a second `compiled.stream()`
could replay the prior invocation. Focused regressions reproduced all three
before the fix. The stream lifecycle now subscribes before replay, checks the
terminal event actually delivered, and starts each compiled stream from its own
execution admission with only new events for that thread. Pre-execution failure
throws locally and unsubscribes rather than broadcasting a terminal event into
another owner's stream.

The follow-up passed **23 focused tests** (18 progress + 5 stream lifecycle), a
fresh core build including declarations, core typecheck, and the rebuilt
end-to-end harness captured above. These checks include trailing post-terminal
diagnostics, slow consumers, repeated calls, thread filtering, and local input
rejection. No additional broad local suite was run after this focused repair;
the earlier full-suite results above retain their stated scope. The earlier
head's Node 22/Linux CI passed build, typecheck, and full tests with Postgres;
the updated PR head runs its own CI.
