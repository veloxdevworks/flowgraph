# `@veloxdevworks/flowgraph-expr`

Sandboxed `{{ expression }}` evaluator used by flowgraph YAML specs. No `eval`.

```bash
pnpm add @veloxdevworks/flowgraph-expr
```

```ts
import { renderDeep, evalGuard } from "@veloxdevworks/flowgraph-expr";

renderDeep("Hello, {{ state.name }}", { state: { name: "Ada" } });
evalGuard("contains(lower(state.summary), 'error')", { state: { summary: "Error in login" } });
```

See [05 — State and data](../../docs/05-state-and-data.md).
