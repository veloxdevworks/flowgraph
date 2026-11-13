---
"@flowgraph/spec": minor
"@flowgraph/core": minor
"@flowgraph/cli": minor
---

A router that sits right after a `hitl` gate and only repeats its answer (`state.decision.choice == 'retry'`, `state.approval.approved`, a default for the rest) can be folded into the gate's `with.routes`. Graph lint now recommends it as an `info` diagnostic, `HITL_ROUTER_MERGEABLE` (never fails `--strict`), and `flowgraph validate` prints `info` diagnostics after a successful validation. `@flowgraph/spec` exports the analysis and rewrite so editors can offer the fix: `analyzeRouterMerge`, `findMergeableRouters`, `mergeRouterIntoHitl`, `answerFromCondition`. Core exports `hitlRouterMergeDiagnostics`.
