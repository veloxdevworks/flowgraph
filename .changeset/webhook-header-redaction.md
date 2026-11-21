---
"@flowgraph/core": patch
---

`webhook` results mask sensitive response headers in `result.headers` with `[REDACTED]`, the same marker used elsewhere, for built-in names and for names listed in `runtime.secrets.redact.headers` alike (built-in names used to show `***`). Each `Set-Cookie` also registers the cookie's `name=value` and its bare value, so a response body that echoes only the session token is redacted.
