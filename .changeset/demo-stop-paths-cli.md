---
"@flowgraph/cli": minor
---

Ctrl-C and SIGTERM during `flowgraph run` and `flowgraph resume` now cancel the run, so nodes stop what they started, and it exits with code 130. A second one exits at once.
