---
"@flowgraph/core": patch
"@flowgraph/cli": patch
"@flowgraph/server": patch
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

The server's resume endpoints validate the same rule before the run starts and
return 400 `RESUME_MAP_REQUIRED`, leaving the thread interrupted. A map with a
key that is not a pending interrupt id is refused with that code, and the error
names the unknown or extra id(s).

`onInterrupt: "approve"` and `continueRun()` pass a map of `true` keyed by each
pending interrupt id, so they approve every waiting gate instead of being
refused. After a deadline, a later `resume()` keeps the caller's answers for
gates that are not overdue and applies the timeout only to the overdue ones.

A refused resume on a thread with no in-process session does not leave a placeholder session.
