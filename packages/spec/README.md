# `@veloxdevworks/flowgraph-spec`

Zod schemas and generated JSON Schema for the flowgraph YAML graph specification.

```bash
pnpm add @veloxdevworks/flowgraph-spec
```

```ts
import { GraphSpecSchema, generateJsonSchema } from "@veloxdevworks/flowgraph-spec";

const spec = GraphSpecSchema.parse(raw);
const jsonSchema = generateJsonSchema();
```

Use `flowgraph schema --out schema/v1.json` from `@veloxdevworks/flowgraph-cli` to emit the schema for editor autocomplete. See [02 — Graph specification](../../docs/02-graph-spec.md).
