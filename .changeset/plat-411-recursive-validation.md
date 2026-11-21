---
"@flowgraph/core": minor
"@flowgraph/spec": minor
---

Map bodies and subgraphs are validated before a run starts. `validateSpec`, `loadGraph` and `flowgraph validate` run the same structural checks on a map's `with.node`, on an inline subgraph `spec`, and on each `uses:` subgraph file, with node type aliases normalised the same way. Nested diagnostics carry the path from the top-level graph (`nodes.each.with.node.with.command`, `nodes.child.spec.edges[0].to`); a file's diagnostics carry that file. `compileGraph` runs these checks too and throws on any error instead of failing at run time.

Also checked now:

- An edge that starts at `END` (`EDGE_FROM_END`) or ends at `START` (`EDGE_TO_START`) is an error.
- Graph `inputs`: keys are unique (`DUPLICATE_INPUT_KEY`), a `select` field lists `options` (`INPUT_OPTIONS_MISSING`), and a `default` matches the field type (`INPUT_DEFAULT_TYPE`; a `select` default is one of the options, a `json` string default parses).
- `triggers`: ids are unique (`DUPLICATE_TRIGGER_ID`), `schedule` is a five-field cron expression (`TRIGGER_CRON_INVALID`), and `timezone` is an IANA name (`TRIGGER_TIMEZONE_INVALID`).

`UNDECLARED_OUTPUT_CHANNEL` is now a warning: compile already declares the channel as `type: any` with last-write-wins, so the write is kept. `script` `with.code` is no longer template-linted outside map bodies, so JSX such as `style={{ color: "red" }}` validates.

The published JSON Schema has `$id` `https://veloxdevworks.com/flowgraph/schema/v1.json`, defines `NodeSpec`, `MapBodyNode` and `GraphSpec` as recursive definitions used by nodes, inline subgraph `spec` and map bodies, compiles without a recursive-reference warning, and no longer lists fields that moved elsewhere and are rejected with a pointer to their new place (for example `config.defaults.retry` and `config.defaults.timeout`). `MapBodyNodeSchema` is exported from `@flowgraph/spec`.

**What to change:**

- Map bodies are full node specs with an optional `id`. Fix any unknown key, missing `type`, or `with` that does not match the body type (for example a `shell` body without `command`); these now fail validation and compile. A programmatic inline subgraph `spec` inside a map body needs `apiVersion: flowgraph/v1` and `kind: Graph`, like any other inline spec.
- `compileGraph` throws `Invalid graph: <CODE> at <path>: <message>; ...` for structural errors. The error's `code` is the first diagnostic's code and `diagnostics` lists them all. Code that matched the old `Node "<id>" config error` message should match the code or the new message.
- Remove edges from `END` or into `START`.
- Give each `select` input `options`, make input keys unique, and make each `default` match its type.
- Give triggers unique ids. Replace macros such as `@daily` or six-field (seconds) cron expressions with five-field expressions, and use an IANA time zone such as `Europe/London`.
- `flowgraph validate` without `--strict` no longer fails on `UNDECLARED_OUTPUT_CHANNEL`; with `--strict` it still does. Tools that filter diagnostics by severity should expect a warning.
- Tools that read the JSON Schema should follow `$ref` into `definitions` for nodes, map bodies and inline subgraph specs.
