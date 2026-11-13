# Signed callbacks by external correlation

This example has two sequential external gates. Callers know an opaque external
id and a stable integration endpoint; they never need the engine's thread id.
The sender signs each request and supplies a stable delivery id. Completed
delivery receipts survive process restarts and prevent a repeated event from
answering a later gate.

Build the engine at the repository root with `pnpm build`, then run:

```sh
cd examples/correlated-webhooks
export FLOWGRAPH_WEBHOOK_SECRET='local-example-signing-key-change-before-deploying'
node ../../packages/cli/dist/bin.js run correlated.graph.yaml \
  --thread local-example --input externalId=external-123 --on-interrupt webhook --stream
```

In another terminal in the same directory, set the same environment variable and
send the two distinct logical events:

```sh
export FLOWGRAPH_WEBHOOK_SECRET='local-example-signing-key-change-before-deploying'
node send.mjs http://127.0.0.1:8878/webhook-events/example event-1 external-123 first-gate yes
node send.mjs http://127.0.0.1:8878/webhook-events/example event-2 external-123 second-gate done
```

The first callback returns `200 {"status":"interrupted"}`. The second returns
`200 {"status":"completed"}`. Repeating either exact command returns its original
receipt with `duplicate: true`; it never answers another gate. Reusing an event
id with different body bytes returns `409 delivery_conflict`. A corrected callback
may reuse its id after an authentication, envelope, ambiguity, or payload rejection,
because none of those rejections claims the delivery.

The CLI currently keeps its listener alive after completion; Ctrl-C stops it.
Use a new thread and external id for a new independent run.

## Declaration and recovery

`runtime.correlation` values render once at run start against initial input/state.
The programmatic equivalent is
`compiled.run({ threadId, correlation: { external: "external-123" } })`.
API pairs override graph defaults. A wait can add or override pairs through
`with.webhook.correlation` (templates use that node's current state/input).
Keys are opaque strings; values must be non-empty strings. There are no
tracker-, CI-, or domain-specific fields in the engine.

The graph checkpoints its run-level pairs. To restart a waiting CLI run, keep
the database and journal directory and run:

```sh
node ../../packages/cli/dist/bin.js resume correlated.graph.yaml \
  --thread local-example --listen --on-interrupt webhook --stream
```

A host that uses the library recompiles with the same checkpointer and calls
`compiled.getState(threadId)` for its known waiting threads. This recreates the
correlation routes. Compilation alone does not scan/discover saved threads. A
host may call `ensureWebhookServer(compiled.spec.runtime.webhookServer)` at startup to
serve cached receipts even when no gates remain waiting.

`resume --listen` does not submit a resume value. It cannot be combined with
`--resume`, `--from`, or `--list`, and exits with status 3 if no webhook gate is
pending. A plain `resume` retains its normal manual-answer behavior.

## Delivery protocol

The request body is UTF-8 JSON:

```json
{"correlation":{"external":"external-123"},"nodeId":"first-gate","payload":{"answer":"yes"}}
```

Every supplied correlation pair must match. `nodeId` and `interruptId` are
optional structural selectors. More than one match returns
`409 ambiguous_correlation`; no match returns `404 not_waiting`.

Headers:

- `X-Flowgraph-Delivery-Id`: stable logical event id, unique within the ingress.
- `X-Flowgraph-Timestamp`: current Unix time in seconds (within five minutes).
- `X-Flowgraph-Signature`: `sha256=<hex HMAC-SHA256>`.

Sign the exact concatenation of
`timestamp + "." + deliveryId + "." + pathname + "." + rawBodyBytes`.
The path includes `/webhook-events/<id>` and excludes a query string. A retry
keeps the same id and exact body bytes, and signs with a fresh timestamp. The
example adapter implements this contract. If `webhookServer.token` is also set,
its bearer token is required in addition to the signature. Raw `/webhooks/...`
callbacks are disabled for gates configured with signed ingress.

## Durability boundary

`journalPath` resolves relative to the graph file. Keep it on durable local
storage with atomic directory/link/rename operations and working `fsync`.
Every process coordinating the same checkpoint thread must share the same
ingress id and journal directory. This is a shared-filesystem implementation;
it does not supply a distributed database-backed ingress service.

The journal locks the thread and fsyncs a delivery claim before invoking the
engine. Manual API resumes and deadline timers use the same lock. Completed
receipts cache the original response, including an intermediate `interrupted`
status. Receipts contain identifiers, hashes, and outcomes, not callback payloads
or signing keys. They have no automatic expiry or garbage collection; deleting
them removes deduplication protection for those ids.

If a process dies after claiming a delivery but before recording its outcome,
the engine cannot safely determine whether external effects happened. It returns
`409 delivery_in_doubt` for that event. Another event resolving a still-pending
gate on the locked thread returns `409 thread_busy`; an event naming an already
consumed gate returns `404 not_waiting`. It never expires the unresolved claim
and invokes the event again.
Stop all runtimes sharing the journal, inspect the checkpoint and any downstream
effects, and reconcile the outcome deliberately. Keep unresolved receipts and
locks until that investigation is complete. This is at-most-once delivery
invocation, not a guarantee that every accepted event finishes after a crash.

For deployment, use a stable port and HTTPS termination. Signed ingress fails
on an occupied configured port rather than silently choosing a different one.
Authentication failures are logged without keys or callback bodies. Listener
configuration and secrets are host-controlled; rotate keys by restarting hosts.
