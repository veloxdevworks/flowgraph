# @flowgraph/node-service

> **Preview:** This package is in preview. Its schema and runtime behavior may change before stabilization.

Provides the `service` node type for managing long-running background processes across graph steps, along with the `list_services`, `service_status`, `start_service`, `stop_service`, and `restart_service` agent tools and run-end / resume lifecycle hooks. The Flowgraph CLI and Desktop register this package by default; programmatic hosts can import it directly.

## Usage

```ts
import "@flowgraph/node-service";
```

Or register explicitly:

```ts
import { registerServiceNode } from "@flowgraph/node-service";

registerServiceNode();
```
