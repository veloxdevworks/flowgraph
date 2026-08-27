# `@veloxdevworks/flowgraph-checkpoint-sqlite`

Durable SQLite checkpointer for flowgraph. Pass the saver into `compileGraph` — core will not construct one from YAML alone.

```bash
pnpm add @veloxdevworks/flowgraph-checkpoint-sqlite
```

```ts
import { compileGraph } from "@veloxdevworks/flowgraph-core";
import { createSqliteCheckpointer } from "@veloxdevworks/flowgraph-checkpoint-sqlite";

const checkpointer = createSqliteCheckpointer(".flowgraph/checkpoints.db");
const compiled = await compileGraph(spec, { checkpointer });
```

The CLI injects this automatically when a graph sets `runtime.checkpoint.backend: sqlite`.
