---
"@flowgraph/core": patch
"@flowgraph/cli": patch
---

Record the execution workspace before checkpointed side effects and reuse it across resume and continue, so a change of calling directory cannot bypass media submission uncertainty or shell replay protection. Refuse explicit workspace changes, require the known original workspace for legacy unbound threads, and resolve CLI recovery and local filesystem tools against the recorded workspace.
