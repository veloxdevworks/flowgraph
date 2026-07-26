# ADR-0014 — OSS control-plane client in flowgraph-server

- **Status:** Accepted
- **Date:** 2026-07-25
- **Amends:** [docs/00-vision.md](../00-vision.md) §5 Non-goals

## Context

Velox Platform will host a multi-tenant control plane for governed flow runs (library, authz, history, live fanout). Self-hosted runners must reach that plane without inbound ports on customer networks (Platform ADR-0013: outbound-only).

The engine repo's vision previously stated **"No proprietary cloud control plane (in this repo)"**. Shipping a *second* proprietary runner image that wraps `flowgraph-server` would force two server variants (with/without connect), doubling release and support cost. Industry pattern for self-hosted agents (GitLab Runner, Buildkite Agent, Temporal workers, Tailscale) is an **OSS outbound client** that dials a proprietary control plane.

Operators also need to audit what leaves their network — putting the dial-out client in the OSS server package is a security feature, not a liability.

## Decision

1. Amend the non-goal to: **No proprietary cloud control-plane *server* in this repository.** Hosted multi-tenant control plane remains in Velox Platform.
2. Ship an **optional, config-gated outbound connect client** inside `@veloxdevworks/flowgraph-server` (`packages/server`) that dials Platform over WebSocket when configured.
3. Keep the client **transport-only**: map connect `command` messages onto the existing `RunService`; emit `event.batch` from the engine event bus. No org/authz/library business logic in ai-graph.
4. Pin a **versioned protocol schema** (Platform `@velox/flow-protocol` or published conformance package) so engine releases do not couple to Platform feature cadence.
5. Default remains local/direct REST+SSE; connect is off unless explicitly configured.

## Consequences

- One server image serves direct desktop use and Platform-connected deployments.
- Vision non-goal wording must be updated in the same change as this ADR.
- Protocol breakage requires coordinated version negotiation (`hello` / `hello.ack`).
- Platform owns enrollment, OAuth credentials, fanout, and governance.

## Alternatives considered

| Option | Why not |
|---|---|
| Separate proprietary `@veloxdevworks/flowgraph-connect` image | Two images to ship; same binary surface as config-gated module |
| Platform dials runner | Inbound ports / NAT; weaker security posture |
| No cloud connect in OSS | Forces proprietary fork; harder for operators to audit |

## References

- Platform ADR-0013 (outbound-only runner connectivity)
- Platform `REQ-FGW-*`
- [packages/server/README.md](../../packages/server/README.md)
