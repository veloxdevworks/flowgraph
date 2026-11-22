---
"@flowgraph/core": minor
"@flowgraph/server": minor
"@flowgraph/skills": minor
"@flowgraph/media": minor
"@flowgraph/node-service": minor
"@flowgraph/node-worktree": minor
"@flowgraph/node-demo": minor
"@flowgraph/node-port": minor
"@flowgraph/node-workshop": minor
"@flowgraph/tools-fs": minor
"@flowgraph/cli": minor
---

Node packages use the strict schema helpers, and the engine enforces the new contracts.

- Config schemas in the node packages, skill front matter and `AGENT.md` front matter reject unknown keys with a suggestion. `service` start-only fields are refused on stop and status, and `worktree` fields follow the action.
- `requires.engine` is checked when a graph is validated or compiled (`ENGINE_VERSION_UNMET`).
- A node called as an agent tool checks the model's arguments against its `toolInput` before it runs. A mismatch comes back to the model as a `TOOL_INPUT_INVALID` tool error.
- A programmatic edge with both `to` and `branch` is reported instead of losing the `branch`.
- `requireSafeNodeTypes` now also blocks `imports`, so an imported plugin cannot mark itself `hostAccess: false`.
- The server runs the untrusted provider checks before a dry run, so `kind: plugin` answers 403 `PROVIDER_PLUGIN_BLOCKED`, and `PROVIDER_PLUGIN_NOT_FOUND` answers 400.
- `flowgraph schema` includes each registered node type's `with` definition, and `flowgraph migrate` drops `branch` beside `to` and `timeout` beside a `deadline` wait.

**What to change:** nothing for graphs that already validate. Keys the old schema stripped silently (for example `provider` inside a media node's `with`, or `required` on a skill env var) are now errors; move or remove them.
