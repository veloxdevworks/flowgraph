---
"@flowgraph/core": minor
"@flowgraph/server": minor
---

Expose compact, durable run activity with parallel current steps, human/external
waiting classification, and stable state timestamps. Resolve graph-declared
metadata labels at start and add authenticated `GET /runs?active=true` listing
without compiling or resuming graphs. Publish terminal stream boundaries after
their durable control status so clients can safely act on completion.
