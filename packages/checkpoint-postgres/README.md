# `@veloxdevworks/flowgraph-checkpoint-postgres`

Durable Postgres checkpointer for flowgraph. Pass the saver into `compileGraph` — core will not construct one from YAML alone.

```bash
pnpm add @veloxdevworks/flowgraph-checkpoint-postgres
```

```ts
import { compileGraph } from "@veloxdevworks/flowgraph-core";
import { createPostgresCheckpointer } from "@veloxdevworks/flowgraph-checkpoint-postgres";

const checkpointer = await createPostgresCheckpointer(process.env.DATABASE_URL!);
const compiled = await compileGraph(spec, { checkpointer });
```

The CLI does not inject Postgres; hosted runs use `@veloxdevworks/flowgraph-server` (not in the 0.1 npm set).
