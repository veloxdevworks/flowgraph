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
| Built programmatic API / `CompiledGraph.stream` | Two parallel nodes append to one channel. Exactly one state update carries the combined post-reducer result; all four selected edges appear, events carry the correct thread, and the stream delivers `run.end` and closes. |
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
- Server: earlier full pass of 293 passed, 9 skipped (including database-gated integration tests). A final rerun after the last baseline/serialization changes hit fixed test deadlines under severe host contention; see the note below.
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

A final server-suite rerun was still progressing when this PR was prepared. It
hit the existing five-second test deadlines in identity, shutdown, and basic
run-service tests while filesystem/compile operations on the shared host were
taking multiple seconds. The earlier full server run passed, and the final
rebuilt HTTP/SSE/journal end-to-end harness passed after the last source fixes.
These timing failures are recorded separately, not claimed as a green final
server-suite rerun.
