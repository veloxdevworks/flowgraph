---
"@flowgraph/server": minor
---

AgentCore fixes. `/invocations` now skips bearer auth in `token` / `none` mode only when `FLOWGRAPH_AGENTCORE=1` is set (the server runs as a Bedrock AgentCore Runtime, which checks SigV4 at the edge). Without it, as behind the ECS ALB, `/invocations` takes the same bearer token as REST; before, anyone who could reach the port could run graphs there as the trusted principal.

An `events` invocation for a thread with no run in this process (on AgentCore, a session landing on a fresh microVM) now ends its stream instead of waiting forever, and a cold-subscribe placeholder no longer counts as active work, so it no longer holds `/ping` at `HealthyBusy` or counts toward `FLOWGRAPH_MAX_CONCURRENT_RUNS`. `start` and `resume` streams replay the events their run emitted before the stream attached, so a run that fails at once still ends its stream. AgentCore streams send a `: ping` comment every 15s.
