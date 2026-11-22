---
"@flowgraph/spec": minor
"@flowgraph/core": minor
"@flowgraph/cli": minor
---

Data contracts are enforced where data crosses a boundary: channel writes, run input, node input, map items and subgraph calls.

**Channels.** A channel takes an optional draft-07 `schema:`, checked on every write against the value the channel would hold after its reducer runs. `type` stays as shorthand for a schema with just that type, and `type` and `schema` must agree. A write that fails throws `ChannelWriteError` (code `CHANNEL_WRITE_INVALID`) naming the channel and each failure. `null` is every channel's empty value and always passes. `flowgraph validate` reports a `default` that does not satisfy the contract as `CHANNEL_DEFAULT_TYPE`.

**Inputs.** `inputs` is the one input contract: type, `default`, `required`, `options` and, for `type: json`, a draft-07 `schema`. Presentation hints live apart under `ui` (`label`, `placeholder`, `help`, `widget`). A key the graph declares neither as an input nor as a channel is rejected with `INPUT_INVALID` instead of being dropped with a warning. Values are never coerced, `undefined` is missing, `null` is a value, and each run gets its own copy of a default. The CLI decodes `--input key=value` once, by the declared type (`number`, `boolean`, `json`; `string` and `select` stay as written); values passed through the API are used as they are. `@flowgraph/core` exports `decodeCliInput` and `ChannelWriteError`, and `@flowgraph/spec` exports `inputValueProblem`.

**Node input.** A node's `input` accepts any value (object, string, list, number, `null`), renders templates at every depth, and is the node's one input path. `with.input` is removed from `function`, `script` and `shell`. A node exposed as a tool receives the model's arguments as its input and ignores its own `input`. A node's `input` and `when` render without `secret` in scope, so `flowgraph validate` reports `{{ secret.X }}` there as `SECRET_OUT_OF_SCOPE` (a map body's `input` and `when` included); read secrets in `with`.

**Map.** The item is bound directly as `{{ <as> }}`, and `{{ index }}` is its position. `as` must be an identifier that templates do not already bind. A map's own `with.output` is rejected instead of being silently stripped, and an inner `when` is honoured per item (a skipped item contributes nothing).

**Subgraphs.** A subgraph file declares `inputs` and `outputs`. The values the parent passes are validated against the child's `inputs` at the call (unknown keys are an error), and when the child declares `outputs` only those channels return, each checked against its contract (`SUBGRAPH_OUTPUT_INVALID`). A node that sets both `stateMap.out` and `output` is rejected. `flowgraph validate` adds `SUBGRAPH_INPUT_UNKNOWN`, `SUBGRAPH_INPUT_MISSING` and `SUBGRAPH_OUTPUT_UNKNOWN` (now limited to declared outputs), plus `MAP_ITEM_REF_REMOVED`, `DUPLICATE_OUTPUT_KEY`, `OUTPUT_CHANNEL_UNKNOWN` and `PLACEMENT_INPUT_NOT_OBJECT`.

**What to change:**

- Run `flowgraph migrate <graph> --write`. It rewrites channel `items` / `properties` into `schema`, input `label` into `ui.label`, input `type: text` into `type: string` with `ui: { widget: textarea }`, top-level `input:` into input `default`s, `with.input` into the node's `input`, and map `{{ item.<as> }}` into `{{ <as> }}`. It reports what needs a decision: a node with both `input` and `with.input`, a subgraph with both `stateMap.out` and `output`, and a map `with.output`.
- Channel `items` and `properties` are removed. Describe the contents with `schema`.
- Input `label` moves to `ui.label`, and input `type: text` becomes `type: string` with `ui.widget: textarea`. The top-level `input:` seed is removed: put the value in the matching input's `default` (declare the key under `inputs` if it is not one yet).
- Run input that names an undeclared key now fails. Declare it under `inputs` or `state.channels`. Input that a `run:before` hook replaces is held to the same rule; the `INPUT_UNKNOWN_KEY` warning is gone.
- A typed channel now rejects a write of the wrong type, where it used to store it. Fix the writer, or loosen the channel to `type: any`.
- API callers must pass typed values: the string `"5"` is no longer accepted for a number input, and `null` is no longer treated as missing.
- A node used as a tool can no longer remap the model's arguments with `with.input`. Put the mapping in a wrapper node or let the node read the arguments as they are.
- A subgraph that is passed a key it does not declare as an input or a channel now fails. Declare the input on the child, or stop passing it. A child that declares `outputs` no longer returns any other channel.
