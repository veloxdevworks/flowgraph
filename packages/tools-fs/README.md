# @flowgraph/tools-fs

> **Preview:** This package is a preview product extension for FlowGraph and is versioned independently from `@flowgraph/core` and `@flowgraph/spec`.

Provides sandboxed local filesystem tools (`fs_read`, `fs_list`, `fs_write`, `fs_edit`, `fs_delete`) and registers the top-level `localTools` graph specification schema (`@flowgraph/spec` extension).

## Usage

Importing `@flowgraph/tools-fs` registers the `localTools` schema extension automatically. The FlowGraph CLI registers this package by default.

```ts
import { registerFsTools } from "@flowgraph/tools-fs";
```
