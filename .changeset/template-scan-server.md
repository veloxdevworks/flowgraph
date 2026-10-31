---
"@flowgraph/server": patch
---

Upload checks for untrusted graphs run in linear time: `secret.*` references are found with `templateRefs` from `@flowgraph/core`, and `${NAME}` / `${NAME:-default}` placeholders with a scanner instead of regular expressions that took quadratic time on strings such as `"{{ ".repeat(n)` or `"${a:-".repeat(n)` (a 240 KB prompt took 13 s to check). A `secret` read is now also found after a single `}` inside a block (`{{ a } secret.KEY }}`), which the old pattern stopped at.
