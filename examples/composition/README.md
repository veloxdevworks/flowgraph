# composition

Demonstrates **`map` + `subgraph`** composition: fan out over an array, square each element via an embedded subgraph, then sum the results.

```
START → square-each (map → subgraph) → sum-squares (code) → END
```

## Run tests

```bash
cd examples/composition
pnpm test
```

Tests load `register.ts` (registers `square` and `sumList`), then run `sum-of-squares.graph.yaml` in memory via `@veloxdevworks/flowgraph-testing`.

## Graph structure

**Parent graph** (`sum-of-squares.graph.yaml`):

- Imports `./square.graph.yaml` as subgraph `square`
- `map` node iterates `state.numbers`, invokes the subgraph for each item
- `function` node `sumList` aggregates `state.squares`

**Child subgraph** (`square.graph.yaml`):

- Single `function` node squaring input `n` → output `squared`

## Example result

Input `{ numbers: [1, 2, 3, 4] }`:

- `squares`: `[1, 4, 9, 16]`
- `total`: `30`

## Inspect

```bash
flowgraph validate sum-of-squares.graph.yaml
flowgraph graph sum-of-squares.graph.yaml --format mermaid
```

## Known limitation

Nested subgraph HITL (interrupts inside a child subgraph) is **not yet supported**. Keep approval gates in the parent graph.

See [03 — Node types §map/subgraph](../docs/03-node-types.md) and [IMPLEMENTATION_STATUS.md](../docs/IMPLEMENTATION_STATUS.md).
