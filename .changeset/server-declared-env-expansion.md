---
"@flowgraph/server": minor
"@flowgraph/core": minor
---

The server expands `${VAR}` by the same rule as the CLI. It used to replace placeholders in the raw uploaded text, from its whole environment, for every trusted caller, so a placeholder in a node body, prompt or `metadata` was filled too, `$${VAR}` became `$` followed by the value, and the expanded text could be stored. Now the server parses the YAML first and then expands only `config` and `runtime` values, only for names the graph lists under `secrets:`. `$${VAR}` becomes the literal `${VAR}`, and an undeclared name is refused with 400 `INVALID_GRAPH` (`SECRET_UNDECLARED` in `diagnostics`). The graph store, the live session and `GET /runs/:id` keep the YAML as uploaded; values are filled only into the graph built for each run, and they are redacted in events, state and logs as in the CLI. `parseGraphYaml` returns the YAML as given and no longer reads the environment unless `expandEnv: true` is passed. Core exports `expandGraphEnv` and `recordGraphEnvExpansion`, the expansion the CLI loader uses.

**Breaking for `token`-mode servers:** the shared-token principal is an untrusted author by default. Graphs sent with `FLOWGRAPH_AUTH_TOKEN` get the untrusted-upload limits: no `shell`, `script`, `service`, `worktree`, `skill`, `demo`, `mcp` or `port` nodes, no registered `function` nodes, and no `${VAR}` or `{{ secret.* }}`. In `token` mode this also applies to AgentCore `/invocations`, connect commands and in-process `RunService` calls that pass no caller. A new setting, `FLOWGRAPH_TRUST_TOKEN_UPLOADS=1` (`trustTokenUploads` in `ServerConfig`), makes everyone holding the token a trusted author again, and the server logs a warning at startup when it is set. OIDC trust (`FLOWGRAPH_OIDC_TRUSTED_ROLES` / `FLOWGRAPH_OIDC_TRUSTED_TEAMS`) and `none` mode (trusted with `FLOWGRAPH_INSECURE_DEV=1`) are unchanged.

**Migration:**

- On a `token`-mode server or placement worker where everyone holding the token may run host commands and read the server environment, set `FLOWGRAPH_TRUST_TOKEN_UPLOADS=1`, or `trustTokenUploads: true` for an embedded `RunService`. Otherwise move authors who need host nodes to `oidc` with a trusted role or team.
- Add every name a graph reads through `${NAME}` to `secrets:`.
- Move a placeholder from a node body or prompt into `config.vars` and read it with `{{ config.vars.name }}`. Outside `config` and `runtime` the server now leaves `${NAME}` as written.
- If a graph wrote `$${NAME}` to get `$` followed by the value, write `${NAME}` instead. `$${NAME}` now produces the literal `${NAME}`.
