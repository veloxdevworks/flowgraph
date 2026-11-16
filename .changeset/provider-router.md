---
"@flowgraph/spec": minor
"@flowgraph/core": minor
---

The LangChain provider applies a node `model` override and `with.maxTokens` to the chat model by building a new instance of its class with those fields, so `ChatOpenAI`, `ChatAnthropic` and other LangChain chat models send them, including with tools and structured output. A router with `mode: model` and `match: allMatches` is rejected at validation. Provider `validate()` runs at compile and during `flowgraph validate`, so unsupported options (such as LangChain builtin tools, or a model id not in the provider's known list) produce diagnostics instead of being ignored. Compile warnings are logged, listed on `compiled.diagnostics`, and reported in each run result's `issues`.
