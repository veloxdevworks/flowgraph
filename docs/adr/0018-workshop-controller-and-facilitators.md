# ADR-0018 — Workshop controller, text facilitator, and dictation

- **Status:** Accepted
- **Date:** 2026-11-05
- **Amends:** [0016-workshop-node.md](./0016-workshop-node.md)

## Context

ADR-0016 fixed the engine contract for the `workshop` node (one interrupt out, one
resume back) and made facilitation the client's job. The engine half shipped. The
client half did not: `@flowgraph/workshop-session` offered a realtime voice socket and
four tool handlers, but no client used it, and each client would have had to rebuild
the same pieces itself: the draft, agenda coverage, the transcript, limits, the resume
value, and a way to survive a crash. There was no text facilitator (so nothing could
be tested in CI except by pasting the final JSON), and no way to speak without the
full realtime voice stack.

## Decision

1. **`WorkshopController` owns session state, in `@flowgraph/workshop-session`.** It
   holds `draft`, `coverage`, `transcript`, `endedReason`, turn count and timestamps.
   It applies facilitator tool calls, validates with the shared spec rules
   (`checkWorkshopOutput`, `uncoveredAgendaItems`), builds the system prompt, and
   produces the resume value (`toResume()`). It is plain TypeScript with no I/O, so it
   runs in a browser, a Node sidecar, the CLI, or a server. Snapshots
   (`snapshot()` / `WorkshopController.restore()`) are JSON and versioned, so a host
   can save them and pick a session back up after a crash or reconnect.
2. **Facilitators are ways of driving the controller.** Text (`TextFacilitator` + a
   `FacilitatorModel`), realtime voice (`WorkshopSession`), and a form (the UI edits
   the draft directly via `controller.setField`) all end in the same `toResume()`.
3. **Model and speech access go through small interfaces.** `FacilitatorModel` (one
   chat turn with tools) and `Transcriber` (audio in, text out) are the only things a
   host must supply. The package ships fetch-based adapters for OpenAI-compatible
   chat/transcription endpoints (OpenAI, xAI, and others via `baseUrl`) and the
   Anthropic Messages API. Adapters need a `model` argument; the package does not pick
   one. API keys stay wherever the adapter runs (sidecar / server / CLI), never in a
   webview.
4. **Dictation is the baseline microphone input.** Any facilitator can take spoken
   input: record a clip in the browser (`@flowgraph/workshop-session/browser`), encode
   it as WAV, send it to a `Transcriber` on the host, and drop the text into the input
   box for the human to check before sending. Realtime voice stays available as a
   richer option, but it is not required to speak.
5. **Tools become schema-aware.** `workshopTools(contract)` returns the tools for a
   given contract:
   - `set_field { path, value }` sets a value at a dot path (`owner.name`, `acceptance`).
   - `update_draft { patch }` deep-merges objects; arrays are replaced.
   - `append_to_list { path, item }` appends to an array field.
   - `cover_agenda_item { id, notes? }` rejects ids that are not on the agenda.
   - `finish { reason }` is refused (session stays open) while the draft fails
     `checkWorkshopOutput`, including `requireCoverage`.
   - `add_risk` is kept as an alias of `append_to_list("risks")`, advertised only when
     the schema has a `risks` array.
   - `read_artifact` stays opt-in.
   Every tool result includes a short status (missing required fields, uncovered
   agenda items) so the model knows what is left.
6. **Isolation.** `@flowgraph/workshop-session` depends only on `@flowgraph/spec`.
   The root entry is environment-neutral; browser-only code (mic capture, playback,
   dictation recorder) is also exported from the `./browser` subpath. Hosts
   (CLI, desktop sidecar, server) wire adapters and storage; they do not reimplement
   session logic. The whole package can move to another repo without touching the
   engine.
7. **Engine options.** `with.requireCoverage` (a `completed` session must cover every
   agenda item) and `with.transcript: keep | omit` (drop the transcript from the node
   result to keep checkpoints small). Both are additive; existing graphs behave as
   before.

## Consequences

- One place to fix session bugs; clients become thin UIs over controller state.
- A scripted fake human plus a fake `FacilitatorModel` can run a workshop end to end
  in CI.
- `maxTurns` becomes enforceable (the controller tells the facilitator to wrap up).
- The voice socket's `session.update` message has not been checked against the current
  OpenAI / xAI realtime APIs; that is follow-up work, isolated in `WorkshopSession`.

## References

- [0016 — workshop node](./0016-workshop-node.md)
- [03 — Node types](../03-node-types.md) §8a
