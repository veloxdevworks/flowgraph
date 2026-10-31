---
"@flowgraph/spec": minor
---

Schema for agent context budgets: `with.context` on agent nodes (`maxTokens`, `reserveTokens`, `strategy`, `lastN`, `toolResultMaxTokens`, `issuesMaxTokens`, `summarize` with `mode` / `provider` / `model` / `maxTokens` / `instructions`, `estimator`, `onOverflow`, `history`, `record`, `compact`) and graph-wide defaults under `runtime.context`.

**What to change:** nothing; every field is optional and new.
