---
"@flowgraph/core": minor
---

A Set-Cookie's bare value counts as credential-like under a cookie name only when one of the name's words, split on `-`, `_`, `.` and case changes, is `sess`, `session`, `sid`, `token`, `auth`, `jwt`, `secret`, `key`, `csrf`, `xsrf`, `login`, `remember` or `refresh`. `session_id`, `sid`, `auth-token`, `XSRF-TOKEN` and `refreshToken` qualify; `monkey` and `Access-Mode` no longer do.

The `http` node's `node.output` event and debug log mask credentials and sensitive query parameters in the request URL, and the event masks sensitive response headers, and those listed in `runtime.secrets.redact.headers`, as `[REDACTED]`. The node also registers each response Set-Cookie (with the cookie rule above) and the values of listed response headers for redaction. `result.headers` keeps every header, but a registered value inside it, such as a session cookie, now shows as `[REDACTED]` in state, like anywhere else. A graph that read a response cookie from `result.headers` to send on a later request now gets `[REDACTED]` instead.
