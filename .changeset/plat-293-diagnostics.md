---
"@flowgraph/core": minor
"@flowgraph/spec": minor
"@flowgraph/server": minor
"@flowgraph/cli": patch
---

Return 400 for malformed JSON bodies, expose failed-run details after
restart, and reject unsupported uploaded imports explicitly. Attribute agent
front-matter and reducer errors to their source/channel, include useful shell
stderr tails and node ids, and hide private replay attachments from public
interrupt payloads. Correct executable documentation examples and stale build
instructions, and support provider-neutral inspection of runtime and JSON-serialized messages.
