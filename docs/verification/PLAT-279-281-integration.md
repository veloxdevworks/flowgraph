# PLAT-279 + PLAT-281 — combined verification

Both features were implemented and verified separately, then built and tested
together in an isolated checkout with its own workspace dependencies. The
verified resolution is delivered as a stack: **PR #38 → PR #40 → PR #39**.
No PR or `main` branch was merged as part of this verification.

Input heads:

- PLAT-279: `56723ace4d1b23fa6fd3ff171909854254de953c`
- PLAT-281: `0f083ffa605ec1f9ef4eaea82d87cc2835284b12`
- Tested combined source: `fb08a14050a3652a1c0e70e714e0c36d1e4b5cb0`

Compiler conflicts were resolved by retaining the webhook journal, targeted
resume validation, deadline coordination, and thread-context safeguards alongside
committed state observation and selected-edge reporting. The execution-start
callback remains inside the inner invocation, immediately before its real start
event. An admission rejection remains a nonterminal diagnostic; a rejected new
stream throws locally instead of consuming or terminating the owning stream.
The shared event-thread helper is present once, with the repaired stream buffer
lifecycle preserved.

## Results

All combined checks passed on Node v25.2.1, macOS arm64:

- Root build: **16 tasks passed**.
- Root typecheck: **30 tasks passed**.
- Focused core regressions: **113 passed** across progress, stream lifecycle,
  correlation, delivery journal, HTTP ingress, and wait-node suites.
- Correlation spec regressions: **2 passed**.
- Progress E2E: all four scenarios passed, including API parallel reducers,
  repeated/slow stream consumers, real CLI JSONL, separate-process SQLite resume,
  authenticated HTTP/SSE, Last-Event-ID replay, and journal agreement.
- Correlation E2E: all six scenarios passed, including rejected authentication /
  payloads, SIGKILL recovery, ambiguous keys, twelve overlapping deliveries across
  two processes, unresolved crash claims, and real CLI `resume --listen`.
- Combined admission E2E: the active progress stream survived a busy API resume
  and a rejected second stream while a signed callback was held downstream.
  The rejected stream received **zero** owning-run frames and threw
  `WEBHOOK_THREAD_BUSY` locally. Both warnings carried the correct thread id.
  Replaying a completed delivery produced no additional progress or side effect.
  The owner then received two public state updates, all four selected edges,
  and its actual `run.end`; `__correlation` remained private. The held side effect
  ran once.

[Captured combined summary](./PLAT-279-281-integration.json). The admission check
is reproducible with [verify-webhook-progress.mjs](../../scripts/verify-webhook-progress.mjs).

```sh
pnpm build --concurrency=1
pnpm typecheck --concurrency=1
node scripts/verify-progress-events.mjs
node scripts/verify-correlated-webhooks.mjs
node scripts/verify-webhook-progress.mjs
pnpm --filter @flowgraph/core exec vitest run \
  src/progress-events.test.ts src/events-stream.test.ts \
  src/runtime/webhook-correlation.test.ts \
  src/runtime/webhook-delivery-journal.test.ts \
  src/runtime/webhook-server.test.ts src/nodes/wait.test.ts --maxWorkers=1
pnpm --filter @flowgraph/spec exec vitest run \
  src/webhook-correlation.test.ts --maxWorkers=1
```

No additional broad local suite was run after integration. The separately
verified PLAT-279 head passed full Node 22/Linux CI with Postgres (run 175), and
the pre-stack PLAT-281 head did too (run 176). The published stacked head runs
its own CI. The earlier documented macOS worktree failure remains outside these
focused combined suites.
