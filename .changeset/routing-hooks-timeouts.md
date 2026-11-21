---
"@flowgraph/spec": minor
"@flowgraph/core": minor
"@flowgraph/expr": minor
"@flowgraph/cli": minor
---

Routing, hooks, and timeouts each have one meaning.

**What to change:**

- Router `routes` is an ordered list. Give each entry `to`, and for `mode: rules` exactly one of `when` or `default: true`. `mode: model` entries need a `name` and do not take `when`. A map of routes is rejected, so YAML order is the match order.
- A branch entry needs exactly one of `when` or `default: true`. Fan-out is `to: [a, b]`. A branch or rules router with no match and no default fails with `NO_MATCH`. A router `when` that throws fails the run.
- Guards on branch edges, node `when`, and router rules read `state`, `input`, `config`, and `run`. A string that is exactly one `{{ expr }}` uses that expression; any other string is a bare expression.
- Hook events that do not run are rejected. `node:before` and `agent:beforeToolCall` take `allow`, `deny`, or `interrupt`. `node:error` takes `retry`, `continue`, `fail`, or `route:<node>`. `continue` swallows the error. `fail` fails the node even when `on.error` is `continue`. `ignore` is removed. `where` accepts only `nodeId`, `nodeType`, `tool`, and `channel`.
- `shell` and `script` no longer default to 30 seconds and no longer accept `with.timeout`. Set `timeout` on the node. The same node timeout aborts `http`, `webhook`, `shell`, `script`, `skill`, `mcp`, and `service`. Media no longer accepts `with.timeout`; a node timeout leaves the vendor job running for a retry to re-attach.
- Wait `with.duration` is `deadline`. The sleep stays in-process and does not survive a restart. A signal wait completes only when the resume value is the signal name or an object whose `signal` field is that name. `with.timeout` is still the interrupt deadline.
- `config.defaults.model` applies only when the node uses the default provider, and only after that provider's own model. A node `model` still wins.
