---
"@flowgraph/core": patch
---

Reject malformed percent-encoded webhook paths with HTTP 400 instead of crashing
the listener process. Claim each pending route atomically after reading the
request body so overlapping POSTs cannot resume the same registration twice, and
delayed requests cannot resume cancelled routes or consume replacement routes.
