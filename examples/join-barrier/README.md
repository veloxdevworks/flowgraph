# Join barrier

`short` is two hops from `START` (`START → split → short`). `long` is three (`START → split → mid → long`).

```yaml
- { from: [short, long], to: join }
```

`join` runs once, after both branches finish. Two plain edges, `{ from: short, to: join }` and `{ from: long, to: join }`, would run `join` once for each arrival.

`flowgraph validate` warns with `UNEVEN_FAN_IN` when a node has several plain inbound edges from branches of uneven length. A barrier cannot list a source that is only reachable through a conditional branch.
