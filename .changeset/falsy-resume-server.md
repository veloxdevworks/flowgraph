---
"@flowgraph/server": patch
---

`POST /runs/:threadId/resume` and the `/invocations` `resume` action answer 400 with `code` `RESUME_REQUIRED` when the request body has no `resume` key (an empty body, `{}` or a misspelled key), instead of starting a resume. Send `"resume": false` or `null` to deny an approval.
