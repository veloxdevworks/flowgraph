---
"@flowgraph/spec": minor
"@flowgraph/core": minor
---

The LangChain provider forwards a node `model` override and `with.maxTokens` to the chat model. A router with `mode: model` and `match: allMatches` is rejected at validation. Provider `validate()` runs at compile and during `flowgraph validate`, so unsupported options (such as LangChain builtin tools, or a model id not in the provider's known list) produce diagnostics instead of being ignored.
