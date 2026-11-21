---
"@flowgraph/spec": minor
"@flowgraph/core": minor
"@flowgraph/expr": minor
"@flowgraph/cli": minor
"@flowgraph/provider-claude": minor
"@flowgraph/provider-cursor": minor
---

Routing, hooks, and timeouts each have one meaning.

**What to change:**

- Router `routes` is an ordered list of `- name:` entries. Give each entry `to`, and for `mode: rules` exactly one of `when` or `default: true`. `mode: model` entries need a `name` and do not take `when`. A map of routes is rejected with that list message, so YAML order is the match order.
- A branch entry needs exactly one of `when` or `default: true`. Fan-out is `to: [a, b]`. A branch or rules router with no match and no default fails with `NO_MATCH`, recorded as a run issue. `on.error: continue` and a `node:error` `continue` hook do not swallow a router `NO_MATCH` or a router `when` that throws, and neither is retried. Validate warns when a branch has no default.
- Guards on branch edges, node `when`, and router rules read `state`, `input`, `config`, and `run`. A string that is exactly one `{{ expr }}` uses that expression; any other string is a bare expression.
- Hook events that do not run are rejected under the name that was written. `node:before` and `agent:beforeToolCall` take `allow`, `deny`, or `interrupt`. `route` on `node:before` and `node:after` was removed. `node:error` takes `retry`, `continue`, `fail`, or `route:<node>`. `continue` swallows an ordinary node error. `fail` fails the node even when `on.error` is `continue`. `on.error: ignore` was removed; use `continue`. `run:*`, `interrupt:*`, and `agent:afterToolCall` take no YAML control verb. `where` accepts only `nodeId`, `nodeType`, `tool`, and `channel`, checked when a programmatic hook is registered.
- `shell` and `script` no longer default to 30 seconds and no longer accept `with.timeout`. With no node `timeout` and no `runtime.timeoutDefault` they are unbounded. A timeout or abort stops the script process group. The same node timeout aborts `http`, `webhook`, `shell`, `script`, `skill`, `mcp`, and `service`. An `mcp` call receives that abort signal. Media no longer accepts `with.timeout`; the node `timeout` or `runtime.timeoutDefault` is the job deadline, and a node timeout leaves the vendor job running for a retry to re-attach.
- Wait `with.duration` is `deadline`. The sleep stays in-process and does not survive a restart. A signal wait completes only when the resume value is the signal name or an object whose `signal` field is that name. A resume that does not name the signal warns and waits again. The stored output is `{ value: <resume> }`. `with.timeout` is still the interrupt deadline.
- `config.defaults.model` applies only when the node uses the default provider, and only after that provider's own model. `config.defaults.model` without `config.defaults.provider` is ignored, and validate warns. A node `model` still wins. `@flowgraph/provider-claude` and `@flowgraph/provider-cursor` follow the same choice.
