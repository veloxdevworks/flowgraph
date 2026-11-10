---
"@flowgraph/core": minor
"@flowgraph/cli": minor
---

Nodes with `runsOn` now run on other machines. `compileGraph` takes `placement: { localLabels, topology, transport, loadChild }`: a node the local host can run stays in-process, otherwise it is dispatched to the first matching worker that passes preflight, and a node nothing can run fails at compile with `PlacementUnsatisfiedError`. A placed `subgraph` is seeded and merged exactly as in-process; any other node runs as a one-node graph and its result goes through its own `output` mapping. The child run is named `{threadId}/{nodeId}/{attempt}`, recorded with `ctx.once`, and re-attached rather than re-sent. Its events appear nested under the node with `scope.placement`. Failures surface as `REMOTE_NODE_FAILED`, `REMOTE_NODE_CANCELLED`, `PLACEMENT_GATE_UNSUPPORTED` and `PLACEMENT_THREAD_ID_TOO_LONG`; aborting the run or a node timeout cancels the child. `CompiledGraph.placements` reports each decision. `flowgraph validate` warns `PLACEMENT_GATE_PHASE2` when a placed subgraph contains a gate.

`flowgraph run --targets <file>` loads a topology, prints `placement: <node> → <target> (labels)` for each placed node, and exits `2` with the `PLACEMENT_UNSATISFIED` message when a node cannot be placed.

Phase 1 limits: no gate forwarding, no `runsOn.wait`, no artifact staging, and `map` / `router` nodes cannot be placed directly.
