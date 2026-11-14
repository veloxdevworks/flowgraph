---
"@flowgraph/core": minor
"@flowgraph/cli": patch
---

Require explicit human answers in the CLI and prevent continue/step from approving human gates. Reject historical checkpoints that already contain a resume decision. Validate ask_human choices with re-prompts and one-based indices. Preserve each wait deadline across sibling resumes/restarts while resetting it on a new loop round. Emit one canonical interrupt event per new gate prompt rather than duplicate or replay notifications.
