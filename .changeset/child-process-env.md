---
"@flowgraph/core": minor
---

`command` skills and `service` processes no longer inherit the whole host environment. Like `shell` and `script`, they start from the default allowlist (`PATH`, `HOME`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `LC_ALL`, `SystemRoot`, `WINDIR`). A command skill also receives its declared `env.vars` and `FLOWGRAPH_INPUT`; a var marked `secret: true` is passed only when the graph lists it under `secrets:` (a required one fails the skill, an optional one is left out). A service also receives its `with.env`.

**What to change:** list every variable a command skill reads under its `env.vars`, and declare its secret vars in the graph's `secrets:`. Pass anything else a service needs through `with.env`, for example `env: { DATABASE_URL: "{{ secret.DATABASE_URL }}" }`.
