# @flowgraph/node-workshop

> **Preview:** This package is in preview. Its schema and runtime behavior may change before stabilization.

Provides the `workshop` node type (one-shot facilitated HITL agenda sessions), its Zod schemas, contract types, and output validation helpers. The Flowgraph CLI and Desktop register this package by default; programmatic hosts can import it directly.

## Usage

```ts
import "@flowgraph/node-workshop";
```

Or register explicitly:

```ts
import { registerWorkshopNode } from "@flowgraph/node-workshop";

registerWorkshopNode();
```
