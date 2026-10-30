---
"@flowgraph/core": minor
---

Agent memory recall within a deterministic token budget (`with.memory.recall`, rendered as fenced `<memory>` blocks, never written to state), `ctx.memory.similarSubjects` cross-subject search by type and tags, the agent `remember` tool (`with.memory.agentWrites`), the `memory.recall` event and `MEMORY_RECALL_FAILED` run issue, and the `MEMORY_RECALL_ID_DUPLICATE` / `MEMORY_SUBJECT_TYPE_MISMATCH` validation codes. `ctx.memory.search` and the memory node's `search` op now walk scopes narrowest first and return each key once (pass `dedupe: false` for every copy). The missing-memory-backend compile error now names the checkpoint backend and the fix for it (postgres memory is not available yet).
