# Reducers example

Demonstrates **parallel fan-out** with accumulating reducers and **`imports[].reducers`**:

- `parallel-fanout.graph.yaml` — `append` merges tags from parallel `code` branches
- `custom-reducer.graph.yaml` — `custom:uniqueById` dedupes findings by `id`

Both graphs import `./register.ts`, which registers code functions (side effect) and exports `default: { uniqueById }`.

```bash
pnpm install
pnpm test
pnpm start
```

### Reducer plugin module

```ts
import type { ReducerFn } from "@veloxdevworks/flowgraph-core";

const uniqueById: ReducerFn = (cur, inc) => { /* merge by id */ };

export default { uniqueById };
```

```yaml
imports:
  - { reducers: ./register.ts }

state:
  channels:
    findings: { type: array, reducer: "custom:uniqueById" }
```

`flowgraph validate` loads `imports` before linting, so unregistered `custom:*` reducers are caught offline.
