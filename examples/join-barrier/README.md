# Join barrier

`short` is two hops from `START` (`START → split → short`). `long` is three (`START → split → mid → long`).

```yaml
- { from: [short, long], to: join }
```

`join` runs once, after both branches finish. Two plain edges, `{ from: short, to: join }` and `{ from: long, to: join }`, would run `join` once for each arrival.

`flowgraph validate` warns with `UNEVEN_FAN_IN` when a node has several plain inbound edges from branches of uneven length. A barrier cannot list a source that is only reachable through a conditional branch, a router, or a `hitl` node that declares routes. A listed source also cannot have a recovery route: a failure would still release the join, at the same time as that route. A recovery route on an earlier node is different. If that node fails before a barrier source is reached, the join does not run, and the run still completes when the recovery route finishes.

A loop that runs only some of the listed sources again does not run `join` a second time. The join runs again only after every listed source has finished again.
