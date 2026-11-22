# @flowgraph/node-port

> **Preview:** This package is in preview. Its schema and runtime behavior may change before stabilization.

Provides the `port` node type for allocating free TCP ports at run time. The Flowgraph CLI and Desktop register this package by default; programmatic hosts can import it directly.

## Usage

```ts
import "@flowgraph/node-port";
```

Or register explicitly:

```ts
import { registerPortNode } from "@flowgraph/node-port";

registerPortNode();
```
