---
"@flowgraph/server": patch
---

The server image starts again: it runs from `/app/packages/server`, where pnpm's workspace links resolve `@flowgraph/*` and the vendor SDKs (`NODE_PATH` does not apply to ES module imports, so `/app/dist/bin.js` could not find `@flowgraph/core`). The vendor SDK install no longer ignores failures, and the Terraform ECS task sets `FLOWGRAPH_AUTH_MODE=token`, which a durable server with one shared token needs to start.
