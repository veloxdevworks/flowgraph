---
"@flowgraph/core": minor
"@flowgraph/spec": minor
"@flowgraph/cli": patch
"@flowgraph/server": patch
---

Pass only a documented default allowlist (`PATH`, `HOME`, `TMPDIR`, `TEMP`/`TMP`, `LANG`, `LC_ALL`, and on Windows `SystemRoot`/`WINDIR`) plus explicitly inherited variables into shell and script children. `USER` and `SHELL` are not included; secrets must be opted in. Resolve shell, script, and HTTP secrets consistently, honor OpenAI baseUrl and apiKeyEnv, redact provider key fragments before error reporting, and require kind: cli for local CLI agents. Bind the server to localhost by default; set FLOWGRAPH_HOST explicitly for remote access.
