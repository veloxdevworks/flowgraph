---
"@flowgraph/core": patch
---

Validate inbound webhook payloads before claiming a route or persisting a resume.
Missing required fields and invalid primitive property types return HTTP 422 while
leaving the run interrupted, preserving its route, waiter, and timeout so a
corrected callback can complete, including after reloading a durable checkpoint.
Webhook waits now use the same required-field and property-type checks as HITL.
