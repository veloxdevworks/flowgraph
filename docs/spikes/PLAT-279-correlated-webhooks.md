# PLAT-279 — signed, correlated webhook verification

Verified locally on November 13, 2026 with Node v25.2.1, macOS arm64. The PR is
stacked on the parallel-webhook parent at
`e6a5bf0ce3b3cbb298350e802b35e2574b0376ac` (PR #38).

## Behavior

Run-level opaque correlation pairs can be declared in `runtime.correlation` or
`compiled.run({ correlation })`; a webhook wait can refine them through
`with.webhook.correlation`. Run-level pairs are checkpointed in reserved engine
state, omitted from public state, and are not added to unrelated graph inputs.

`POST /webhook-events/<ingress-id>` authenticates the exact pathname, delivery id,
timestamp, and body bytes with HMAC-SHA256 before matching correlation pairs.
Optional node/interrupt selectors disambiguate parallel gates. An optional bearer
token is enforced in addition to the signature. Legacy raw callback URLs cannot
bypass a configured signed ingress. Auth, envelope, ambiguity, and schema
rejections leave both the gate and delivery id retryable.

The local-filesystem journal acquires a durable thread lock and fsyncs an
exclusive delivery receipt before invoking a resume. Completed deliveries replay
their original response. The same id with different request bytes is rejected.
Manual API invocations and deadline timers share this coordination boundary;
stale interrupt registrations are checked against the latest checkpoint while
the lock is held. Admission failures emit nonterminal diagnostics, so a competing
API request cannot falsely finish observers of the invocation holding the lock.

Signed deadlines are armed after durable lock release, are restored by a fresh
runtime's `getState`, and expire only due interrupt ids. Sibling callbacks and
human gates remain pending. The explicit read-only
`getState(threadId, { applyWaitTimeouts: false })` does not arm or apply deadlines.

## End-to-end evidence

Run after building the workspace:

```sh
node scripts/verify-correlated-webhooks.mjs
```

The [captured JSON](./PLAT-279-correlated-webhooks.json) records six passing
scenarios using built packages, real signed HTTP requests, actual Node child
processes, SQLite checkpoints, and SIGKILL:

| Scenario | Observed result |
| --- | --- |
| Bad signature, expired timestamp, and invalid payload | 401 / 401 / 422; no effects; original wait remains usable. |
| Restart before callback, after partial reply, and after completion | Correlation and checkpoints restore; duplicate receipts replay; each downstream effect occurs once. |
| Two runs sharing an external id | Broad match returns 409; an additional opaque key selects only the intended run. |
| Twelve overlapping deliveries across two processes | One first-gate effect; stale old-gate attempts fail; the distinct second event completes once. |
| SIGKILL while an effect is in flight | Same id returns 409 `delivery_in_doubt`; a new event naming the already-consumed gate returns 404 `not_waiting`; effect count stays one. |
| Real CLI run, kill, then `resume --listen --json` | Restores without submitting an answer, replays the old receipt, completes the second gate, and keeps stdout valid JSONL. |

When a crash leaves a still-pending matching gate, another event on the locked
thread instead returns 409 `thread_busy`; this boundary is covered by the
pending-claim regression tests. A host explicitly starts its configured ingress
for receipt-only recovery when no webhook interrupt remains to create a listener.

## Regression validation

| Check | Local result |
| --- | --- |
| Root build, concurrency 2, read-only cache | 16 tasks passed. |
| Root typecheck, concurrency 2, read-only cache | 30 tasks passed. |
| Focused core webhook, journal, wait, hook, and output suites | 106 tests passed; the subsequently added future-deadline correlation suite also passed all 30 tests. |
| Complete CLI suite | 87 passed, 1 skipped. |
| Complete specification suite | 76 passed. |

The full local core run exercised 1,219 tests: 1,211 passed, 5 skipped, and 3
failed. Two empty-output/veto compatibility regressions exposed by that run were
fixed and their affected suites passed on rerun. The remaining failure is the
previously documented macOS worktree case at `src/worktree.test.ts:129`
(`honors runtime.worktrees.root`); this change does not alter worktree handling.
CI is enabled for stacked PR bases so the PR receives the full Node 22/Linux
build, typecheck, test, and Postgres integration checks.

Additional focused cases cover changed body bytes after signing, cross-ingress
path replay with a shared signing key, safe rejection logs, error-message privacy
in HTTP receipts, shared-thread API exclusion, early timers, slow receipt writes,
future-deadline recovery, overdue parallel siblings, and cross-process exclusive
journal claims. Receipt files do not contain callback payloads or signing keys.

One build attempt failed because the host filesystem exhausted free space;
read-only-cache builds were used after space recovered. No user source or
unrelated caches were removed.

## Operational boundaries

- Every runtime coordinating a checkpoint thread must share the same ingress id
  and journal directory on a filesystem with atomic directory/link/rename and
  working `fsync` semantics. This is not a distributed database ingress service.
- An unresolved claim never expires automatically. Stop the participating
  runtimes and reconcile checkpoint state and downstream effects before recovery.
  At-most-once invocation does not guarantee completion after a crash.
- Hosts restore known waiting threads; compilation does not discover them.
  Correlation updates after run start and automatic receipt garbage collection
  are not implemented.
- The CLI retains its listener after completion; Ctrl-C stops it. The evidence
  records this existing behavior explicitly.

See the [runnable example and wire protocol](../../examples/correlated-webhooks/README.md).
