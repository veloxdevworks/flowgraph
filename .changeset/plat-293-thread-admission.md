---
"@flowgraph/core": minor
"@flowgraph/checkpoint-sqlite": minor
"@flowgraph/checkpoint-postgres": minor
---

Coordinate execution of a thread across SQLite processes and PostgreSQL hosts,
reject unknown or completed resumes without writes, isolate concurrent thread
streams, and populate default thread status metadata. Checkpoint schema 5 adds
non-expiring claims; crashes require explicit owner/outcome reconciliation.
