---
"@flowgraph/core": minor
"@flowgraph/checkpoint-sqlite": minor
"@flowgraph/checkpoint-postgres": minor
"@flowgraph/cli": minor
"@flowgraph/server": patch
---

Coordinate execution of a thread across SQLite processes and PostgreSQL hosts,
reject unknown or completed resumes without writes, isolate concurrent thread
streams, and populate default thread status metadata. Checkpoint schemas 5/6 add
non-expiring claims with owner identity. These migrations are one-way; older
runtimes cannot reopen the migrated database. Inspect/release CLI and APIs
support explicit recovery after owner/outcome reconciliation. Prepared
invocations let the server reject competitors and invalid continuations before
changing owner status, events or cancellation controllers. Human gates require
explicit answers; continue/step advance pauses without approving decisions.
