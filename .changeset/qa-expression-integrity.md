---
"@flowgraph/expr": patch
"@flowgraph/core": patch
"@flowgraph/cli": patch
---

Render every template span, honor numeric subtraction, reject trailing expression input, and restrict expression property and builtin lookup to own properties. Preserve quoted delimiters and object literals without walking JavaScript prototypes.

Inherited properties/getters are no longer reachable; materialize needed values as own data properties. Unsupported numeric forms such as scientific/hexadecimal literals now raise parse errors rather than silently evaluating their prefix. See docs/05-state-and-data.md for subtraction and ambiguous numeric-suffix key syntax.
