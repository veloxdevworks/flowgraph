# @flowgraph/node-demo

> **Preview:** This package is in preview. Its schema and runtime behavior may change before stabilization.

Provides the `demo` node type for capturing HTTP transcripts, Playwright screenshots and videos, scripted web verification steps, iOS/Android simulator captures, and file artifacts. The Flowgraph CLI and Desktop register this package by default; programmatic hosts can import it directly.

## Usage

```ts
import "@flowgraph/node-demo";
```

Or register explicitly:

```ts
import { registerDemoNode } from "@flowgraph/node-demo";

registerDemoNode();
```
