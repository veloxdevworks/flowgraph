# ADR-0016 — `workshop` node: client-owned facilitated HITL

- **Status:** Accepted
- **Date:** 2026-08-27
- **Amends:** [0005-durability-and-hitl.md](./0005-durability-and-hitl.md)

## Context

Long-running graphs (software factories, sales pipelines, support cases) often start from an underspecified human intent. Filling a typed `inputs:` form is too thin; stuffing a multi-turn interview into `hitl` `question` or `ask_human` makes every utterance a checkpoint round-trip (and, in the desktop sidecar, a graph recompile). Voice makes that gap fatal.

We need a first-class primitive that:

1. Pauses the run once with a **session contract** (agenda, output schema, primed context).
2. Lets a client facilitate a natural conversation (voice, text, or a fallback form).
3. Resumes with a schema-validated deliverable plus a transcript.

## Decision

1. Add a **`workshop` node type** and **`InterruptKind: "workshop"`**. Do not add another `hitl` mode — the `with` surface (agenda, facilitator, voice, limits, fallback) is larger than the rest of `hitl` combined and needs its own form, icon, and UI.
2. The node is **one-shot interrupt-and-map**. It does not loop `ctx.interrupt()` per turn. Facilitation is **client-owned** (desktop today; a mobile-friendly web client against `@flowgraph/server` later).
3. The durable commitment is the **payload/resume contract**, so facilitation can later move into a shared host without changing graph YAML:
   - Interrupt: `{ agenda, schema, context, facilitator, voice, artifacts/diff, limits, fallback }`
   - Resume: `{ output, transcript, coverage, endedReason }` — `output` validated against `with.schema`
4. Every facilitator (Grok/OpenAI realtime voice, text chat, schema form, CLI JSON) must satisfy that contract. Headless/CI resume with the output object.
5. **Naming:** `workshop` everywhere (node type, interrupt kind, UI copy). It names an agenda-bearing, bounded event with a deliverable. "Collaborate" is reserved for future multi-user features (sharing, presence, run handoff). Mild adjacency with `worktree` is accepted.

## Consequences

- Desktop owns voice (xAI realtime via ephemeral tokens minted in the sidecar). The engine never sees audio.
- A 30-minute xAI session cap is a client concern (rollover + re-seed), not an engine loop.
- Remote/mobile clients reuse `POST /runs/:id/resume` plus a token-mint endpoint on `@flowgraph/server`.
- Prepare (research) and post-action (write plans, start the factory) stay sibling nodes so stages can be skipped, observed, and swapped.

## Alternatives considered

| Option | Why not |
|---|---|
| `hitl` mode `workshop` | Overloads a cheap one-shot node; UI and `with` schema would dominate hitl |
| Engine-driven per-turn interrupts | Checkpoint + sidecar recompile per utterance; walkie-talkie voice |
| New `ProviderAdapter` for voice | That interface is request/response; realtime audio is a session |
| Type name `consult` / `collab` / `collaborate` | Consult is one-directional; collab/collaborate collide with multi-user collaboration |

## References

- [03 — Node types](../03-node-types.md) §8a
- [07 — Runtime](../07-runtime-and-execution.md) §HITL interrupt kinds
