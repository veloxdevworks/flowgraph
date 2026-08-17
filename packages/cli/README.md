# `@veloxdevworks/flowgraph-cli`

The `flowgraph` binary. Run, validate, inspect, and resume YAML graphs.

```bash
pnpm add -D @veloxdevworks/flowgraph-cli
# or, without installing:
npx @veloxdevworks/flowgraph-cli run my.graph.yaml --stream --input 'text=Hello'
```

Unscoped `npx flowgraph` is a **different** 2015 npm package. Always use the scoped name.

```bash
npx @veloxdevworks/flowgraph-cli validate my.graph.yaml --preflight
npx @veloxdevworks/flowgraph-cli graph my.graph.yaml --format ascii
npx @veloxdevworks/flowgraph-cli resume my.graph.yaml --thread t1 --resume '{"approved":true}'
```

`provider: mock` is registered by this CLI (not by core). SQLite checkpoints are injected when the graph sets `runtime.checkpoint.backend: sqlite` (install `@veloxdevworks/flowgraph-checkpoint-sqlite`).

See [09 — CLI](../../docs/09-cli.md).
