---
"@flowgraph/core": minor
"@flowgraph/spec": minor
---

Map bodies and subgraphs are validated before a run starts. `validateSpec`, `loadGraph` and `flowgraph validate` run the same structural checks on a map's `with.node`, on an inline subgraph `spec`, and on each `uses:` subgraph file, with node type aliases normalised the same way. Nested diagnostics carry the path from the top-level graph (`nodes.each.with.node.with.command`, `nodes.child.spec.edges[0].to`); a file's diagnostics carry that file. A nested graph gets the same lints as the top level, with the same severity. `compileGraph` runs the structural checks at every depth and throws on any error instead of failing at run time; the other lints stay validate-time at every level.

Graphs and map bodies may nest up to 32 levels. A deeper spec, or a programmatic spec whose inline `spec` or map body contains itself, gets one `GRAPH_NESTING_TOO_DEEP` error from `validateSpec` and `compileGraph` instead of a `RangeError`. A programmatic spec that reuses inline `spec` objects may expand to at most 10,000 nodes, counting each nested graph and map body at every place it is used; past that it gets one `GRAPH_TOO_LARGE` error instead of taking exponential time.

Also checked now:

- An edge that starts at `END` (`EDGE_FROM_END`), an edge that ends at `START` (`EDGE_TO_START`), and a router or hitl route to `START` (`ROUTE_TO_START`) are errors in validate and compile.
- Graph `inputs` (validate only): keys are unique (`DUPLICATE_INPUT_KEY`), a `select` field lists `options` (`INPUT_OPTIONS_MISSING`), and a `default` matches the field type (`INPUT_DEFAULT_TYPE`; a `select` default is one of the options, a `json` string default parses).
- `triggers` (validate only): ids are unique (`DUPLICATE_TRIGGER_ID`), `schedule` is a cron expression (`TRIGGER_CRON_INVALID`), and `timezone` is an IANA name (`TRIGGER_TIMEZONE_INVALID`). A schedule has five fields or six with leading seconds, or is one of `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily` and `@hourly`. A time zone is `UTC`, `GMT`, or an `Area/Location` name in IANA's letter case, such as `Asia/Kolkata`, `Etc/UTC` or `Etc/GMT+5`. `GMT` is the same zone as `Etc/GMT`. Abbreviations such as `EST`, offsets such as `+05:00`, and other spellings such as `america/denver` or `Asia/KOLKATA` are rejected.

`UNDECLARED_OUTPUT_CHANNEL` is now a warning: compile already declares the channel as `type: any` with last-write-wins, so the write is kept. `script` `with.code` is no longer template-linted outside map bodies, so JSX such as `style={{ color: "red" }}` validates.

The published JSON Schema has `$id` `https://veloxdevworks.com/flowgraph/schema/v1.json` and refers to its root `GraphSpec` definition through `allOf`, so draft-07 tools keep `$id` and `title`. It defines `NodeSpec`, `MapBodyNode` and `GraphSpec` as recursive definitions used by nodes, inline subgraph `spec` and map bodies, compiles without a recursive-reference warning and under Ajv strict mode (with `allowUnionTypes`), and no longer lists fields that moved elsewhere and are rejected with a pointer to their new place (for example `config.defaults.retry` and `config.defaults.timeout`). `MapBodyNodeSchema` is exported from `@flowgraph/spec`.

**What to change:**

- Map bodies are full node specs with an optional `id`. Fix any unknown key, missing `type`, or `with` that does not match the body type (for example a `shell` body without `command`); these now fail validation and compile. A programmatic inline subgraph `spec` inside a map body needs `apiVersion: flowgraph/v1` and `kind: Graph`, like any other inline spec.
- `compileGraph` throws `Invalid graph: <CODE> at <path>: <message>; ...` for structural errors. The error's `code` is the first diagnostic's code and `diagnostics` lists them all. Code that matched the old `Node "<id>" config error` message should match the code or the new message.
- Remove edges from `END` or into `START`.
- A router or hitl route to `START` never compiled: LangGraph failed with an error that had no code. It now gets a coded `ROUTE_TO_START` diagnostic from validate and compile. Point the route at the first node instead.
- For `flowgraph validate`: give each `select` input `options`, make input keys unique, and make each `default` match its type. Give triggers unique ids, and spell each time zone as an IANA name, such as `America/New_York` instead of `EST`. These do not affect `compileGraph`.
- Flatten programmatic specs that nest graphs or map bodies more than 32 levels deep, or that expand past 10,000 nodes by reusing inline specs.
- `flowgraph validate` without `--strict` no longer fails on `UNDECLARED_OUTPUT_CHANNEL`; with `--strict` it still does. Tools that filter diagnostics by severity should expect a warning.
- Tools that read the JSON Schema should follow `$ref` into `definitions` for the root, nodes, map bodies and inline subgraph specs.
