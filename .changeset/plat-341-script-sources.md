---
"@flowgraph/spec": minor
"@flowgraph/core": minor
"@flowgraph/server": patch
---

Support mutually exclusive inline `code` and graph-relative `file` script sources,
and recursively render structured script inputs without coercing their types.
File sources use the existing isolated sandbox and respect a host's
`blockScriptFiles` policy. Untrusted server uploads retain their script restrictions.
