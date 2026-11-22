---
"@flowgraph/spec": minor
"@flowgraph/skills": minor
"@flowgraph/core": minor
"@flowgraph/cli": minor
"@flowgraph/server": minor
"@flowgraph/testing": minor
---

Clean up skills, providers, plugins, and pre-v1 aliases.

**Breaking changes and what to update:**

- **Skills (`@flowgraph/skills`, `@flowgraph/core`):**
  - Rename `kind_of` in `SKILL.md` front matter to `kindOf`. Run `flowgraph migrate` to rewrite existing files.
  - Remove unread `SKILL.md` front-matter fields: `sideEffecting`, `permissions`, `provider`, `env.network`, `env.packages`, and `env.bin[].minVersion`.
  - Enforce `timeout` on skill execution (aborts the handler signal / terminates command children and fails with `SKILL_TIMEOUT`).
  - Enforce declared `outputs` schemas on skill return values (fails with `SKILL_OUTPUT_INVALID`).
  - Write rendered JSON input to stdin for `kindOf: command` skills in addition to setting `FLOWGRAPH_INPUT`.
  - Build agent skill-as-tool specs from the skill's `name`, `description`, and `inputs` JSON Schema.
- **Plugins and providers (`@flowgraph/spec`, `@flowgraph/core`, `@flowgraph/cli`, `@flowgraph/server`):**
  - Plugin node types must be namespaced (`<namespace>:<name>`, `<namespace>/<name>`, or `@<scope>/<pkg>:<name>`); unnamespaced plugin types fail with `PLUGIN_TYPE_INVALID`.
  - Colliding with a built-in node type, another plugin node type, a reducer, or an imported provider now fails with a coded error (`PLUGIN_TYPE_COLLISION`, `PLUGIN_REDUCER_COLLISION`, `PLUGIN_PROVIDER_COLLISION`) instead of silently skipping.
  - Imported plugin node types, reducers, and providers are registered in a per-compile registry rather than mutating process-wide registries.
  - Add `kind: plugin` to `ProviderConfigSchema` (`plugin`, `model`, `apiKeyEnv`, `options`) backed by `defineProviderPlugin` / `registerProviderPlugin`; options are validated by the adapter (`PROVIDER_OPTIONS_INVALID`, `PROVIDER_PLUGIN_NOT_FOUND`).
- **Agent and router configuration (`@flowgraph/spec`, `@flowgraph/core`):**
  - Remove ignored agent bags `with.claude`, `with.cursor`, `with.langchain`, `with.deepagents`, and `with.hub`. Configure provider settings on the top-level `providers:` entry instead.
  - Remove `router.with.provider`. Provider and model selection come only from node-level `provider` / `model` plus `config.defaults`.
- **Pre-v1 aliases removed (`@flowgraph/spec`, `@flowgraph/core`, `@flowgraph/cli`, `@flowgraph/server`):**
  - Delete `type: code` (use `function`), `type: intelligent` (use `agent`), `intelligent:beforeToolCall` / `intelligent:afterToolCall` hook event aliases (use `agent:*`), `KindSchema` values `Skill` / `Subgraph` on graph specs (use `Graph`), `runtime.store` (use `runtime.memory`), and `relocatedField` schema placeholders.
  - `flowgraph migrate` continues to rewrite pre-v1 graph and skill files to the current `flowgraph/v1` format.
