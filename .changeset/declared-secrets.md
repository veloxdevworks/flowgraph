---
"@flowgraph/spec": minor
"@flowgraph/core": minor
"@flowgraph/cli": minor
"@flowgraph/server": minor
"@flowgraph/provider-claude": minor
"@flowgraph/provider-cursor": minor
"@flowgraph/provider-deepagents": patch
---

Graphs declare the host environment variables they read as credentials in a top-level `secrets:` list. `{{ secret.NAME }}` in nodes and `mcpServers`, and a provider's `apiKeyEnv`, read only declared names. `flowgraph validate` and `compileGraph` report `SECRET_UNDECLARED` for a literal name the list does not contain, and a computed name (`secret[state.key]`) fails the node when it is read. A provider with a `baseUrl` and no `apiKeyEnv` must declare the vendor's default key, since that key is sent to the graph's endpoint. An inline or file subgraph has its own list and does not inherit its parent's. `service` nodes now render `{{ secret.X }}` in `with.env` and their other fields, and a `demo` capture that reads an undeclared name fails the node instead of reporting `not_captured`. A declared name the host has not set still renders as an empty string. `createLangChainProviderFromConfig`, `createLangChainChatModelFromConfig`, `createClaudeProviderFromConfig` and `createCursorProviderFromConfig` take a `secrets` option and refuse an undeclared `apiKeyEnv` with `UndeclaredSecretError` (code `SECRET_UNDECLARED`); the CLI and server pass `spec.secrets`. Core exports `SecretsSchema`, `secretReferenceDiagnostics`, `providerSecretDiagnostics`, `secretNamesIn`, `assertSecretDeclared` and `declaredSecretsOf`.

**What to change:** add every name the graph reads to `secrets:`, for example `secrets: [GITHUB_TOKEN]` for `{{ secret.GITHUB_TOKEN }}`, and the `apiKeyEnv` of each provider. For a provider with `baseUrl` and no `apiKeyEnv`, declare the vendor default key (such as `OPENAI_API_KEY`) or set `apiKeyEnv` to a declared name. Code that builds providers from a graph passes `secrets: spec.secrets` to the factory.
