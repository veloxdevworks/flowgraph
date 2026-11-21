---
"@flowgraph/core": minor
---

`${VAR}` expansion in a graph's `config` and `runtime` blocks reads only names the graph lists under its top-level `secrets:`. An undeclared placeholder is left as written and reported as `SECRET_UNDECLARED`, with its path and the name to add, by `loadGraph` / `flowgraph validate`. `compileGraph` scans any spec itself (loaded, copied, bundled, server-parsed or built in code) and refuses an unexpanded `${NAME}` in `config` or `runtime`, or in an inline subgraph's, whose name that graph does not declare, and `validateSpec` reports the same diagnostics. `$${NAME}` is never refused; each escape counts on its own, so `"$${X}${X}"` is still refused when `X` is undeclared. A `:-default` does not make an undeclared name optional. Inline and file subgraphs each expand only the names in their own list; inline subgraph `spec:` blocks are now expanded at all, against that list. `$${VAR}` still escapes a placeholder, and a declared name expands as before.

A value read from the environment this way shows as `[REDACTED]` in results, events, logs and checkpoints. When a graph compiles, the host value of every name it and its inline subgraphs declare is registered for redaction, so this also holds for a `structuredClone` or spread copy of a loaded spec. A `:-default` written in the graph is not redacted.

**Migration:** add each name a graph reads through `${NAME}` to `secrets:`, for example `secrets: [FLOWGRAPH_WEBHOOK_TOKEN]` for `token: "${FLOWGRAPH_WEBHOOK_TOKEN}"`. Settings that should stay readable, such as a model name, belong in the graph as plain values rather than `${VAR}`, since an expanded value is redacted.
