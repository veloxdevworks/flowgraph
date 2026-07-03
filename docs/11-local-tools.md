# 11 — Local Tools

Opt-in tool packages extend intelligent nodes with capabilities that need local I/O (filesystem, shell, etc.). They register **function tools** via `@veloxdevworks/flowgraph-core`'s `registerTool()` API so any provider (including LangChain) can invoke them.

## 1. Filesystem tools (`@veloxdevworks/flowgraph-tools-fs`)

Declare in your graph:

```yaml
localTools:
  fs:
    workspaceRoot: "."              # resolved relative to graph cwd
    operations: [read, list, write] # default: [read, list] only
```

The CLI calls `registerFsTools()` on `flowgraph run` / `resume` when `localTools.fs` is present.

### Available tools

| Tool | Operation | Default |
|---|---|---|
| `fs_read` | Read a text file | enabled |
| `fs_list` | List a directory | enabled |
| `fs_write` | Create/overwrite a file | opt-in |
| `fs_edit` | Find/replace in a file | opt-in |
| `fs_delete` | Delete a file | opt-in |

Expose to an intelligent node:

```yaml
with:
  tools:
    - function: fs_read
    - function: fs_write
```

### Sandboxing

All paths must be **relative** to `workspaceRoot`. Absolute paths and `..` traversal are rejected. Symlink escapes are blocked via `realpath` checks. This cannot be disabled.

### Governance (two layers)

**Layer 1 — node `permission` (coarse):**

| Value | Behavior |
|---|---|
| `auto` (default) | Tool calls proceed unless a hook vetoes/interrupts |
| `ask` | Every tool call raises a HITL interrupt |
| `deny` | No tool calls allowed |

**Layer 2 — `runtime.hooks` (fine-grained):**

Gate specific tools (recommended for mutating fs ops):

```yaml
runtime:
  hooks:
    - on: intelligent:beforeToolCall
      where: { tool: fs_write }
      do: interrupt
      reason: "Approve filesystem write"
```

The CLI warns at startup if mutating `operations` are enabled without matching hooks or `permission: ask` on an intelligent node.

### Example

See [examples/fs-agent](../examples/fs-agent/).

### Provider-native file tools

When using `provider: claude`, prefer Claude Agent SDK builtin tools (`Read`, `Edit`, `Bash`, …). They are gated by the same `permission` / `runtime.hooks` model via the SDK's `canUseTool` callback mapped to flowgraph governance — no need for `@veloxdevworks/flowgraph-tools-fs` unless you want a provider-agnostic sandbox.

For `provider: cursor`, use `@veloxdevworks/flowgraph-tools-fs` function tools (`fs_read`, `fs_write`, …) when you need per-call HITL on file operations; Cursor native builtins cannot be gated per-call.

For `provider: langchain` (no native file tools), `@veloxdevworks/flowgraph-tools-fs` is the supported path.

## 2. Programmatic registration

For embedded / test runners, call `registerFsTools` directly:

```ts
import { registerFsTools } from "@veloxdevworks/flowgraph-tools-fs";

registerFsTools({
  workspaceRoot: "/path/to/project",
  operations: ["read", "list", "write"],
});
```

Then compile/run the graph as usual.
