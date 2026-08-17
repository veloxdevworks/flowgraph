# `@veloxdevworks/flowgraph-testing`

In-memory test harness for flowgraph graphs. No CLI, no filesystem checkpoint.

```bash
pnpm add -D @veloxdevworks/flowgraph-testing
```

```ts
import { runGraphFile } from "@veloxdevworks/flowgraph-testing";

const result = await runGraphFile("./my.graph.yaml", {
  cwd: import.meta.dirname,
  input: { text: "hello" },
});
```

Also exports `compileForTest`, `runInMemory`, and `eventsOfType`. See [14 — Programmatic API](../../docs/14-programmatic-api.md).
