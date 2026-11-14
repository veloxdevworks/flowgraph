---
"@flowgraph/core": minor
"@flowgraph/spec": minor
"@flowgraph/checkpoint-sqlite": minor
"@flowgraph/checkpoint-postgres": minor
"@flowgraph/cli": patch
"@flowgraph/provider-deepagents": patch
---

Persist thread usage and paid-call receipts across resumes, meter LangChain calls
before tools/HITL, enforce budgets between model/media calls, and expose cumulative
usage to results, terminal events and graph output mappings. Deduplicate provider
usage, add real model chunk events, report synchronous media completion/cost,
warn about unpriced LangChain USD caps, and keep CLI logs on stderr for pure JSONL.
Add supported receipt inspection/reconciliation, classify unaccepted LangChain
requests as known zero usage, and atomically merge late receipts across processes.
Without hard caps, uncertain outcomes warn and keep visible counts while work continues.
