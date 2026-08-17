# `@veloxdevworks/flowgraph-provider-cursor`

Cursor SDK adapter for flowgraph intelligent / agent nodes.

```bash
pnpm add @veloxdevworks/flowgraph-provider-cursor @cursor/sdk
```

```ts
import { compileGraph } from "@veloxdevworks/flowgraph-core";
import { createCursorProviderFromConfig } from "@veloxdevworks/flowgraph-provider-cursor";

const cursor = await createCursorProviderFromConfig("cursor", { kind: "cursor" }, { cwd });
const compiled = await compileGraph(spec, { providers: [cursor] });
```

The CLI lazy-loads this package when a graph declares `providers.*.kind: cursor`. Requires `CURSOR_API_KEY`. See [08 — Providers](../../docs/08-providers.md).
