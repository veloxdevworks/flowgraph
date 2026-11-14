---
"@flowgraph/core": minor
---

Make report_issue an explicit tools opt-in. Enforce agent JSON Schema output, including nested data, with and without tools; use native structured finalization when available. Return recoverable tool-handler failures to the model while preserving interrupts, permission denial and non-retryable failures. Fail step exhaustion with AGENT_MAX_STEPS and partialOutput. Close the generated model-router schema, disable hidden SDK retries in configured LangChain models, and fail MCP calls whose result has isError.
