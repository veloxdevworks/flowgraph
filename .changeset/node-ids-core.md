---
"@flowgraph/core": patch
---

`compileGraph` refuses node ids that contain `,`, `:` or a control character, or end in `[<number>]` (the id the engine gives a map item, such as `m[0]`), with an error naming the id. Specs loaded from YAML already allowed only letters, digits, `_` and `-`; this covers graphs built in code, whose ids end up in replay keys and checkpoint namespaces.
