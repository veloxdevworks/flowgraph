---
"@flowgraph/core": patch
---

Preserve approved host capabilities in in-process subgraphs. Nested deterministic
MCP tool/resource calls and agent MCP tools now borrow the parent's exposed hub,
while host node/tool policy hooks and host `runConfig.vars/defaults` overrides
propagate through embedded levels. Keep root run/interrupt lifecycle, child YAML
configuration, aliases, paths, channels and existing checkpoint/replay identity
separate; policies cannot restore a withheld hub. Hosts re-supply live capabilities
on recompilation/resume. Remote worker capability handling is unchanged.
Plain host-variable records and arrays are copied into an owned snapshot and
separately for each child, preventing nested data changes from leaking into parents,
siblings or caller-owned options. Opaque host values retain their existing identity
without imposing a new serialization requirement on root graphs.
