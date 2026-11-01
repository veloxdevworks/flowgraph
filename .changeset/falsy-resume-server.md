---
"@flowgraph/server": patch
---

`POST /runs/:threadId/resume` and the `/invocations` `resume` action answer 400 with `code` `RESUME_REQUIRED` when the request body has no `resume` key (an empty body, `{}` or a misspelled key), instead of starting a resume. Send `"resume": false` or `null` to deny an approval.

`RunService.resumeRun()` refuses a missing `resume` value with the same `RESUME_REQUIRED` error (status 400) before anything runs, so a connect `run.resume` without a value gets an error reply with that code instead of `started`, and the thread stays at its gate.
