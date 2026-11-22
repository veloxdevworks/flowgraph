---
"@flowgraph/core": patch
---

`validateSpec`, `compileGraph`, and `flowgraph validate` report a coded diagnostic when a nested graph is malformed. A map-body hook with no `do`, or with a `do` that is not a string, a map-body spec with no `edges`, and an inline subgraph hook with no `do` keep the schema message, such as `Required`. A missing or non-string `on` or `do` keeps that schema message. A non-string edge `from` or `to`, a missing or non-string node `id` or `type`, and a non-object `routes` value are reported the same way.
