---
"@flowgraph/core": minor
---

Redaction uses one marker, `[REDACTED]`, everywhere. `webhook` `result.headers`, the request headers in `http` events, and `demo` HTTP transcripts mask sensitive headers with it, for built-in names and for names listed in `runtime.secrets.redact.headers` alike; URL credentials, sensitive query parameters and sensitive field names in `demo` transcripts use it too. All of these used to show `***`.

Each `Set-Cookie` a webhook receives registers the cookie's `name=value` for redaction whenever the value is non-empty. The bare value is registered only when it is at least 16 characters, or at least 8 when the cookie name looks like a credential (`sess`, `sid`, `token`, `auth`, `jwt`, `secret`, `key`, `csrf`, `xsrf`, `login`, `remember`, `refresh`, `access`), so a body that echoes only the session token is redacted while ordinary values such as `default` or `true` are left alone.
