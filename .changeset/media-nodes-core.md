---
"@flowgraph/core": minor
---

Add generative media nodes (`image`, `video`, `model3d`): a `MediaProvider` interface, a write-ahead job journal so resume and retry re-attach to in-flight jobs instead of resubmitting paid ones, workspace-confined reference inputs, and an artifact store. `langchain` xai/openai provider entries also serve media once a vendor adapter is registered, so credentials are configured once. Add `NodeFactory.ui` and `describeNodeTypes()` so UIs can list plugin node types and render their config.
