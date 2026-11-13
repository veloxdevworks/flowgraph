---
"@flowgraph/core": minor
"@flowgraph/spec": minor
"@flowgraph/cli": patch
---

Route signed inbound webhook events by opaque run/gate correlation keys, with
durable delivery receipts and thread coordination across processes sharing a
local journal. Completed deliveries replay their cached response; conflicting,
ambiguous, invalid, or unauthenticated callbacks do not resume a waiting gate.
Claims with an unknown crash outcome fail closed until operator reconciliation.

Run-level correlation declarations survive checkpoints and are hidden from public
state. Signed ingress requires an HMAC key and durable journal, cannot be bypassed
through raw callback URLs, and coordinates manual resumes and deadline handling.
The CLI's `resume --listen` restores pending webhook listeners without submitting
an answer, preserving gates across process restarts.
