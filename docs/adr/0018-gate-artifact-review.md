# ADR-0018 — Reviewing generated assets at human gates

- **Status:** Accepted
- **Date:** 2026-11-05
- **Amends:** [0017-generative-media-nodes-and-plugin-manifest.md](./0017-generative-media-nodes-and-plugin-manifest.md), [0005-durability-and-hitl.md](./0005-durability-and-hitl.md)

## Context

ADR-0017 made images, video and 3D assets first-class `Artifact`s. A human now needs to look at them and choose before the run spends more money, and to ask for another try. Three gaps stopped that:

1. `hitl` `with.artifacts` was `string[]` rendered with `String()`, so a sole-expression template such as `{{ state.outputs.concept.artifact }}` became `"[object Object]"`. It was also read in `mode: review` only.
2. There was no way to answer "this one". A client could only approve or reject the whole set.
3. Looping back to a media node with the same request re-attached to the finished journal entry (`reused: true`), so "regenerate" made no new vendor call. `seed` is a number and cannot be templated into a new fingerprint.

## Decision

- **`with.artifacts`** (approve, choice, review) renders each template, flattens Artifacts, media outputs, paths and arrays, normalises and de-duplicates by path. The interrupt payload carries `artifacts: Artifact[]` (full records, workspace-confined after symlink resolution), `artifactRefs: string[]` (compatibility) and `select`. No bytes.
- **`with.select: none | one | many`** adds `selected` to the resume value. It is validated against the records presented at that gate; anything else is an invalid answer and re-prompts through `interruptUntilValid`. The node output carries the matched records, never the client's objects. Required on approving outcomes and any `choice` answer; auto-selected for `one` when a single artifact was shown.
- **`round`** on every gate output: 1 for the first accepted answer in a thread, then +1 per later answer. It is derived from the node's own previous `state.outputs.<id>.round` (state as of node start), so it is deterministic when a resumed node re-executes and needs no extra storage.
- **`variant`** on media nodes: a templated string or number that joins the job fingerprint but is not part of `MediaRequest`, so vendors never see it. It is added to the canonical JSON only when it has a value, so a request without one hashes exactly as before and existing journal entries are still found after an upgrade.
- `workshop` `artifactRefs` use the same flattening.

## Consequences

- Additive within `flowgraph/v1`. Gate outputs gain `round` (and `selected` when asked); code that compares a gate output with `toEqual` must allow it.
- A gate loop that regenerates needs a `variant` that changes per pass, typically `{{ state.<channel>.round }}`. Pointing `output.to` at a channel is the way to read it, since a channel cannot share a node's id.
- `output: none` on a gate disables `round` (always 1) because nothing is stored to read back.
- State merges `state.outputs.<id>` deeply, so an unchosen `selected` is written as `null` / `[]` rather than omitted, to avoid a previous round's pick surviving. Two selected Artifact records from successive rounds are also deep-merged by the `outputs` reducer; read `selected` from an `output.to` channel (replaced wholesale) when exact records matter.
- Artifact paths that are outside the workspace or missing stay plain refs; they are not previewable but do not fail the run.

## Alternatives considered

| Option | Why not |
|---|---|
| Put `variant` on `MediaRequest` | Vendors would receive it, and it would change every fingerprint |
| Always write `variant: null` in the fingerprint | Changes every existing hash; resumed runs would resubmit paid jobs |
| A per-node counter channel for `round` | Extra state to keep in sync; the previous output already holds it |
| Trust `selected` from the client | Lets a client inject an arbitrary path into later nodes |
