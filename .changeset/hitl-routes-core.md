---
"@flowgraph/core": minor
---

`hitl` nodes can route on the human's answer with `with.routes`, so an `approve`, `choice` or `review` gate no longer needs a `router` after it. Keys are the outcomes (`approved` / `rejected`, each choice, each review decision), values are node ids (or `{ to, description }`), and `default` catches the rest. The answer is still written to `output`; the decision is emitted as `router.decision` (`mode: "hitl"`). Graph lint adds `HITL_ROUTE_MISSING`, `HITL_ROUTES_MODE`, `HITL_ROUTE_UNKNOWN_TARGET`, `HITL_ROUTE_UNKNOWN_OUTCOME`, `HITL_ROUTES_NO_DEFAULT` and `HITL_ROUTES_EDGE_IGNORED`, and reachability lint now follows `with.routes` of routers and gates as well as edges. New exports: `hitlRouteDiagnostics`, `hitlOutcomes`, `hitlOutcomeKey`, `hitlRouteTargets`, `normalizeHitlRoutes`, `resolveHitlRoute`.
