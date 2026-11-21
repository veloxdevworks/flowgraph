---
"@flowgraph/server": minor
"@flowgraph/core": patch
---

The server expands `${VAR}` in uploaded graphs by the same rule as `loadGraph`. It used to replace every placeholder across the raw YAML text from its whole environment before parsing, so placeholders in node bodies, prompts and `metadata` were filled and `$${X}` became `$` followed by the value. A trusted author's upload is now parsed first, then expanded only in `config` and `runtime` (each inline subgraph's against its own list) and only for names the graph lists under `secrets:`. Any other name in `config` or `runtime` is refused as `SECRET_UNDECLARED`, placeholders elsewhere stay literal, and `$${X}` stays the literal `${X}`. The graph store, the session and `GET /runs/:id` keep the YAML as uploaded, and `parseGraphYaml` returns that text whenever it expanded anything. `@flowgraph/core` exports `expandGraphEnv` and `recordGraphEnvExpansion` for hosts that parse YAML themselves.

**Breaking for `token` mode:** callers holding `FLOWGRAPH_AUTH_TOKEN` are now untrusted authors by default, so their uploads get the untrusted upload policy (no `shell`, `script` or `service` nodes, no `${VAR}` or `secret.*`, public-only `http` and `webhook`). Set `FLOWGRAPH_TRUST_TOKEN_CALLERS=1` (`trustTokenCallers: true` in `ServerConfig`) to make them trusted again; the server logs a warning at startup when it is on. OIDC trust (trusted roles and teams) and `none` mode are unchanged. An embedded `RunService` whose config sets neither `auth` nor `authToken` stays trusted for its own in-process calls.

**Migration:**
- A `token`-mode server (including a placement worker reached with a shared token) that runs uploads with `shell`, `script` or `service` nodes: set `FLOWGRAPH_TRUST_TOKEN_CALLERS=1` if every token holder may run host commands on it, or move those authors to `oidc` with a trusted role or team. Stored graphs that use those nodes are refused on their next run until you do.
- A graph that relied on the server filling `${VAR}` outside `config` / `runtime`: move the value into `config.vars` (with the name under `secrets:`), run input, or `{{ secret.NAME }}`.
- A graph whose `config` / `runtime` uses an undeclared `${VAR}`: add the name to `secrets:`.
