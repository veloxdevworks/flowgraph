# `@veloxdevworks/flowgraph-core`

Compiler, runtime, node registry, event bus, and built-in nodes for [flowgraph](https://github.com/veloxdevworks/flowgraph).

```bash
pnpm add @veloxdevworks/flowgraph-core
```

```ts
import { loadGraph, validateSpec, compileGraph } from "@veloxdevworks/flowgraph-core";

const { spec, diagnostics } = await loadGraph("./my.graph.yaml");
if (!spec) throw new Error(diagnostics.map((d) => d.message).join("; "));
const lint = validateSpec(spec);
if (lint.some((d) => d.severity === "error")) throw new Error("invalid graph");

const compiled = await compileGraph(spec, { graphPath: "./my.graph.yaml" });
const result = await compiled.run({ input: { text: "hello" }, onInterrupt: "fail" });
console.log(result.status, result.state);
```

The public run API is `compiled.run`, `compiled.resume`, `compiled.continueRun`, and `compiled.stream`. Durable backends (`sqlite` / `postgres`) require an injected checkpointer instance — they do not silently fall back to memory.

See the [programmatic API guide](../../docs/14-programmatic-api.md).
