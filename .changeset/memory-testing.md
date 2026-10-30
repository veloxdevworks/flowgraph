---
"@flowgraph/testing": minor
---

`@flowgraph/testing/memory-conformance` exports `describeMemoryBackendConformance`, a shared vitest suite every memory backend must pass. `compileForTest` / `runInMemory` give each compile a fresh ephemeral memory backend, so graphs with `runtime.memory` run in tests (override with the new `memory` option).
