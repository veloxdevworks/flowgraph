---
"@flowgraph/spec": major
---

The graph spec is strict at every depth, and a node or edge takes one mode at a time.

- Every author-facing object (`metadata`, `runtime` and its sections, every node's `with`, edges, hooks and their `where`, skill front matter, provider configs, triggers) rejects unknown keys, and the error suggests the nearest real key. Maps that hold your own data (state values, `inputs`, `http` headers, env maps) stay open.
- Contradictory or empty modes are errors: `wait` takes exactly one of `deadline`, `until`, `signal` or `webhook`; `mcp` takes `tool` or `resource`; `hitl` `choice` needs `choices`, and `approve` cannot have both `choices` and `schema`; a router in rules mode takes no `input`; an `http` GET takes no `body`; each `memory` op rejects the fields it does not read; an edge takes `to` or `branch`, never both.
- A new top-level `extensions:` map, keyed `<vendor>.<name>`, is the only place for data the spec does not define.
- A new optional `requires.engine` holds a semver range for the engine version.
- `toolInput` must be a valid draft-07 object schema.
- `generateJsonSchema()` takes `{ nodeTypes }` and publishes a `With-<type>` definition per node type, selected by the node's `type`.

**What to change:** run `flowgraph migrate` on your graphs; it removes `branch` from an edge that also has `to` and `timeout` from a `deadline` wait, which older engines ignored. Fix any other key the validator now reports; put data of your own under `extensions:`.
