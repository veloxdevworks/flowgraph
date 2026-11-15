---
"@flowgraph/spec": minor
"@flowgraph/core": minor
"@flowgraph/server": patch
---

Add first-class agent image inputs for the LangChain adapter. Resolve paths,
Artifacts, data URLs and HTTP images into immutable workspace snapshots; retain
references in history and replay instead of base64. Apply host file/network
policy, format/checksum/size checks and image token estimates before model calls.
Reject adapters without image-input support instead of silently dropping images.
