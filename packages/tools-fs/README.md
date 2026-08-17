# `@veloxdevworks/flowgraph-tools-fs`

Sandboxed local filesystem tools for flowgraph intelligent nodes.

```bash
pnpm add @veloxdevworks/flowgraph-tools-fs
```

```ts
import { registerFsTools } from "@veloxdevworks/flowgraph-tools-fs";

registerFsTools({ workspaceRoot: process.cwd(), operations: ["read", "list"] });
```

The CLI lazy-loads this package when a graph declares `localTools.fs`. See [11 — Local tools](../../docs/11-local-tools.md).
