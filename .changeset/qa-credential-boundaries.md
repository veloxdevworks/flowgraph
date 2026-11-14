---
"@flowgraph/core": minor
"@flowgraph/spec": minor
"@flowgraph/cli": patch
"@flowgraph/server": patch
---

Pass only operational defaults and explicitly inherited variables into shell children. Resolve shell, script, and HTTP secrets consistently, honor OpenAI baseUrl and apiKeyEnv, redact provider key fragments before error reporting, and require kind: cli for local CLI agents. Bind the server to localhost by default; set FLOWGRAPH_HOST explicitly for remote access.
