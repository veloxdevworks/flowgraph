# PLAT-278 — Webhook interrupt and resume verification

Verified on 2026-11-13 against `71dc16dcd405c38f66b21f2d3879b37570967c92`
using Node v25.2.1 on macOS arm64. Ticket:
[PLAT-278](https://veloxdevworks.atlassian.net/browse/PLAT-278).

## Follow-up: URL and overlapping-request fixes

The user-requested follow-up fixes the malformed-path crash and duplicate-resume
race reported below. Invalid percent-encoding now returns HTTP 400/`invalid_path`
while the host and original pending route remain usable. The HTTP listener also
contains unexpected async handler failures instead of leaking a rejected promise.

After parsing a JSON body, ingress checks that the route is still the exact
registration authenticated before reading the body, then removes it without
yielding before resume. Overlapping requests get one 200/completed response and
one 404/not_waiting, with one downstream execution. A delayed request cannot
resume a cancelled registration or consume its replacement (including one with
a different token). Invalid JSON still returns 400 without consuming the route.

Regression tests synchronize overlapping requests with HTTP `100 Continue`
instead of sleeps. The end-to-end harness now asserts these two fixes and checks
that a valid callback succeeds after a malformed URL. Current evidence is saved
separately in [follow-up JSON](./PLAT-278-webhook-resume-hardened.json); the original
baseline evidence and observations below are retained for comparison.

Follow-up validation on current main: root build passed (16 tasks, all rebuilt),
root typecheck passed (30 tasks), and the complete core suite with two workers reported 1,145
passed, five skipped, and one failure. The only failure is the previously recorded
`worktree.test.ts:129` assertion; all webhook regressions pass. The end-to-end
harness also passes, including the real CLI and SQLite restart checks.

The PR branch was rebased onto main at `c2b0592`, which already includes the
upstream falsy-resume fix. The current harness asserts successful HTTP resume for
`false`, `0`, `""`, and `null`; their failures in the original matrix below are
historical. The refreshed follow-up evidence was captured on this rebased engine.

This is a claim on one in-memory registration, not durable event-id deduplication
across retries, later gates, process restarts, or hosts. Schema rejection,
independent parallel gates, and always-on hosting remain the follow-on work
described below.

## Decision

The embedded HTTP path works for a single webhook gate per thread, including a
delayed callback and recovery from a killed process with SQLite checkpoints.
Several independent waiting threads can share a listener. This is enough to
continue designing the follow-on work, but production external-event ingress is
blocked on the remaining failures below. The original spike changed no engine
behavior; the follow-up above fixes URL decoding and overlapping deliveries.

Use `type: wait` with `with.webhook: true` for HTTP ingress. Setting
`onInterrupt: webhook` on a normal `hitl` gate only leaves an interrupt pending;
it does not create an HTTP route. An external caller can still use the resume API.

## Reproduce

```sh
pnpm build
node scripts/verify-webhook-resume.mjs > /tmp/webhook-resume-findings.json
pnpm --filter @flowgraph/core exec vitest run \
  src/runtime/webhook-server.test.ts src/hitl.test.ts src/webhook.test.ts
pnpm --filter @flowgraph/checkpoint-sqlite exec vitest run src/sqlite.test.ts
```

The domain-neutral [example](../../examples/webhook-resume/README.md) also gives
manual CLI/curl instructions. The [harness](../../scripts/verify-webhook-resume.mjs)
uses built packages, actual child processes, real HTTP requests, and temporary
SQLite files. It asserts supported paths and records characterization results
for unsupported paths. Its successful exit is not a production-readiness gate.
Captured output: [JSON evidence](./PLAT-278-webhook-resume.json).

## Baseline observations (before fixes)

| Case                                                                | Observed result                                                                                                                                   | Assessment                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Leave a process waiting, then POST a JSON object                    | Still waiting after 1 second; HTTP 200/completed after POST; payload stored; downstream `finish` ran once                                         | Works within the tested window                           |
| CLI run from the example YAML                                       | CLI prints the URL; real POST returns 200/completed; CLI prints completion                                                                        | Works; listener keeps the CLI alive after completion     |
| GET pending URL                                                     | HTTP 200 with `waiting: true`                                                                                                                     | Works                                                    |
| Missing/wrong shared secret                                         | HTTP 401, run stays waiting                                                                                                                       | Works                                                    |
| Bearer token / `x-flowgraph-token`                                  | Both accepted with the configured secret                                                                                                          | Works                                                    |
| Wrong thread or node                                                | HTTP 404                                                                                                                                          | Works                                                    |
| Malformed JSON syntax                                               | HTTP 400; route remains usable; valid retry succeeds                                                                                              | Works                                                    |
| Duplicate after completion                                          | HTTP 404/not_waiting; downstream ran once                                                                                                         | One-shot behavior; no durable receipt replay             |
| Two overlapping duplicate bodies                                    | Both HTTP 200/completed; downstream `finish` emitted `node.end` twice                                                                             | **Blocked: duplicate execution**                         |
| Eight concurrent interrupted threads on one compiled graph          | Eight HTTP 200/completed responses; each thread stores its own payload                                                                            | Works in this single-process test                        |
| Required schema field missing                                       | HTTP 422; immediate corrected retry gets 404; `getState` re-registers the route but corrected retry still gets 422 for the original missing value | **Blocked: invalid resume is retained**                  |
| Schema property has wrong type                                      | A string where a number is declared returns 200/completed and is stored                                                                           | **Blocked: only required-key checks exist**              |
| JSON `false`, `0`, `""`, `null`                                     | HTTP 422 with `Received empty Command input`                                                                                                      | **Unsupported falsy payloads**; wrap values in objects   |
| SIGKILL while interrupted, reopen same SQLite DB in a fresh process | No route after compile; `getState(threadId)` restores route; original URL returns 200/completed when its port is free                             | Recovery works with explicit thread loading              |
| Reopen completed SQLite checkpoint in a third process               | Completed values persist; no next nodes or pending route                                                                                          | Works                                                    |
| Two sequential webhook gates                                        | First POST returns interrupted; current snapshot exposes second URL; second POST completes                                                        | Core API works; caller must discover the next interrupt  |
| Two parallel webhook gates in one thread                            | Two interrupts, but only the last route is registered; first URL gets 404; posting to second resumes **both** gates with the same payload         | **Blocked: gates cannot be independently answered**      |
| Malformed percent-encoding in path (`%ZZ`)                          | Fetch loses its connection; isolated worker exits 1 with `URIError`                                                                               | **Blocked: malformed request crashes the listener host** |

## Baseline causes (before fixes)

The CLI's `validate` command also reports `FILE_NOT_FOUND` when passed a
root-relative nested graph path: it prepends the graph directory to the same
relative path. Validate from the example directory or use an absolute path.

- `packages/core/src/runtime/webhook-server.ts`: the request handler looks up a
  route **before** reading the asynchronous body and deletes it afterward. Two
  requests with partially delivered bodies both capture the same route and both
  invoke resume. The harness finishes both bodies together while a downstream
  250ms node is running, reproducing two downstream executions.
- `packages/core/src/nodes/wait.ts`: schema validation happens after LangGraph has
  persisted the resume value, and checks only `required` field presence. A schema
  error consumes the HTTP route and leaves a saved invalid answer that a later
  answer does not replace in this repro. Validate ingress before applying resume
  and define a retryable validation contract.
- `packages/core/src/compiler.ts`: `attachWebhookUrls` passes a raw
  `new Command({ resume: body })`, bypassing the existing falsy-answer handling in
  `resumeCommand`. Parallel interrupts also receive that one raw value rather
  than an interrupt-id-keyed answer.
- The route registry is keyed only by `threadId`; a second gate overwrites the
  first. Independent gates require route identity including node/interrupt id and
  targeted resume. The same route key also requires globally unique thread ids
  among graphs using this process-scoped registry.
- `parseWebhookPath` calls `decodeURIComponent` without handling decoding errors;
  the HTTP server invokes the async handler without a rejection boundary.

## Restart and hosting contract

SQLite persists the interrupt, not the HTTP server or route map. Recompile with
the same spec/checkpointer, then call `compiled.getState(threadId)` for each known
pending thread. This rehydrates routes and returns a current `webhookUrl` without
re-running the graph. Compile alone does not enumerate/recover all waiting runs.

The old URL is stable only when the host and configured port remain available.
`EADDRINUSE` falls back to an ephemeral port, which means external callers need
discovery or a stable routing layer. Default binding is loopback. Shared-secret
auth exists per route, but is optional; no signature verification, durable event
deduplication, or correlation-key lookup is provided by this path.

The test waits one second rather than performing a multi-day soak. It proves a
checkpoint survives SIGKILL and resumes in another process; it does not establish
multi-host coordination, Postgres durability, or unattended startup recovery.
Those remain hosting work for PLAT-280. Existing webhook/HITL tests passed
(20 tests), as did the SQLite durability test (1 test). Root `pnpm build` passed
(16 cached tasks); the older AGENTS.md declaration-build warning did not reproduce.
Root `pnpm typecheck` also passed (30 tasks). The example validates from its own
directory, and the harness passes syntax and formatting checks.

Root `pnpm test` failed under broad parallel execution with five-second timeouts
in unrelated example/context tests. Rerunning with two workers passed both
examples (8 tests), all three context suites (56 tests), and 63 of 64 tests across
demo/template/artifacts/worktree suites. The remaining existing failure is
`packages/core/src/worktree.test.ts:129` (`honors runtime.worktrees.root`, expected
completed, received error). No engine or worktree source was changed by this
spike; the aggregate suite is not green.

## Follow-on recommendations

| Story                                                                                            | Decision after this spike                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [PLAT-279](https://veloxdevworks.atlassian.net/browse/PLAT-279) — correlation/auth/deduplication | **Proceed with implementation. Block production ingress** until overlapping delivery is claimed atomically, dedupe is durable, invalid requests cannot crash the host, schema rejection preserves a usable wait, and resume targets the intended interrupt. Incorporate the findings into its design and acceptance tests. |
| [PLAT-280](https://veloxdevworks.atlassian.net/browse/PLAT-280) — always-on runtime              | **Proceed with design; keep post-0.1.** Add startup enumeration/rehydration, stable ingress addressing, Postgres restart tests, and ownership/concurrency control. SQLite success alone does not verify this story.                                                                                                        |
| [PLAT-281](https://veloxdevworks.atlassian.net/browse/PLAT-281) — progress events                | **Proceed.** The event work does not require hardened ingress; verify per-thread attribution under concurrent runs.                                                                                                                                                                                                        |
| [PLAT-282](https://veloxdevworks.atlassian.net/browse/PLAT-282) — Active runs                    | **Proceed for local and single external gates.** Classify external waits using `payload.data.mode === "webhook"`; `kind` alone is `custom` (also used by signal/until waits). Gate claims of independent parallel external gates and unattended remote recovery on the fixes above.                                        |
| [PLAT-283](https://veloxdevworks.atlassian.net/browse/PLAT-283) — notification sinks             | **Proceed.** Human approval is `kind: approval`; webhook wait is `kind: custom` plus mode `webhook`. Avoid a human-action notification for external waits.                                                                                                                                                                 |
| [PLAT-284](https://veloxdevworks.atlassian.net/browse/PLAT-284) — example/adapter                | **Proceed as a trusted local demonstration. Block a production recipe** until PLAT-279's delivery and ingress guarantees are verified.                                                                                                                                                                                     |

The follow-up above resolves the malformed-path crash and overlapping-delivery
race. Keep the single-gate limitation explicit until routes and resumes are scoped
to an individual interrupt. Full schema validation and recoverable rejected
answers are also prerequisites for treating external input as a reliable
integration.
