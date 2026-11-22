# @flowgraph/node-worktree

> **Preview:** This package is in preview. Its schema and runtime behavior may change before stabilization.

Provides the `worktree` node type for idempotent git worktree management (`add`, `remove`, `status`) and automatic end-of-run worktree cleanup. The Flowgraph CLI and Desktop register this package by default; programmatic hosts can import it directly.

## Usage

```ts
import "@flowgraph/node-worktree";
```

Or register explicitly:

```ts
import { registerWorktreeNode } from "@flowgraph/node-worktree";

registerWorktreeNode();
```
