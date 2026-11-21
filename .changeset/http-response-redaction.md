---
"@flowgraph/core": minor
---

A Set-Cookie's bare value counts as credential-like under a cookie name only when one of the name's words, split on `-`, `_`, `.` and case changes, is `sess`, `session`, `sid`, `token`, `auth`, `jwt`, `secret`, `key`, `csrf`, `xsrf`, `login`, `remember` or `refresh`, or one of the compounds `sessionid`, `sessid`, `phpsessid`, `jsessionid`, `csrftoken` and `apikey`. `session_id`, `sid`, `auth-token`, `XSRF-TOKEN`, `refreshToken`, `PHPSESSID` and `JSESSIONID` qualify; `monkey` and `Access-Mode` no longer do.

The `http` node's `node.output` event and debug log mask credentials and sensitive query parameters in the request URL. The event also masks response headers by name, as `[REDACTED]`: built-in sensitive headers such as `Set-Cookie`, names listed in `runtime.secrets.redact.headers`, and auth/token-like names. The event's response body masks those headers' values and each Set-Cookie under the cookie rule above. Nothing is registered for run-wide redaction, so `result.headers`, the response body and the node's output keep the real values, and a later node can still forward a session cookie.
