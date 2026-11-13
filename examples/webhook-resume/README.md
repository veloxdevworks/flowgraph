# Webhook interrupt and resume

A domain-neutral graph waits for an external JSON event, stores it in `received`,
then runs `finish` and completes. No provider, API key, or imports are needed.

From the repository root:

```sh
pnpm build
cd examples/webhook-resume
node ../../packages/cli/dist/bin.js run webhook-resume.graph.yaml \
  --thread webhook-demo --on-interrupt webhook --stream
```

Leave that terminal open. In another terminal, POST to the URL printed by the CLI
(the port can change if 8878 is already occupied):

```sh
curl -i http://127.0.0.1:8878/webhooks/webhook-demo/await-event \
  -H 'Content-Type: application/json' \
  --data '{"eventId":"example-1","value":42}'
```

Expected response: HTTP 200, `{"status":"completed"}`. The first terminal prints
`Completed after webhook resume.` The current CLI retains its HTTP listener after
completion; use Ctrl-C to stop it. Use a new thread id for another independent run.

The example binds to loopback and has no token. A host can set
`runtime.webhookServer.token` and send `Authorization: Bearer <token>` or
`x-flowgraph-token: <token>`. This shared secret is optional and is not webhook
signature verification. Read the findings before exposing ingress to other hosts.

## Repeat the spike

From the repository root:

```sh
node scripts/verify-webhook-resume.mjs > /tmp/webhook-resume-findings.json
```

The harness starts isolated child processes with real loopback HTTP listeners,
kills a waiting process, reopens its SQLite checkpoint in another process, and
verifies the resulting state. Temporary databases and children are cleaned up.
It also runs the YAML through the CLI. Allow localhost listeners in restricted
sandboxes. It prints observed gaps as evidence; exit zero means the harness
completed, not that every behavior is production-ready.

After restart, compile the same graph with the same durable checkpointer and
call `compiled.getState(threadId)` to re-register the pending route. Compilation
alone does not restore listeners. The old URL is reusable only if the same host
and port can be bound; otherwise discover the current URL from the snapshot.

See [PLAT-278 findings](../../docs/spikes/PLAT-278-webhook-resume.md) for the result
matrix, current limitations, and the follow-on decisions.
