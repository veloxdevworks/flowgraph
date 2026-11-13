---
"@flowgraph/core": patch
"@flowgraph/cli": patch
---

Isolate webhook callbacks by thread, node, and interrupt id. Each callback resumes
only its intended gate, preserves waiting siblings, and serializes checkpoint
writes with other callbacks in the same process. State inspection and durable
recovery no longer recreate answered gates from stale interrupt writes.

Generated callback URLs include the interrupt id. Legacy node-only URLs remain
usable when they identify one registration and return 409 when ambiguous. The CLI
prints every pending callback URL and continues listening after partial replies.

A deadline times out only the overdue interrupt(s), from the in-process timer,
from `getState()`, and from a later resume. Sibling gates stay pending and their
webhook routes stay registered; the timer is re-armed for any remaining
deadlines.

`compiled.resume()` and `flowgraph resume --resume` require a map keyed by
interrupt id when several interrupts are pending. A truthy unkeyed value is
refused (`RESUME_MAP_REQUIRED`) so it cannot answer every gate. A falsy unkeyed
value still denies each pending interrupt. Unregistering an in-process webhook
route after an API or CLI resume applies only to the answered interrupt, so a
sibling webhook URL keeps listening.
