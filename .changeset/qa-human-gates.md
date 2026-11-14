---
"@flowgraph/core": minor
"@flowgraph/cli": patch
---

Require explicit human answers in the CLI and prevent continue/step from approving human gates. Reject historical checkpoints that already contain a resume decision. Validate ask_human choices with re-prompts and one-based indices. Preserve each wait deadline across sibling resumes/restarts while resetting it on a new loop round. Emit one run-level stop event containing all pending gates, with newInterruptIds for notification deduplication. Permit a remaining sibling to resume at the current head checkpoint; exhausted validation ends with run.error.
