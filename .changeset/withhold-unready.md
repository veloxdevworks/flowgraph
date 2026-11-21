---
"@flowgraph/spec": minor
"@flowgraph/core": minor
"@flowgraph/cli": minor
"@flowgraph/server": minor
---

`runsOn.wait` is not part of the v1 schema and is rejected at validation, with a message that queueing for a matching worker is not available. Triggers stay in the schema (Desktop interprets them). The CLI, the server, and `compiled.run()` emit a `TRIGGERS_HOST_UNSUPPORTED` warning that they ignore them. The placement error for a queued wait no longer refers to a later delivery step.

The trigger warning from `compiled.run()` is recorded as a standard run issue (in `RunResult.issues` and the server issue list, and counted by `--fail-on-issues`), not only emitted as an event. `CompileOptions.hostName` names the host in it; the CLI and server pass their own names.
