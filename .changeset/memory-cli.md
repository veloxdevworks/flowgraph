---
"@flowgraph/cli": minor
---

`flowgraph run` / `resume` keep `runtime.memory` (and `runtime.store.backend: sqlite`) in the sqlite checkpoint file. The memory project defaults to the normalized git origin, the user to `git config user.email`; override with `FLOWGRAPH_ORG` / `FLOWGRAPH_PROJECT` / `FLOWGRAPH_USER` or `memory:` in `.flowgraph/config.yaml`. `flowgraph validate` and `run` report memory on a backend the CLI cannot serve as `MEMORY_BACKEND_UNAVAILABLE`.
