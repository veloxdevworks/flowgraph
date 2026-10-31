---
"@flowgraph/core": patch
---

The node policy's reserved-channel check on `{{ }}` templates, and memory recall's scan for `memory.<id>` references, find template blocks with `scanTemplate` from `@flowgraph/expr` instead of a regular expression that took quadratic time on many unclosed `{{`. New export `templateRefs(text)` scans a string once and reports whether its blocks read a `__` channel or a `secret`; a string with more than 1000 blocks that contain both brackets and quotes counts as reading a `__` channel instead of being parsed block by block.
